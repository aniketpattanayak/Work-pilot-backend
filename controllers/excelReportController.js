// controllers/excelReportController.js
// Excel downloads for Manage Delegation, Manage Checklist, My Tasks and Manage Employee.
//
//   GET /api/reports/excel/tasks?scope=delegation|checklist|mytasks
//                              &type=complete|datewise|employeewise|taskwise
//                              &from=YYYY-MM-DD&to=YYYY-MM-DD   (both empty = complete history)
//                              &employeeId=<doer>               (empty = all)
//                              &assignerId=<assigned by>        (empty = all)
//                              &status=Completed|Pending|Overdue (empty = all)
//                              &ids=<record ids>                (only these records: the rows shown in the table / the rows ticked)
//                              &count=1                         (do not build the file, just say how many records it would hold)
//   GET /api/reports/excel/employees?employeeId=<id>&ids=...     (empty = all) - Admin only
//   The same two links also accept POST (JSON text in the body) so a long id list fits.
//   An id is  <taskId>  (the whole task)  or  <checklistId>|<day>  (only that scheduled day of a checklist).
//
// Read-only: nothing in the database is changed. The people and tasks in a report are exactly the ones
// the same person can already see on that page (Manage Delegation: Admin / view-only = whole company, others = tasks they gave or passed on;
// Manage Checklist = whole company, like the page; My Tasks = their own).
const mongoose = require('mongoose');
const moment = require('moment');
const ExcelJS = require('exceljs');
const Tenant = require('../models/Tenant');
const { calculateNextDate } = require('../utils/scheduler');
const { isViewerOnly } = require('../middleware/auth');

const IST = 330 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SHEET_ROWS = 100000;       // rows written to one sheet; the Task Summary says so when it is hit (totals still count everything)
const MAX_ITEMS = 500000;            // safety stop for memory
const MAX_PER_CHECKLIST = 2500;      // safety stop for one checklist's schedule
const FUTURE_DAYS = 30;              // "complete history" also shows the next 30 days of schedule
const DAY = 86400000;

const SCOPES = ['delegation', 'checklist', 'mytasks'];
const STATUSES = ['Completed', 'Pending', 'Overdue'];
const MAX_IDS = 100000;
const TYPES = ['complete', 'datewise', 'employeewise', 'taskwise'];
const SCOPE_LABEL = { delegation: 'Manage Delegation', checklist: 'Manage Checklist', mytasks: 'My Tasks' };
const TYPE_LABEL = { complete: 'Complete Report', datewise: 'Date-wise Report', employeewise: 'Employee-wise Report', taskwise: 'Task-wise Report' };
const SHEETS_FOR = {
  complete: ['Schedule', 'Task Details', 'Checklist Status', 'Work Distribution', 'Employee & Doer Details', 'Task Summary', 'Date-wise Records'],
  datewise: ['Schedule', 'Task Summary', 'Date-wise Records'],
  employeewise: ['Work Distribution', 'Employee & Doer Details', 'Task Summary'],
  taskwise: ['Task Details', 'Checklist Status', 'Task Summary']
};

// ───────────────────────────── small helpers ─────────────────────────────
const model = (req, name, fallback) => {
  if (!req.db) return fallback;
  try { return req.db.model(name); } catch (e) { return fallback; }
};
const idOf = (v) => (v && v._id ? String(v._id) : (v ? String(v) : ''));
const ist = (d) => moment(d).utcOffset(330);
// Excel shows date cells exactly as stored (UTC), so shift to India time before writing
const xlDateTime = (d) => (d ? new Date(new Date(d).getTime() + IST) : null);
const xlDate = (d) => { if (!d) return null; const m = ist(d); return new Date(Date.UTC(m.year(), m.month(), m.date())); };
const xlDayKey = (key) => { if (!key) return null; const [y, mo, da] = key.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, da)); };
const localKey = (d) => moment(d).format('YYYY-MM-DD');   // same "day" meaning the checklist engine uses
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 32000);
const fileDay = (s) => (s ? s : 'all');

function parseRange(q) {
  const from = q.from ? String(q.from) : '';
  const to = q.to ? String(q.to) : '';
  if (!from && !to) return { all: true, start: null, end: null, from: '', to: '' };
  if ((from && !ISO_DAY.test(from)) || (to && !ISO_DAY.test(to))) return { error: 'Please choose valid dates.' };
  const mk = (s, endOfDay) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + (endOfDay ? 1 : 0)) - IST - (endOfDay ? 1 : 0));
  };
  const start = from ? mk(from, false) : null;
  const end = to ? mk(to, true) : null;
  if ((start && isNaN(start.getTime())) || (end && isNaN(end.getTime()))) return { error: 'Please choose valid dates.' };
  if (start && end && end < start) return { error: 'The "to" date cannot be before the "from" date.' };
  return { all: false, start, end, from, to };
}

// The request can come as a query (GET) or as JSON text in the body (POST, for long id lists); the body wins
function readParams(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = body.trim() ? JSON.parse(body) : {}; } catch (e) { return { error: 'The request could not be read.' }; } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  return { ...(req.query || {}), ...body };
}

// ids -> { objectIds, days }   days: Map(taskId -> Set(day) | null). null = the whole task.
function parseIds(raw) {
  if (raw == null || raw === '') return { none: true, objectIds: [], days: new Map() };
  let list = raw;
  if (typeof list === 'string') list = list.split(',');
  if (!Array.isArray(list)) return { error: 'The record list could not be read.' };
  if (list.length > MAX_IDS) return { error: `Please choose fewer records (at most ${MAX_IDS}).` };
  const days = new Map();
  for (const item of list) {
    const [idPart, dayPart] = String(item).split('|');
    const id = String(idPart || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id) || id.length !== 24) continue;
    let key = null;
    if (dayPart) {
      const d = ISO_DAY.test(dayPart) ? dayPart : (isNaN(new Date(dayPart).getTime()) ? '' : localKey(new Date(dayPart)));
      if (d) key = d;
    }
    if (!days.has(id)) days.set(id, key ? new Set([key]) : null);
    else if (key === null) days.set(id, null);                       // the whole task is asked for
    else if (days.get(id) !== null) days.get(id).add(key);
  }
  return { none: false, objectIds: [...days.keys()].map((x) => new mongoose.Types.ObjectId(x)), days };
}

// ───────────────────────────── status rules ─────────────────────────────
const DONE_STATUS = ['Completed', 'Verified'];

