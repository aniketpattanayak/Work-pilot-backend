// utils/dailyTaskAlert.js
// "Daily Task Reminder" WhatsApp message: every morning each person gets ONE message listing
// their overdue / today / tomorrow delegation tasks and checklist tasks.
//
// Only companies the platform owner switched on (superAdmin.features.dailyTaskAlert === true) get it,
// and the company admin chooses the time and can switch it off (companySettings.dailyAlert).
// One check per minute; a company is claimed atomically once per day, so it is never sent twice.
const moment = require('moment');
const Tenant = require('../models/Tenant');
const Employee = require('../models/Employee');
const DelegationTask = require('../models/DelegationTask');
const ChecklistTask = require('../models/ChecklistTask');
const { calculateNextDate } = require('./scheduler');
const { notifyTenant } = require('./notify');

const TEMPLATE = 'daily_task_alert';
const IST_MS = 330 * 60000;            // India time: every company here works on IST
const LIST_SEP = ' | ';                // WhatsApp template values cannot hold line breaks
const MAX_ITEM = 55;                   // characters per task name
const MAX_SECTION = 320;               // characters per section (a template value must stay short)
const CATCH_UP_MIN = 180;              // if the server was down at the set time, still send up to 3 hours late

const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);               // 'YYYY-MM-DD' in India
const dayStartMs = (day) => Date.parse(day + 'T00:00:00Z') - IST_MS;                    // start of that India day
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const nice = (day) => day;                                                               // shown as 2026-10-23

const clean = (s) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const cut = (s) => { const c = clean(s); return c.length > MAX_ITEM ? c.slice(0, MAX_ITEM - 1) + '…' : c; };

// Join lines with " | " and keep the section short: "… | +3 more"
const fitList = (lines) => {
  if (!lines.length) return 'None';
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const left = lines.length - i;
    const more = ` | +${left} more`;
    const add = (out.length ? LIST_SEP.length : 0) + lines[i].length;
    if (used + add + (left > 1 ? more.length : 0) > MAX_SECTION && out.length) { out.push(`+${left} more`); break; }
    out.push(lines[i]); used += add;
  }
  return out.join(LIST_SEP);
};

const onLeaveToday = (emp, dayMs) => {
  const l = emp && emp.leaveStatus;
  if (!l || l.onLeave !== true) return false;
  if (l.startDate && l.endDate) return dayMs >= new Date(l.startDate).getTime() && dayMs <= new Date(l.endDate).getTime() + 86399999;
  return true;
};

/**
 * What one person has: { overdue: [...], today: [...], tomorrow: [...] } (each line starts with [Del] or [Chk])
 * delegation: tasks still open, by deadline.  checklist: the schedule walked up to tomorrow, skipping days already done.
 */
const collectFor = async (tenant, emp, now = Date.now()) => {
  const today = istDay(now), tomorrow = addDays(today, 1);
  const t0 = dayStartMs(today), t1 = dayStartMs(tomorrow), t2 = dayStartMs(addDays(today, 2));
  const res = { overdue: [], today: [], tomorrow: [] };

  const del = await DelegationTask.find({
    tenantId: tenant._id, doerId: emp._id,
    status: { $in: ['Pending', 'Accepted', 'Revision Requested'] },
    deadline: { $lt: new Date(t2) },
  }).select('title deadline onHold').sort({ deadline: 1 }).lean();
  for (const t of del) {
    if (t.onHold && t.onHold.isOn) continue;                 // the clock is paused
    const ms = new Date(t.deadline).getTime();
    const line = '[Del] ' + cut(t.title);
    if (ms < t0) res.overdue.push(line); else if (ms < t1) res.today.push(line); else res.tomorrow.push(line);
  }

  const holidays = tenant.holidays || [];
  const weekends = (tenant.weekends && tenant.weekends.length ? tenant.weekends : [0]).slice();
  const eff = emp.workOnSunday ? weekends.filter((d) => d !== 0) : weekends;
  const chk = await ChecklistTask.find({ tenantId: tenant._id, doerId: emp._id, status: 'Active' }).select('taskName frequency frequencyConfig nextDueDate history').lean();
  const tmr = moment(today + 'T00:00:00').startOf('day').add(1, 'day');    // server-local day, same as the checklist screen
  const todayM = moment(today + 'T00:00:00').startOf('day');
  for (const c of chk) {
    let ptr = moment(c.nextDueDate).startOf('day');
    let late = 0, hasToday = false, hasTomorrow = false, guard = 0;
    while (ptr.isSameOrBefore(tmr) && guard++ < 400) {
      const key = ptr.format('YYYY-MM-DD');
      const off = holidays.some((h) => moment(h.date).format('YYYY-MM-DD') === key) || eff.includes(ptr.day());
      if (!off) {
        const done = (c.history || []).some((h) => (h.action === 'Completed' || h.action === 'Administrative Completion') && moment(h.instanceDate || h.timestamp).format('YYYY-MM-DD') === key);
        if (!done) { if (ptr.isBefore(todayM)) late++; else if (ptr.isSame(todayM)) hasToday = true; else hasTomorrow = true; }
      }
      const nx = calculateNextDate(c.frequency, c.frequencyConfig || {}, holidays, ptr.toDate(), false, eff);
      if (!nx || moment(nx).startOf('day').isSameOrBefore(ptr)) break;
      ptr = moment(nx).startOf('day');
    }
    const nm = cut(c.taskName);
    if (late) res.overdue.push(`[Chk] ${nm}${late > 1 ? ` (${late >= 400 ? '400+' : late} days pending)` : ''}`);
    if (hasToday) res.today.push(`[Chk] ${nm}`);
    if (hasTomorrow) res.tomorrow.push(`[Chk] ${nm}`);
  }
  return res;
};

