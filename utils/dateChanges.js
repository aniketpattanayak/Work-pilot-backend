// utils/dateChanges.js
// One place for every rule about changing a task's deadline.
const { isOn } = require('./settingsRegistry');

const DEFAULT_REASONS = [
  'Waiting for client',
  'Waiting for another department',
  'Sick or on leave',
  'Priority changed',
  'My own delay',
  'Assigner changed the work',
  'Other',
];
const reasonsOf = (tenant) => {
  const r = tenant && tenant.companySettings && tenant.companySettings.dateChangeReasons;
  return Array.isArray(r) && r.length ? r : DEFAULT_REASONS;
};

const idOf = (x) => String((x && x._id) || x || '');
const IST = 330 * 60 * 1000;
const dayIst = (d) => Math.floor((new Date(d).getTime() + IST) / 86400000);
const fmt = (d) => {
  try { return require('moment')(d).utcOffset(330).format('DD MMM YYYY, hh:mm A'); } catch { return String(d); }
};

const isDone = (task) => ['Completed', 'Verified'].includes(task.status);

// Returns an error text when the date may not be changed now, else ''
function blockedReason(task, tenant) {
  if (isDone(task) && isOn(tenant, 'dates_lockWhenDone')) return 'This task is already done, so its deadline is locked.';
  return '';
}

// Checks the chosen reason against the company's list. Returns { error, reason, reasonNote }
function checkReason(tenant, body) {
  const reason = String((body && (body.reason || body.reasonKey)) || '').trim();
  const note = String((body && (body.reasonNote || body.remarks)) || '').trim().slice(0, 500);
  const required = isOn(tenant, 'dates_requireReason');
  if (!reason && !note) {
    return required ? { error: 'Please choose the reason for the change.' } : { reason: '', reasonNote: '' };
  }
  if (reason) {
    const list = reasonsOf(tenant);
    if (!list.includes(reason)) return { error: 'Please choose a reason from the list.' };
    if (reason === 'Other' && !note) return { error: 'Please write a note when the reason is "Other".' };
  } else if (required) {
    return { error: 'Please choose the reason for the change.' };
  }
  return { reason, reasonNote: note };
}

// Moves the deadline and records it. Does not save.
function applyDateChange(task, { actor, newDeadline, reason, reasonNote, byRole }) {
  const oldDeadline = task.deadline;
  const nd = new Date(newDeadline);
  const shortened = nd.getTime() < new Date(oldDeadline).getTime();
  if (!task.originalDeadline) task.originalDeadline = oldDeadline;
  task.deadline = nd;
  task.revisedAt = new Date();
  task.revisedByDoerId = task.doerId && task.doerId._id ? task.doerId._id : task.doerId; // "Revised" shows to the current doer
  if (!Array.isArray(task.dateChanges)) task.dateChanges = [];
  task.dateChanges.push({
    at: new Date(), byId: actor && actor.id, byName: (actor && actor.name) || '', byRole: byRole || 'assigner',
    oldDeadline, newDeadline: nd, reason: reason || '', reasonNote: reasonNote || '', shortened,
  });
  if (!Array.isArray(task.history)) task.history = [];
  const days = dayIst(nd) - dayIst(oldDeadline);
  task.history.push({
    action: 'Deadline Changed',
    performedBy: actor && actor.id,
    timestamp: new Date(),
    remarks: `${fmt(oldDeadline)} -> ${fmt(nd)}${days ? ` (${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'})` : ''}${shortened ? ' - SHORTENED' : ''}${reason ? ` | ${reason}` : ''}${reasonNote ? ` | ${reasonNote}` : ''}`,
  });
  return { oldDeadline, newDeadline: nd, shortened, days };
}

// Records a change that the caller already applied to task.deadline (the doer's own Revise and an approved request)
function pushDateChange(task, { actor, oldDeadline, newDeadline, reason, reasonNote, byRole }) {
  if (!Array.isArray(task.dateChanges)) task.dateChanges = [];
  task.dateChanges.push({
    at: new Date(), byId: actor && actor.id, byName: (actor && actor.name) || '', byRole: byRole || 'doer',
    oldDeadline, newDeadline: new Date(newDeadline), reason: reason || '', reasonNote: reasonNote || '',
    shortened: new Date(newDeadline).getTime() < new Date(oldDeadline).getTime(),
  });
}

// Warnings (never blocks): weekly off, holiday, the doer on leave
async function dateWarnings({ tenant, doerId, date, models }) {
  const out = [];
  const d = new Date(date);
  if (isNaN(d.getTime())) return out;
  const ist = new Date(d.getTime() + IST);
  const dow = ist.getUTCDay();
  const weekends = (tenant && Array.isArray(tenant.weekends)) ? tenant.weekends : [0];
  if (weekends.includes(dow)) out.push(`${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow]} is a weekly off day.`);
  const ymd = ist.toISOString().slice(0, 10);
  for (const h of (tenant && tenant.holidays) || []) {
    if (h && h.date && new Date(new Date(h.date).getTime() + IST).toISOString().slice(0, 10) === ymd) out.push(`${ymd} is a holiday${h.name ? ` (${h.name})` : ''}.`);
  }
  try {
    if (doerId && models && models.LeaveRequest) {
      const l = await models.LeaveRequest.findOne({ employeeId: doerId, status: 'Approved', fromDate: { $lte: ymd }, toDate: { $gte: ymd } }).lean();
      if (l) out.push('The doer is on approved leave on this date.');
    }
  } catch { /* leave check is best effort */ }
  return out;
}

module.exports = { pushDateChange, DEFAULT_REASONS, reasonsOf, idOf, dayIst, fmt, isDone, blockedReason, checkReason, applyDateChange, dateWarnings };