function delegationItem(t, now, empName) {
  const hist = Array.isArray(t.history) ? t.history : [];
  const doneEntries = hist.filter((h) => h && h.action === 'Completed' && h.timestamp);
  const done = DONE_STATUS.includes(t.status);
  let completedAt = null;
  if (done) {
    completedAt = doneEntries.length ? doneEntries[doneEntries.length - 1].timestamp
      : (hist.length && hist[hist.length - 1].timestamp ? hist[hist.length - 1].timestamp : null);
  }
  const deadline = t.deadline ? new Date(t.deadline) : null;
  const onHold = !!(t.onHold && t.onHold.isOn);
  let status = 'Pending';
  let late = false;
  let daysOverdue = 0;
  if (done) {
    status = 'Completed';
    late = !!(completedAt && deadline && new Date(completedAt).getTime() > deadline.getTime());
  } else if (deadline && deadline.getTime() < now.getTime() && !onHold) {
    status = 'Overdue';
    daysOverdue = Math.max(1, Math.floor((now.getTime() - deadline.getTime()) / DAY));
  }
  return {
    type: 'Delegation', taskId: idOf(t._id), title: t.title || '', doerId: idOf(t.doerId), doerName: empName(t.doerId),
    assignerId: idOf(t.assignerId), assignerName: empName(t.assignerId), dueKey: deadline ? ist(deadline).format('YYYY-MM-DD') : '', due: deadline,
    status, late, completedAt, daysOverdue, onHold, remarks: t.remarks || '', priority: t.priority || ''
  };
}

// All scheduled days of one checklist between its start and the report horizon, each marked done / pending / overdue
function checklistItems(t, ctx, empName) {
  const { holidays, weekends, todayKey, horizonKey, now } = ctx;
  const owner = ctx.empById.get(idOf(t.doerId));
  let wk = Array.isArray(weekends) ? [...weekends] : [0];
  if (owner && owner.workOnSunday) wk = wk.filter((d) => d !== 0);

  const doneMap = new Map(); // day -> completion timestamp
  (t.history || []).forEach((h) => {
    if (!h || (h.action !== 'Completed' && h.action !== 'Administrative Completion')) return;
    const k = localKey(h.instanceDate || h.timestamp);
    const prev = doneMap.get(k);
    if (!prev || new Date(h.timestamp) > new Date(prev.at)) doneMap.set(k, { at: h.timestamp, admin: h.action === 'Administrative Completion' });
  });

  const nextDueKey = t.nextDueDate ? localKey(t.nextDueDate) : '';
  const base = t.startDate || t.createdAt || new Date();
  const days = [];
  const seen = new Set();
  const push = (k) => { if (!seen.has(k)) { seen.add(k); days.push(k); } };

  if (t.status !== 'Paused') {
    try {
      let first = calculateNextDate(t.frequency, t.frequencyConfig || {}, holidays, new Date(base), true, wk);
      let p = moment(first).startOf('day');
      let guard = 0;
      while (p.format('YYYY-MM-DD') <= horizonKey && guard < MAX_PER_CHECKLIST) {
        guard++;
        push(p.format('YYYY-MM-DD'));
        const nx = calculateNextDate(t.frequency, t.frequencyConfig || {}, holidays, p.toDate(), false, wk);
        if (!nx || moment(nx).startOf('day').isSameOrBefore(p)) break;
        p = moment(nx).startOf('day');
      }
    } catch (e) { /* a broken schedule shows only its recorded completions */ }
  }
  for (const k of doneMap.keys()) if (k <= horizonKey) push(k); // completions on days the schedule no longer lists

  return days.sort().map((k) => {
    const d = doneMap.get(k);
    let status;
    let late = false;
    let completedAt = null;
    let daysOverdue = 0;
    if (d) {
      status = 'Completed'; completedAt = d.at;
      late = moment(d.at).isAfter(moment(k, 'YYYY-MM-DD').endOf('day'));
    } else if (nextDueKey && k < nextDueKey) {
      status = 'Not recorded';
    } else if (k < todayKey) {
      status = 'Overdue';
      daysOverdue = Math.max(1, Math.round((moment(todayKey, 'YYYY-MM-DD') - moment(k, 'YYYY-MM-DD')) / DAY));
    } else if (k > todayKey) {
      status = 'Upcoming';
    } else {
      status = 'Pending';
    }
    return {
      type: 'Checklist', taskId: idOf(t._id), title: t.taskName || '', doerId: idOf(t.doerId), doerName: empName(t.doerId),
      assignerName: empName(t.createdBy), dueKey: k, due: null, status, late, completedAt, daysOverdue, onHold: false,
      remarks: '', priority: t.frequency || '', admin: !!(d && d.admin), upcoming: k > todayKey
    };
  });
}

// ───────────────────────────── data collection ─────────────────────────────
async function loadData(req, opts) {
  const tenantId = String(req.user.tenantId);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const me = String(req.user.id || '');
  const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
  const isAdmin = roles.includes('Admin') || isViewerOnly(req.user);

  const Employee = model(req, 'Employee', require('../models/Employee'));
  const DelegationTask = model(req, 'DelegationTask', require('../models/DelegationTask'));
  const ChecklistTask = model(req, 'ChecklistTask', require('../models/ChecklistTask'));

  const [tenant, employees] = await Promise.all([
    Tenant.findById(tenantId).select('companyName holidays weekends').lean(),
    Employee.find({ tenantId: tid }).select('-password -lateTargetHistory -earnedBadges').lean()
  ]);
  const empById = new Map(employees.map((e) => [String(e._id), e]));

  const oid = (s) => new mongoose.Types.ObjectId(s);
  const wantDel = opts.scope === 'delegation' || opts.scope === 'mytasks';
  const wantChk = opts.scope === 'checklist' || opts.scope === 'mytasks';
  const meId = mongoose.Types.ObjectId.isValid(me) ? oid(me) : null;

  let delQuery = null;
  let chkQuery = null;
  if (opts.scope === 'delegation') {
    delQuery = isAdmin ? { tenantId: tid } : { tenantId: tid, $or: [{ assignerId: meId }, { 'forwardChain.employeeId': meId }] };
  } else if (opts.scope === 'mytasks') {
    delQuery = { tenantId: tid, $or: [{ doerId: meId }, { 'helperDoers.helperId': meId }, { coworkers: meId }, { 'forwardChain.employeeId': meId }] };
  }
  if (opts.scope === 'checklist') {
    // Manage Checklist shows every checklist of the company to whoever can open the page (GET /tasks/checklist-all), so the report does too
    chkQuery = { tenantId: tid };
  } else if (opts.scope === 'mytasks') {
    chkQuery = { tenantId: tid, doerId: meId };
  }
  if (opts.employeeId) {
    if (delQuery) delQuery = { $and: [delQuery, { doerId: oid(opts.employeeId) }] };
    if (chkQuery) chkQuery = { $and: [chkQuery, { doerId: oid(opts.employeeId) }] };
  }
  if (opts.assignerId) {
    if (delQuery) delQuery = { $and: [delQuery, { assignerId: oid(opts.assignerId) }] };
    if (chkQuery) chkQuery = { $and: [chkQuery, { createdBy: oid(opts.assignerId) }] };
  }
  if (opts.ids && !opts.ids.none) {            // only the records shown in the table / ticked
    if (delQuery) delQuery = { $and: [delQuery, { _id: { $in: opts.ids.objectIds } }] };
    if (chkQuery) chkQuery = { $and: [chkQuery, { _id: { $in: opts.ids.objectIds } }] };
  }

  const [dels, chks] = await Promise.all([
    wantDel && delQuery && meId
      ? DelegationTask.find(delQuery)
        .select('title description assignerId doerId coordinatorId coworkers forwardChain helperDoers priority deadline originalDeadline status remarks history.action history.timestamp dateChanges.at createdAt onHold parentTask')
        .sort({ createdAt: -1 }).lean()
      : [],
    wantChk && chkQuery && meId
      ? ChecklistTask.find(chkQuery)
        .select('taskName description doerId createdBy frequency frequencyConfig startDate lastCompleted nextDueDate status createdAt history.action history.timestamp history.instanceDate')
        .sort({ createdAt: -1 }).lean()
      : []
  ]);

  return { tenant, employees, empById, delegations: dels, checklists: chks, isAdmin, me };
}