// The 7 values of the WhatsApp template (see notificationRegistry: daily_task_alert)
const variablesFor = (tenant, emp, lists, now = Date.now()) => {
  const today = istDay(now), tomorrow = addDays(today, 1);
  return [
    emp.name, fitList(lists.overdue), nice(today), fitList(lists.today), nice(tomorrow), fitList(lists.tomorrow),
    `https://${tenant.subdomain}.lrbcloud.ai/dashboard/my-tasks`,
  ];
};

/** Send to everyone in one company. Returns { sent, skipped }. Persons with nothing pending get no message. */
const sendForTenant = async (tenant, now = Date.now()) => {
  const staff = await Employee.find({ tenantId: tenant._id }).select('name whatsappNumber leaveStatus workOnSunday').lean();
  const dayMs = dayStartMs(istDay(now));
  let sent = 0, skipped = 0;
  for (const emp of staff) {
    try {
      if (!emp.whatsappNumber || onLeaveToday(emp, dayMs)) { skipped++; continue; }
      const lists = await collectFor(tenant, emp, now);
      if (!lists.overdue.length && !lists.today.length && !lists.tomorrow.length) { skipped++; continue; }
      await notifyTenant(tenant._id, emp.whatsappNumber, { templateName: TEMPLATE, variables: variablesFor(tenant, emp, lists, now) });
      sent++;
    } catch (e) { console.error(`[DailyAlert] ${tenant.companyName} / ${emp.name}:`, e.message); skipped++; }
  }
  console.log(`📨 [DailyAlert] ${tenant.companyName}: ${sent} sent, ${skipped} skipped`);
  return { sent, skipped };
};

const minutesOf = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** One minute's check: which companies are due now. */
const tick = async (now = Date.now()) => {
  const tenants = await Tenant.find({ 'superAdmin.features.dailyTaskAlert': true, 'companySettings.dailyAlert.enabled': true })
    .select('companyName subdomain holidays weekends companySettings.dailyAlert').lean();
  const today = istDay(now);
  const nowMin = Math.floor(((now + IST_MS) % 86400000) / 60000);
  for (const t of tenants) {
    const cfg = (t.companySettings && t.companySettings.dailyAlert) || {};
    const at = minutesOf(cfg.time || '08:30');
    if (at === null || nowMin < at || nowMin - at > CATCH_UP_MIN || cfg.lastSentOn === today) continue;
    // claim today's send (safe if two servers run)
    const r = await Tenant.updateOne({ _id: t._id, 'companySettings.dailyAlert.lastSentOn': { $ne: today } }, { $set: { 'companySettings.dailyAlert.lastSentOn': today } });
    if (!r.modifiedCount && !r.nModified) continue;
    sendForTenant(t, now).catch((e) => console.error('[DailyAlert] send failed:', e.message));
  }
};

let timer = null;
const startDailyTaskAlert = () => {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.error('[DailyAlert] tick:', e.message)); }, 60000);
  if (timer.unref) timer.unref();
  console.log('📨 Daily Task Alert check running (every minute; only for companies it is switched on for).');
};

module.exports = { startDailyTaskAlert, tick, sendForTenant, collectFor, variablesFor, fitList, TEMPLATE, minutesOf };