// ───────────────────────────── building the report data ─────────────────────────────
function compute(data, opts, now = new Date()) {
  const { tenant, empById } = data;
  const range = opts.range;
  const empName = (v) => { const e = empById.get(idOf(v)); return e ? e.name : (v && v.name) || ''; };
  const todayKey = localKey(now);
  const horizonKey = range.end ? ist(range.end).format('YYYY-MM-DD') : moment(now).add(FUTURE_DAYS, 'days').format('YYYY-MM-DD');
  const fromKey = range.start ? ist(range.start).format('YYYY-MM-DD') : '';
  const toKey = range.end ? ist(range.end).format('YYYY-MM-DD') : '';
  const inRangeKey = (k) => (!fromKey || k >= fromKey) && (!toKey || k <= toKey);
  const inRangeTs = (d) => { if (!d) return false; const t = new Date(d).getTime(); return (!range.start || t >= range.start.getTime()) && (!range.end || t <= range.end.getTime()); };

  const ctx = { holidays: (tenant && tenant.holidays) || [], weekends: (tenant && tenant.weekends) || [0], todayKey, horizonKey, now, empById };
  const items = [];
  const taskRows = [];      // one per task, for "Task Details"
  const truncated = { schedule: false, items: false, dateWise: false };

  // Delegation
  for (const t of data.delegations) {
    const it = delegationItem(t, now, empName);
    if (opts.status && it.status !== opts.status) continue;
    const given = t.createdAt ? ist(t.createdAt).format('YYYY-MM-DD') : '';
    const keep = range.all || inRangeKey(it.dueKey) || (given && inRangeKey(given)) || inRangeTs(it.completedAt);
    if (!keep) continue;
    items.push(it);
    const followers = (t.coworkers || []).map(empName).filter(Boolean).join(', ');
    const via = (t.forwardChain || []).map((f) => empName(f.employeeId)).filter(Boolean).join(' → ');
    taskRows.push({
      type: 'Delegation', title: it.title, description: t.description || '', assignedBy: it.assignerName, doer: it.doerName,
      coordinator: empName(t.coordinatorId), followers, via, priority: t.priority || '', given: t.createdAt || null,
      due: t.deadline || null, originalDue: t.originalDeadline || null, taskStatus: t.status || '',
      reportStatus: it.status === 'Completed' && it.late ? 'Completed Late' : (it.onHold && it.status === 'Pending' ? 'Pending (On hold)' : it.status),
      daysOverdue: it.daysOverdue, completedAt: it.completedAt, remarks: t.remarks || '',
      dateChanges: (t.dateChanges || []).length, parent: t.parentTask && t.parentTask.title ? t.parentTask.title : '', item: it
    });
  }

  // Checklist
  const checklistRollups = [];
  for (const t of data.checklists) {
    const all = checklistItems(t, ctx, empName);
    const onlyDays = opts.ids && opts.ids.days ? opts.ids.days.get(idOf(t._id)) : null;   // Set of days, or null = every day
    const shown = all.filter((x) => (range.all || inRangeKey(x.dueKey)) && (!onlyDays || onlyDays.has(x.dueKey)) && (!opts.status || x.status === opts.status));
    if (shown.length === 0 && (!range.all || opts.status || onlyDays)) continue;
    for (const x of shown) {
      if (items.length >= MAX_ITEMS) { truncated.items = true; break; }
      items.push(x);
    }
    const counted = shown.filter((x) => x.status !== 'Not recorded' && x.status !== 'Upcoming');
    const c = (s) => counted.filter((x) => x.status === s).length;
    const lastDone = shown.filter((x) => x.completedAt).map((x) => new Date(x.completedAt)).sort((a, b) => b - a)[0] || null;
    const roll = {
      type: 'Checklist', title: t.taskName || '', doer: empName(t.doerId), frequency: t.frequency || '', status: t.status || 'Active',
      total: counted.length, completed: c('Completed'), late: counted.filter((x) => x.status === 'Completed' && x.late).length,
      pending: c('Pending'), overdue: c('Overdue'), notRecorded: shown.filter((x) => x.status === 'Not recorded').length, upcoming: shown.filter((x) => x.status === 'Upcoming').length,
      lastCompleted: lastDone || t.lastCompleted || null, nextDue: t.nextDueDate || null
    };
    checklistRollups.push(roll);
    taskRows.push({
      type: 'Checklist', title: roll.title, description: t.description || '', assignedBy: empName(t.createdBy), doer: roll.doer,
      coordinator: '', followers: '', via: '', priority: roll.frequency, given: t.createdAt || null, due: t.nextDueDate || null,
      originalDue: null, taskStatus: roll.status, reportStatus: roll.status === 'Paused' ? 'Paused' : (roll.overdue > 0 ? 'Overdue' : (roll.pending > 0 ? 'Pending' : 'Completed')),
      daysOverdue: Math.max(0, ...counted.filter((x) => x.status === 'Overdue').map((x) => x.daysOverdue)), completedAt: roll.lastCompleted, remarks: '',
      dateChanges: 0, parent: '', item: null
    });
  }
  // delegation roll-ups share the same sheet
  const rollups = [
    ...data.delegations.length ? taskRows.filter((r) => r.type === 'Delegation').map((r) => ({
      type: 'Delegation', title: r.title, doer: r.doer, frequency: r.priority, status: r.taskStatus,
      total: 1, completed: r.item.status === 'Completed' ? 1 : 0, late: r.item.status === 'Completed' && r.item.late ? 1 : 0,
      pending: r.item.status === 'Pending' ? 1 : 0, overdue: r.item.status === 'Overdue' ? 1 : 0, notRecorded: 0, upcoming: 0,
      lastCompleted: r.completedAt, nextDue: r.due
    })) : [],
    ...checklistRollups
  ];

  // Totals
  const counted = items.filter((x) => x.status !== 'Not recorded' && x.status !== 'Upcoming');
  const tally = (list) => ({
    total: list.length,
    completed: list.filter((x) => x.status === 'Completed').length,
    late: list.filter((x) => x.status === 'Completed' && x.late).length,
    pending: list.filter((x) => x.status === 'Pending').length,
    overdue: list.filter((x) => x.status === 'Overdue').length
  });
  const totals = tally(counted);
  const byType = { Delegation: tally(counted.filter((x) => x.type === 'Delegation')), Checklist: tally(counted.filter((x) => x.type === 'Checklist')) };
  const byPriority = {};
  counted.filter((x) => x.type === 'Delegation').forEach((x) => { const k = x.priority || '—'; (byPriority[k] = byPriority[k] || []).push(x); });
  Object.keys(byPriority).forEach((k) => { byPriority[k] = tally(byPriority[k]); });

  // Work distribution (per doer) + tasks given to others
  const dist = new Map();
  const bucket = (id, name) => {
    if (!dist.has(id)) dist.set(id, { id, name, delegation: 0, checklistTasks: new Set(), occurrences: 0, completed: 0, pending: 0, overdue: 0, given: 0 });
    return dist.get(id);
  };
  counted.forEach((x) => {
    const b = bucket(x.doerId, x.doerName || '(not set)');
    if (x.type === 'Delegation') b.delegation++; else { b.checklistTasks.add(x.taskId); b.occurrences++; }
    if (x.status === 'Completed') b.completed++; else if (x.status === 'Pending') b.pending++; else if (x.status === 'Overdue') b.overdue++;
  });
  counted.filter((x) => x.type === 'Delegation' && x.assignerId).forEach((x) => { bucket(x.assignerId, x.assignerName).given++; });
  const distribution = [...dist.values()].sort((a, b) => (b.delegation + b.occurrences) - (a.delegation + a.occurrences));

  // Date-wise records: completed on that day, or due on that day and not completed
  const dateWise = [];
  counted.forEach((x) => {
    if (x.status === 'Completed') {
      const key = ist(x.completedAt).format('YYYY-MM-DD');
      if (!inRangeKey(key)) return;
      dateWise.push({ key, type: x.type, title: x.title, doer: x.doerName, outcome: x.late ? 'Completed late' : 'Completed', dueKey: x.dueKey, completedAt: x.completedAt, daysOverdue: 0 });
    } else if (x.status === 'Overdue' || x.status === 'Pending') {
      if (!inRangeKey(x.dueKey)) return;
      dateWise.push({ key: x.dueKey, type: x.type, title: x.title, doer: x.doerName, outcome: x.status === 'Overdue' ? 'Not completed (overdue)' : 'Pending', dueKey: x.dueKey, completedAt: null, daysOverdue: x.daysOverdue });
    }
  });
  dateWise.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.type.localeCompare(b.type) || a.title.localeCompare(b.title)));
  const dayTotals = new Map();
  dateWise.forEach((r) => {
    const d = dayTotals.get(r.key) || { key: r.key, completed: 0, notCompleted: 0, pending: 0 };
    if (r.outcome.startsWith('Completed')) d.completed++; else if (r.outcome.startsWith('Not completed')) d.notCompleted++; else d.pending++;
    dayTotals.set(r.key, d);
  });

  // People shown on the "Employee & Doer Details" sheet
  const involved = new Set();
  items.forEach((x) => { if (x.doerId) involved.add(x.doerId); });
  data.delegations.forEach((t) => { const a = idOf(t.assignerId); if (a) involved.add(a); });
  data.checklists.forEach((t) => { const a = idOf(t.createdBy); if (a) involved.add(a); });
  if (opts.employeeId) involved.add(opts.employeeId);

  return { items, taskRows, rollups, totals, byType, byPriority, distribution, dateWise, dayTotals: [...dayTotals.values()], involved, truncated, todayKey, empName };
}

// ───────────────────────────── workbook styling ─────────────────────────────
const COLORS = { head: 'FF1F2937', headText: 'FFFFFFFF', over: 'FFFEE2E2', overText: 'FFB91C1C', done: 'FFDCFCE7', doneText: 'FF166534', pend: 'FFFEF3C7', pendText: 'FF92400E', grey: 'FFE5E7EB', up: 'FFE0F2FE', band: 'FFF9FAFB', total: 'FFE0E7FF' };
const STATUS_FILL = { Completed: COLORS.done, 'Completed Late': COLORS.done, 'Completed late': COLORS.done, Overdue: COLORS.over, 'Not completed (overdue)': COLORS.over, Pending: COLORS.pend, 'Pending (On hold)': COLORS.pend, 'Not recorded': COLORS.grey, Paused: COLORS.grey, Upcoming: COLORS.up };
const STATUS_TEXT = { Completed: COLORS.doneText, 'Completed Late': COLORS.doneText, 'Completed late': COLORS.doneText, Overdue: COLORS.overText, 'Not completed (overdue)': COLORS.overText, Pending: COLORS.pendText, 'Pending (On hold)': COLORS.pendText, Upcoming: 'FF075985' };
const DATE_FMT = 'dd-mmm-yyyy';
const DATETIME_FMT = 'dd-mmm-yyyy hh:mm AM/PM';

function sheetOf(wb, name, columns) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16, style: c.fmt ? { numFmt: c.fmt, alignment: { vertical: 'top', horizontal: 'left', wrapText: !!c.wrap } } : { alignment: { vertical: 'top', wrapText: !!c.wrap } } }));
  const head = ws.getRow(1);
  head.height = 24;
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.headText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.head } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } } };
  });
  return ws;
}
const finishSheet = (ws, colCount) => {
  if (ws.rowCount >= 1 && colCount) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colCount } };
};
function paintStatus(ws, row, statusCol, over) {
  const v = row.getCell(statusCol).value;
  const fill = STATUS_FILL[v];
  if (over) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.over } }; });
  if (fill) {
    const c = row.getCell(statusCol);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    c.font = { bold: true, color: { argb: STATUS_TEXT[v] || 'FF374151' } };
  }
}
const rowStatus = (it) => (it.status === 'Completed' && it.late ? 'Completed Late' : it.status);

// ───────────────────────────── task workbook ─────────────────────────────
function buildTaskWorkbook(data, opts, now = new Date()) {
  const c = compute(data, opts, now);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Work-Pilot';
  wb.created = now;
  const want = new Set(SHEETS_FOR[opts.type]);
  const dayName = (key) => moment(key, 'YYYY-MM-DD').format('dddd');

  // 1. Schedule
  if (want.has('Schedule')) {
    const ws = sheetOf(wb, 'Schedule', [
      { header: 'S. No.', key: 'n', width: 7 }, { header: 'Scheduled / Due Date', key: 'date', width: 16, fmt: DATE_FMT }, { header: 'Day', key: 'day', width: 12 },
      { header: 'Type', key: 'type', width: 12 }, { header: 'Task', key: 'title', width: 44, wrap: true }, { header: 'Doer', key: 'doer', width: 22 },
      { header: 'Assigned By', key: 'by', width: 22 }, { header: 'Frequency / Priority', key: 'pri', width: 16 }, { header: 'Status', key: 'status', width: 16 },
      { header: 'Days Overdue', key: 'od', width: 10 }, { header: 'Completed On', key: 'done', width: 22, fmt: DATETIME_FMT }
    ]);
    const list = c.items.filter((x) => x.status !== 'Not recorded').sort((a, b) => (a.dueKey < b.dueKey ? -1 : a.dueKey > b.dueKey ? 1 : a.doerName.localeCompare(b.doerName)));
    if (list.length > MAX_SHEET_ROWS) { list.splice(0, list.length - MAX_SHEET_ROWS); c.truncated.schedule = true; }
    list.forEach((x, i) => {
      const r = ws.addRow({ n: i + 1, date: xlDayKey(x.dueKey), day: x.dueKey ? dayName(x.dueKey) : '', type: x.type, title: clean(x.title), doer: x.doerName, by: x.assignerName, pri: x.priority, status: rowStatus(x), od: x.daysOverdue || '', done: xlDateTime(x.completedAt) });
      paintStatus(ws, r, 9, x.status === 'Overdue');
    });
    finishSheet(ws, 11);
  }

  // 2. Task Details
  if (want.has('Task Details')) {
    const ws = sheetOf(wb, 'Task Details', [
      { header: 'S. No.', key: 'n', width: 7 }, { header: 'Type', key: 'type', width: 12 }, { header: 'Task', key: 'title', width: 40, wrap: true },
      { header: 'Description', key: 'desc', width: 44, wrap: true }, { header: 'Assigned By', key: 'by', width: 22 }, { header: 'Doer', key: 'doer', width: 22 },
      { header: 'Coordinator', key: 'coord', width: 20 }, { header: 'Followers', key: 'fol', width: 24, wrap: true }, { header: 'Passed On Via', key: 'via', width: 24, wrap: true },
      { header: 'Priority / Frequency', key: 'pri', width: 16 }, { header: 'Given On', key: 'given', width: 22, fmt: DATETIME_FMT }, { header: 'Deadline / Next Due', key: 'due', width: 22, fmt: DATETIME_FMT },
      { header: 'First Deadline (if changed)', key: 'orig', width: 22, fmt: DATETIME_FMT }, { header: 'Times Date Changed', key: 'chg', width: 10 },
      { header: 'Task Status', key: 'ts', width: 18 }, { header: 'Report Status', key: 'rs', width: 18 }, { header: 'Days Overdue', key: 'od', width: 10 },
      { header: 'Completed / Last Done', key: 'done', width: 22, fmt: DATETIME_FMT }, { header: 'Sub Task Of', key: 'parent', width: 28 }, { header: 'Remarks', key: 'rem', width: 30, wrap: true }
    ]);
    c.taskRows.forEach((t, i) => {
      const r = ws.addRow({ n: i + 1, type: t.type, title: clean(t.title), desc: clean(t.description), by: t.assignedBy, doer: t.doer, coord: t.coordinator, fol: t.followers, via: t.via, pri: t.priority, given: xlDateTime(t.given), due: xlDateTime(t.due), orig: xlDateTime(t.originalDue), chg: t.dateChanges || '', ts: t.taskStatus, rs: t.reportStatus, od: t.daysOverdue || '', done: xlDateTime(t.completedAt), parent: t.parent, rem: clean(t.remarks) });
      paintStatus(ws, r, 16, t.reportStatus === 'Overdue');
    });
    finishSheet(ws, 20);
  }

  // 3. Checklist Status
  if (want.has('Checklist Status')) {
    const ws = sheetOf(wb, 'Checklist Status', [
      { header: 'S. No.', key: 'n', width: 7 }, { header: 'Type', key: 'type', width: 12 }, { header: 'Task', key: 'title', width: 44, wrap: true }, { header: 'Doer', key: 'doer', width: 22 },
      { header: 'Frequency / Priority', key: 'freq', width: 16 }, { header: 'Total Scheduled', key: 'total', width: 11 }, { header: 'Completed', key: 'comp', width: 11 },
      { header: 'of which Late', key: 'late', width: 11 }, { header: 'Pending', key: 'pend', width: 10 }, { header: 'Overdue', key: 'over', width: 10 },
      { header: 'Upcoming', key: 'up', width: 10 }, { header: 'Not Recorded', key: 'nr', width: 11 }, { header: 'Completion %', key: 'pct', width: 11 }, { header: 'Last Completed', key: 'last', width: 22, fmt: DATETIME_FMT },
      { header: 'Next Due', key: 'next', width: 22, fmt: DATETIME_FMT }, { header: 'Status', key: 'st', width: 14 }
    ]);
    c.rollups.forEach((x, i) => {
      const r = ws.addRow({ n: i + 1, type: x.type, title: clean(x.title), doer: x.doer, freq: x.frequency, total: x.total, comp: x.completed, late: x.late, pend: x.pending, over: x.overdue, up: x.upcoming || 0, nr: x.notRecorded, pct: pct(x.completed, x.total), last: xlDateTime(x.lastCompleted), next: xlDateTime(x.nextDue), st: x.status });
      if (x.overdue > 0) {
        r.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.over } }; });
        r.getCell('over').font = { bold: true, color: { argb: COLORS.overText } };
      }
    });
    finishSheet(ws, 16);
  }

  // 4. Work Distribution
  if (want.has('Work Distribution')) {
    const ws = sheetOf(wb, 'Work Distribution', [
      { header: 'S. No.', key: 'n', width: 7 }, { header: 'Employee / Doer', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 18 }, { header: 'Roles', key: 'roles', width: 22 },
      { header: 'Delegation Tasks', key: 'del', width: 12 }, { header: 'Checklists', key: 'cl', width: 11 }, { header: 'Checklist Entries', key: 'occ', width: 11 }, { header: 'Total Work Items', key: 'tot', width: 12 },
      { header: 'Completed', key: 'comp', width: 11 }, { header: 'Pending', key: 'pend', width: 10 }, { header: 'Overdue', key: 'over', width: 10 }, { header: 'Completion %', key: 'pct', width: 11 },
      { header: 'Share of All Work %', key: 'share', width: 12 }, { header: 'Tasks Given To Others', key: 'given', width: 12 }
    ]);
    const grand = c.distribution.reduce((s, b) => s + b.delegation + b.occurrences, 0);
    let sum = { del: 0, cl: 0, occ: 0, tot: 0, comp: 0, pend: 0, over: 0, given: 0 };
    c.distribution.forEach((b, i) => {
      const e = data.empById.get(b.id) || {};
      const tot = b.delegation + b.occurrences;
      const r = ws.addRow({ n: i + 1, name: b.name, dept: e.department || '', roles: (e.roles || []).join(', '), del: b.delegation, cl: b.checklistTasks.size, occ: b.occurrences, tot, comp: b.completed, pend: b.pending, over: b.overdue, pct: pct(b.completed, tot), share: pct(tot, grand), given: b.given });
      if (b.overdue > 0) r.getCell('over').font = { bold: true, color: { argb: COLORS.overText } };
      sum = { del: sum.del + b.delegation, cl: sum.cl + b.checklistTasks.size, occ: sum.occ + b.occurrences, tot: sum.tot + tot, comp: sum.comp + b.completed, pend: sum.pend + b.pending, over: sum.over + b.overdue, given: sum.given + b.given };
    });
    if (c.distribution.length) {
      const t = ws.addRow({ name: 'TOTAL', del: sum.del, cl: sum.cl, occ: sum.occ, tot: sum.tot, comp: sum.comp, pend: sum.pend, over: sum.over, pct: pct(sum.comp, sum.tot), share: grand ? 100 : 0, given: sum.given });
      t.eachCell((cell) => { cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.total } }; });
    }
    finishSheet(ws, 14);
  }

  // 5. Employee & Doer Details
  if (want.has('Employee & Doer Details')) {
    const showContact = data.isAdmin;
    const cols = [
      { header: 'S. No.', key: 'n', width: 7 }, { header: 'Name', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 18 }, { header: 'Location', key: 'loc', width: 18 }, { header: 'Roles', key: 'roles', width: 24 }
    ];
    if (showContact) cols.push({ header: 'Email', key: 'email', width: 30 }, { header: 'WhatsApp', key: 'ph', width: 16 });
    cols.push({ header: 'Status', key: 'st', width: 16 }, { header: 'Doers Under Them', key: 'nd', width: 12 }, { header: 'Assigners Under Them', key: 'na', width: 12 });
    const ws = sheetOf(wb, 'Employee & Doer Details', cols);
    const list = [...c.involved].map((id) => data.empById.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((e, i) => {
      const onLeave = e.leaveStatus && e.leaveStatus.onLeave;
      const row = { n: i + 1, name: e.name, dept: e.department || '', loc: e.location || '', roles: (e.roles || []).join(', '), st: onLeave ? 'On Leave' : 'Active', nd: (e.managedDoers || []).length, na: (e.managedAssigners || []).length };
      if (showContact) { row.email = e.email || ''; row.ph = e.whatsappNumber ? String(e.whatsappNumber) : ''; }
      ws.addRow(row);
    });
    finishSheet(ws, cols.length);
  }

  // 6. Task Summary
  if (want.has('Task Summary')) {
    const ws = wb.addWorksheet('Task Summary');
    ws.columns = [{ width: 34 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
    const title = ws.addRow([`Work-Pilot - ${SCOPE_LABEL[opts.scope]} - ${TYPE_LABEL[opts.type]}`]);
    title.font = { bold: true, size: 14 };
    ws.addRow([]);
    const info = (k, v) => { const r = ws.addRow([k, v]); r.getCell(1).font = { bold: true }; };
    info('Company', (data.tenant && data.tenant.companyName) || '');
    info('Created on', ist(now).format('DD MMM YYYY, hh:mm A') + ' (India time)');
    info('Period', opts.range.all ? 'Complete history (plus the next 30 days of schedule)' : `${opts.range.from || 'beginning'}  to  ${opts.range.to || 'latest'}`);
    info('Employee', opts.employeeId ? ((data.empById.get(opts.employeeId) || {}).name || '') : 'All employees');
    if (c.truncated.schedule || c.truncated.dateWise) info('Note', `The Schedule / Date-wise sheets show only the latest ${MAX_SHEET_ROWS} entries so the file stays easy to open. The totals on this sheet count everything. Choose a shorter period or one employee to see all rows.`);
    if (c.truncated.items) info('Note', `This company has a very large history, so the report stopped at ${MAX_ITEMS} entries. Choose a shorter period.`);
    ws.addRow([]);
    const head = (arr) => { const r = ws.addRow(arr); r.eachCell((cell) => { cell.font = { bold: true, color: { argb: COLORS.headText } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.head } }; }); return r; };
    head(['Task-wise summary', 'Total', 'Completed', 'Pending', 'Overdue', 'Completion %', 'of Completed: Late']);
    const line = (label, t, bold) => {
      const r = ws.addRow([label, t.total, t.completed, t.pending, t.overdue, pct(t.completed, t.total), t.late]);
      if (bold) r.eachCell((cell) => { cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.total } }; });
      if (t.overdue > 0) r.getCell(5).font = { bold: true, color: { argb: COLORS.overText } };
    };
    line('All tasks', c.totals, true);
    if (c.byType.Delegation.total) line('Delegation tasks', c.byType.Delegation);
    if (c.byType.Checklist.total) line('Checklist entries', c.byType.Checklist);
    const pr = Object.keys(c.byPriority);
    if (pr.length) { ws.addRow([]); head(['Delegation by priority', 'Total', 'Completed', 'Pending', 'Overdue', 'Completion %', 'of Completed: Late']); pr.forEach((k) => line(k, c.byPriority[k])); }
    ws.addRow([]);
    head(['Workload by employee', 'Total', 'Completed', 'Pending', 'Overdue', 'Completion %', '']);
    c.distribution.forEach((b) => { const tot = b.delegation + b.occurrences; const r = ws.addRow([b.name, tot, b.completed, b.pending, b.overdue, pct(b.completed, tot), '']); if (b.overdue > 0) r.getCell(5).font = { bold: true, color: { argb: COLORS.overText } }; });
    if (c.dayTotals.length) {
      ws.addRow([]);
      head(['Day-wise totals', 'Day', 'Completed', 'Not completed (overdue)', 'Pending', '', '']);
      c.dayTotals.forEach((d) => { const r = ws.addRow([xlDayKey(d.key), dayName(d.key), d.completed, d.notCompleted, d.pending, '', '']); r.getCell(1).numFmt = DATE_FMT; r.getCell(1).alignment = { horizontal: 'left' }; if (d.notCompleted > 0) r.getCell(4).font = { bold: true, color: { argb: COLORS.overText } }; });
    }
    ws.addRow([]);
    const notes = [
      'How to read this report',
      'Completed = finished (a delegation task marked Completed / Verified; a checklist day that has a completion entry). "Late" = finished after its deadline or day.',
      'Pending = not finished yet and not yet past its deadline (checklists: due today; tasks on hold are Pending).',
      'Upcoming = a checklist day after today. It appears in the Schedule only and is not counted in the totals.',
      'Overdue = not finished and the deadline / scheduled day has already passed.',
      'Not Recorded (Checklist Status sheet) = a past day before the checklist\'s current due pointer with no completion entry; it is not counted above.',
      'Period filter: a delegation task is included when it was given, is due, or was completed in the period. A checklist day is included when it is scheduled in the period.'
    ];
    notes.forEach((t, i) => { const r = ws.addRow([t]); if (i === 0) r.font = { bold: true }; else r.font = { color: { argb: 'FF4B5563' } }; });
  }

  // 7. Date-wise Records
  if (want.has('Date-wise Records')) {
    const ws = sheetOf(wb, 'Date-wise Records', [
      { header: 'S. No.', key: 'n', width: 7 }, { header: 'Date', key: 'date', width: 14, fmt: DATE_FMT }, { header: 'Day', key: 'day', width: 12 }, { header: 'Type', key: 'type', width: 12 },
      { header: 'Task', key: 'title', width: 44, wrap: true }, { header: 'Doer', key: 'doer', width: 22 }, { header: 'What Happened', key: 'out', width: 24 },
      { header: 'Due / Scheduled For', key: 'due', width: 16, fmt: DATE_FMT }, { header: 'Completed At', key: 'done', width: 22, fmt: DATETIME_FMT }, { header: 'Days Overdue', key: 'od', width: 10 }
    ]);
    const dw = c.dateWise.length > MAX_SHEET_ROWS ? c.dateWise.slice(-MAX_SHEET_ROWS) : c.dateWise;
    if (dw !== c.dateWise) c.truncated.dateWise = true;
    dw.forEach((r0, i) => {
      const r = ws.addRow({ n: i + 1, date: xlDayKey(r0.key), day: dayName(r0.key), type: r0.type, title: clean(r0.title), doer: r0.doer, out: r0.outcome, due: xlDayKey(r0.dueKey), done: xlDateTime(r0.completedAt), od: r0.daysOverdue || '' });
      paintStatus(ws, r, 7, r0.outcome.startsWith('Not completed'));
    });
    finishSheet(ws, 10);
  }

  return { wb, c };
}

// ───────────────────────────── employee workbook ─────────────────────────────
function buildEmployeeWorkbook(data, opts, now = new Date()) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Work-Pilot';
  wb.created = now;
  const all = data.employees;
  const byId = data.empById;
  const list = all.filter((e) => (!opts.employeeId || String(e._id) === opts.employeeId) && (!opts.only || opts.only.has(String(e._id)))).slice().sort((a, b) => a.name.localeCompare(b.name));
  const names = (ids) => (ids || []).map((id) => (byId.get(String(id && id._id ? id._id : id)) || {}).name).filter(Boolean);
  const leaveText = (e) => {
    const l = e.leaveStatus;
    if (!l || !l.onLeave) return 'Active';
    return l.startDate && l.endDate ? `On Leave (${ist(l.startDate).format('DD MMM')} - ${ist(l.endDate).format('DD MMM YYYY')})` : 'On Leave';
  };

  const ws = sheetOf(wb, 'Employee & Doer Details', [
    { header: 'S. No.', key: 'n', width: 7 }, { header: 'Name', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 18 }, { header: 'Location', key: 'loc', width: 18 },
    { header: 'Roles', key: 'roles', width: 26 }, { header: 'Email', key: 'email', width: 30 }, { header: 'WhatsApp', key: 'ph', width: 16 }, { header: 'Status', key: 'st', width: 26 },
    { header: 'Works On Sunday', key: 'sun', width: 11 }, { header: 'Joined On', key: 'join', width: 14, fmt: DATE_FMT }, { header: 'Added On', key: 'added', width: 14, fmt: DATE_FMT },
    { header: 'Total Doers Assigned', key: 'nd', width: 12 }, { header: 'Doer Names', key: 'dn', width: 44, wrap: true },
    { header: 'Total Assigners Monitored', key: 'na', width: 12 }, { header: 'Assigner Names', key: 'an', width: 44, wrap: true }, { header: 'Reward Points', key: 'pts', width: 10 }
  ]);
  list.forEach((e, i) => ws.addRow({
    n: i + 1, name: e.name, dept: e.department || '', loc: e.location || '', roles: (e.roles || []).join(', '), email: e.email || '', ph: e.whatsappNumber ? String(e.whatsappNumber) : '',
    st: leaveText(e), sun: e.workOnSunday ? 'Yes' : 'No', join: xlDate(e.joiningDate), added: xlDate(e.createdAt),
    nd: (e.managedDoers || []).length, dn: names(e.managedDoers).join(', '), na: (e.managedAssigners || []).length, an: names(e.managedAssigners).join(', '), pts: e.totalPoints || 0
  }));
  finishSheet(ws, 16);

  const wd = sheetOf(wb, 'Doer Distribution', [
    { header: 'S. No.', key: 'n', width: 7 }, { header: 'Employee', key: 'emp', width: 26 }, { header: 'Employee Roles', key: 'er', width: 22 },
    { header: 'Doer Assigned', key: 'doer', width: 26 }, { header: 'Doer Department', key: 'dd', width: 18 }, { header: 'Doer Location', key: 'dl', width: 18 },
    { header: 'Doer Roles', key: 'dr', width: 22 }, { header: 'Doer Status', key: 'ds', width: 26 }
  ]);
  let n = 0;
  list.forEach((e) => {
    (e.managedDoers || []).forEach((d) => {
      const doer = byId.get(String(d && d._id ? d._id : d));
      if (!doer) return;
      wd.addRow({ n: ++n, emp: e.name, er: (e.roles || []).join(', '), doer: doer.name, dd: doer.department || '', dl: doer.location || '', dr: (doer.roles || []).join(', '), ds: leaveText(doer) });
    });
  });
  finishSheet(wd, 8);

  const sm = wb.addWorksheet('Allocation Summary');
  sm.columns = [{ width: 30 }, { width: 24 }, { width: 16 }, { width: 18 }, { width: 18 }];
  const t = sm.addRow([`Work-Pilot - Employee & Doer Allocation`]); t.font = { bold: true, size: 14 };
  sm.addRow([]);
  const info = (k, v) => { const r = sm.addRow([k, v]); r.getCell(1).font = { bold: true }; };
  info('Company', (data.tenant && data.tenant.companyName) || '');
  info('Created on', ist(now).format('DD MMM YYYY, hh:mm A') + ' (India time)');
  info('Employees in this file', list.length);
  const mapped = new Set();
  all.forEach((e) => (e.managedDoers || []).forEach((d) => mapped.add(String(d && d._id ? d._id : d))));
  const doers = all.filter((e) => (e.roles || []).includes('Doer'));
  info('People with the Doer role (company)', doers.length);
  info('Doers assigned under at least one employee', doers.filter((d) => mapped.has(String(d._id))).length);
  info('Doers not assigned under anyone', doers.filter((d) => !mapped.has(String(d._id))).length);
  sm.addRow([]);
  const hd = sm.addRow(['Employee', 'Roles', 'Doers Assigned', 'Assigners Monitored', 'Share of Mapped Doers %']);
  hd.eachCell((cell) => { cell.font = { bold: true, color: { argb: COLORS.headText } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.head } }; });
  const totalLinks = list.reduce((s, e) => s + (e.managedDoers || []).length, 0);
  list.slice().sort((a, b) => (b.managedDoers || []).length - (a.managedDoers || []).length).forEach((e) => {
    sm.addRow([e.name, (e.roles || []).join(', '), (e.managedDoers || []).length, (e.managedAssigners || []).length, pct((e.managedDoers || []).length, totalLinks)]);
  });
  const tr = sm.addRow(['TOTAL', '', totalLinks, list.reduce((s, e) => s + (e.managedAssigners || []).length, 0), totalLinks ? 100 : 0]);
  tr.eachCell((cell) => { cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.total } }; });
  return { wb };
}

// ───────────────────────────── HTTP handlers ─────────────────────────────
const sendWorkbook = async (res, wb, filename) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  await wb.xlsx.write(res);
  res.end();
};

exports.downloadTasks = async (req, res) => {
  try {
    if (!req.user || !req.user.tenantId) return res.status(403).json({ message: 'Open this from your company account.' });
    const q = readParams(req);
    if (q.error) return res.status(400).json({ message: q.error });
    const scope = String(q.scope || '');
    const type = String(q.type || 'complete');
    if (!SCOPES.includes(scope)) return res.status(400).json({ message: 'Unknown page for the report.' });
    if (!TYPES.includes(type)) return res.status(400).json({ message: 'Unknown report type.' });
    const range = parseRange(q);
    if (range.error) return res.status(400).json({ message: range.error });
    let employeeId = q.employeeId ? String(q.employeeId) : '';
    if (employeeId && !mongoose.Types.ObjectId.isValid(employeeId)) return res.status(400).json({ message: 'Unknown employee.' });
    let assignerId = q.assignerId ? String(q.assignerId) : '';
    if (assignerId && !mongoose.Types.ObjectId.isValid(assignerId)) return res.status(400).json({ message: 'Unknown employee.' });
    const status = q.status ? String(q.status) : '';
    if (status && !STATUSES.includes(status)) return res.status(400).json({ message: 'Unknown task status.' });
    const ids = parseIds(q.ids);
    if (ids.error) return res.status(400).json({ message: ids.error });
    if (scope === 'mytasks') { employeeId = ''; assignerId = ''; }

    const opts = { scope, type, range, employeeId, assignerId, status, ids };
    const data = await loadData(req, opts);
    if (employeeId && !data.empById.has(employeeId)) return res.status(404).json({ message: 'That employee was not found in your company.' });
    if (assignerId && !data.empById.has(assignerId)) return res.status(404).json({ message: 'That employee was not found in your company.' });

    if (String(q.count || '') === '1') {      // only tell how many records the file would hold (no file is built)
      const c = compute(data, opts);
      return res.status(200).json({ tasks: c.taskRows.length, entries: c.totals.total, overdue: c.totals.overdue });
    }

    const { wb } = buildTaskWorkbook(data, opts);
    const who = employeeId ? (data.empById.get(employeeId).name || 'employee').replace(/[^A-Za-z0-9]+/g, '_') : 'All';
    const part = !ids.none ? '_Selected' : '';
    const fname = `WorkPilot_${SCOPE_LABEL[scope].replace(/\s+/g, '')}_${TYPE_LABEL[type].replace(/[\s-]+/g, '')}${part}_${who}_${fileDay(range.from)}_to_${fileDay(range.to)}.xlsx`;
    await sendWorkbook(res, wb, fname);
  } catch (err) {
    console.error('Excel task report error:', err.message);
    if (!res.headersSent) res.status(500).json({ message: 'Could not build the Excel report.', error: err.message });
  }
};

exports.downloadEmployees = async (req, res) => {
  try {
    if (!req.user || !req.user.tenantId) return res.status(403).json({ message: 'Open this from your company account.' });
    const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
    if (!(req.user.isSuperAdmin || roles.includes('Admin'))) return res.status(403).json({ message: 'Only the company Admin can download the employee report.' });
    const q = readParams(req);
    if (q.error) return res.status(400).json({ message: q.error });
    const employeeId = q.employeeId ? String(q.employeeId) : '';
    if (employeeId && !mongoose.Types.ObjectId.isValid(employeeId)) return res.status(400).json({ message: 'Unknown employee.' });
    const ids = parseIds(q.ids);
    if (ids.error) return res.status(400).json({ message: ids.error });

    const Employee = model(req, 'Employee', require('../models/Employee'));
    const tenantId = String(req.user.tenantId);
    const [tenant, employees] = await Promise.all([
      Tenant.findById(tenantId).select('companyName').lean(),
      Employee.find({ tenantId: new mongoose.Types.ObjectId(tenantId) }).select('-password -lateTargetHistory -earnedBadges').lean()
    ]);
    const empById = new Map(employees.map((e) => [String(e._id), e]));
    if (employeeId && !empById.has(employeeId)) return res.status(404).json({ message: 'That employee was not found in your company.' });

    const only = ids.none ? null : new Set(ids.objectIds.map(String));
    if (String(q.count || '') === '1') {
      const n = employees.filter((e) => (!employeeId || String(e._id) === employeeId) && (!only || only.has(String(e._id)))).length;
      return res.status(200).json({ employees: n });
    }
    const { wb } = buildEmployeeWorkbook({ tenant, employees, empById }, { employeeId, only });
    const who = employeeId ? empById.get(employeeId).name.replace(/[^A-Za-z0-9]+/g, '_') : 'All';
    await sendWorkbook(res, wb, `WorkPilot_Employees${only ? '_Selected' : ''}_${who}_${moment().utcOffset(330).format('YYYY-MM-DD')}.xlsx`);
  } catch (err) {
    console.error('Excel employee report error:', err.message);
    if (!res.headersSent) res.status(500).json({ message: 'Could not build the employee report.', error: err.message });
  }
};

// exposed for tests only
exports._test = { compute, buildTaskWorkbook, buildEmployeeWorkbook, parseRange, parseIds, readParams, delegationItem, checklistItems };
