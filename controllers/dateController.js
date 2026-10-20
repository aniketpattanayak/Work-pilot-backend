// controllers/dateController.js
// Deadline rules beyond the doer's own Revise button: assigner / admin / follower changes,
// follower requests, On hold, warnings, and the date-change report.
const mongoose = require('mongoose');
// Models of the company's own database (req.db), else the shared ones - same approach as taskController
const safe = (db, name, fallback) => { if (!db) return fallback; try { return db.model(name); } catch (e) { return fallback; } };
const getReqModels = async (req) => ({
  DelegationTask: safe(req.db, 'DelegationTask', require('../models/DelegationTask')),
  Employee:       safe(req.db, 'Employee', require('../models/Employee')),
  LeaveRequest:   safe(req.db, 'LeaveRequest', require('../models/LeaveRequest')),
});
const Tenant = require('../models/Tenant');
const { notifyTenant } = require('../utils/notify');
const { isOn } = require('../utils/settingsRegistry');
const D = require('../utils/dateChanges');

const uidOf = (req) => String(req.user && req.user.id || '');
const rolesOf = (req) => (Array.isArray(req.user && req.user.roles) ? req.user.roles : []);
const isAdminReq = (req) => !!(req.user && req.user.isSuperAdmin) || rolesOf(req).includes('Admin');

const withLeave = (req, m) => {
  let L = null;
  try { if (req.db) L = req.db.model('LeaveRequest'); } catch { /* not registered on this connection */ }
  return { ...m, LeaveRequest: L || require('../models/LeaveRequest') };
};

async function load(req, res, { needDoer = true } = {}) {
  const m = await getReqModels(req);
  const taskId = req.params.taskId;
  if (!mongoose.Types.ObjectId.isValid(taskId)) { res.status(400).json({ message: 'Invalid task.' }); return null; }
  let q = m.DelegationTask.findById(taskId);
  q = q.populate('doerId assignerId coordinatorId');
  const task = await q;
  if (!task) { res.status(404).json({ message: 'Task not found.' }); return null; }
  if (!(req.user && req.user.isSuperAdmin) && String(task.tenantId) !== String(req.user && req.user.tenantId)) { res.status(403).json({ message: 'This task belongs to another company.' }); return null; }
  const tenant = await Tenant.findById(task.tenantId).lean();
  return { m, task, tenant };
}

async function actorOf(req, m) {
  let name = 'Admin';
  try { const e = await m.Employee.findById(req.user.id).select('name').lean(); if (e && e.name) name = e.name; } catch { /* keep default */ }
  if (req.user && req.user.isSuperAdmin) name = 'Platform admin';
  return { id: mongoose.Types.ObjectId.isValid(req.user && req.user.id) ? req.user.id : undefined, name };
}

const linkOf = (tenant) => `https://${(tenant && tenant.subdomain) || 'portal'}.lrbcloud.ai/dashboard/my-tasks`;
async function tell(tenant, emp, key, vars) {
  try { if (emp && emp.whatsappNumber) await notifyTenant(tenant._id, emp.whatsappNumber, { templateName: key, variables: vars.map((v) => String(v == null ? '' : v)) }); }
  catch (e) { console.error(`[dates] WhatsApp ${key} failed:`, e.message); }
}

// GET /api/tasks/date-reasons : the list a person picks from
exports.getReasons = async (req, res) => {
  try {
    const t = req.user && req.user.tenantId ? await Tenant.findById(req.user.tenantId).select('companySettings.dateChangeReasons companySettings.switches').lean() : null;
    res.json({ reasons: D.reasonsOf(t), required: isOn(t, 'dates_requireReason') });
  } catch (e) { res.status(500).json({ message: 'Could not load reasons.', error: e.message }); }
};

// POST /api/tasks/date-check  { taskId?, doerId?, date } -> warnings (weekly off, holiday, leave) and, with taskId, a "later than main task" hint
exports.checkDate = async (req, res) => {
  try {
    const m = withLeave(req, await getReqModels(req));
    const tenant = req.user && req.user.tenantId ? await Tenant.findById(req.user.tenantId).lean() : null;
    let doerId = req.body && req.body.doerId;
    if (!doerId && req.body && req.body.taskId && mongoose.Types.ObjectId.isValid(req.body.taskId)) {
      const t = await m.DelegationTask.findById(req.body.taskId).select('doerId').lean(); doerId = t && t.doerId;
    }
    const warnings = await D.dateWarnings({ tenant, doerId, date: req.body && req.body.date, models: m });
    res.json({ warnings });
  } catch (e) { res.status(500).json({ message: 'Could not check the date.', error: e.message }); }
};

// POST /api/tasks/:taskId/change-date  { newDeadline, reason, reasonNote }
exports.changeDate = async (req, res) => {
  try {
    const ctx = await load(req, res); if (!ctx) return;
    const { m, task, tenant } = ctx;
    const uid = uidOf(req);
    const lock = D.blockedReason(task, tenant); if (lock) return res.status(400).json({ message: lock });
    const nd = new Date(req.body && req.body.newDeadline);
    if (!req.body || !req.body.newDeadline || isNaN(nd.getTime())) return res.status(400).json({ message: 'Please choose the new date.' });
    if (nd.getTime() === new Date(task.deadline).getTime()) return res.status(400).json({ message: 'That is already the deadline.' });
    const rs = D.checkReason(tenant, req.body); if (rs.error) return res.status(400).json({ message: rs.error });

    const isAssigner = D.idOf(task.assignerId) === uid;
    const isCoord = D.idOf(task.coordinatorId) === uid;
    const isAdmin = isAdminReq(req);
    const isFollower = (task.coworkers || []).map(String).includes(uid);
    const isDoer = D.idOf(task.doerId) === uid;
    const actor = await actorOf(req, m);

    if (isAdmin || isAssigner || isCoord) {
      const role = isAssigner ? 'assigner' : (isAdmin ? 'admin' : 'coordinator');
      const r = D.applyDateChange(task, { actor, newDeadline: nd, reason: rs.reason, reasonNote: rs.reasonNote, byRole: role });
      if (task.pendingDateRequest && task.pendingDateRequest.byId) { // a waiting follower request is overtaken
        task.history.push({ action: 'Date Request Closed', performedBy: actor.id, timestamp: new Date(), remarks: `Closed because the deadline was set directly to ${D.fmt(nd)}` });
        task.pendingDateRequest = undefined;
      }
      if (task.status === 'Revision Requested') { task.status = 'Accepted'; task.proposedDeadline = null; task.remarks = ''; }
      await task.save();
      if (isOn(tenant, 'dates_notifyDoer') && D.idOf(task.doerId) !== uid) {
        await tell(tenant, task.doerId, 'task_deadline_changed', [task.doerId && task.doerId.name, task.title, D.fmt(r.oldDeadline), D.fmt(r.newDeadline), actor.name, [rs.reason, rs.reasonNote].filter(Boolean).join(' - ') || 'Not given', linkOf(tenant)]);
      }
      const warnings = await D.dateWarnings({ tenant, doerId: task.doerId && task.doerId._id, date: nd, models: withLeave(req, m) });
      return res.json({ message: 'Deadline changed.', task, warnings });
    }

    if (isFollower && !isDoer) {
      if (!isOn(tenant, 'dates_followersChange')) return res.status(403).json({ message: 'Your company has switched off deadline changes by followers.' });
      if (task.followersCanChangeDate === true) {
        const r = D.applyDateChange(task, { actor, newDeadline: nd, reason: rs.reason, reasonNote: rs.reasonNote, byRole: 'follower' });
        await task.save();
        if (isOn(tenant, 'dates_notifyDoer')) await tell(tenant, task.doerId, 'task_deadline_changed', [task.doerId && task.doerId.name, task.title, D.fmt(r.oldDeadline), D.fmt(r.newDeadline), `${actor.name} (follower)`, [rs.reason, rs.reasonNote].filter(Boolean).join(' - ') || 'Not given', linkOf(tenant)]);
        await tell(tenant, task.assignerId, 'task_deadline_changed', [task.assignerId && task.assignerId.name, task.title, D.fmt(r.oldDeadline), D.fmt(r.newDeadline), `${actor.name} (follower)`, [rs.reason, rs.reasonNote].filter(Boolean).join(' - ') || 'Not given', linkOf(tenant)]);
        return res.json({ message: 'Deadline changed.', task });
      }
      if (task.pendingDateRequest && task.pendingDateRequest.byId) return res.status(400).json({ message: 'A request for this task is already waiting for the assigner.' });
      task.pendingDateRequest = { byId: actor.id, byName: actor.name, proposedDeadline: nd, reason: rs.reason, reasonNote: rs.reasonNote, at: new Date() };
      task.history.push({ action: 'Date Requested', performedBy: actor.id, timestamp: new Date(), remarks: `${actor.name} (follower) asks for ${D.fmt(nd)}${rs.reason ? ` | ${rs.reason}` : ''}${rs.reasonNote ? ` | ${rs.reasonNote}` : ''}` });
      await task.save();
      await tell(tenant, task.assignerId, 'task_date_request', [task.assignerId && task.assignerId.name, task.title, actor.name, D.fmt(nd), [rs.reason, rs.reasonNote].filter(Boolean).join(' - ') || 'Not given', linkOf(tenant)]);
      return res.json({ message: 'Your request was sent to the assigner.', requested: true, task });
    }
    return res.status(403).json({ message: isDoer ? 'Use the Revise button to change your own deadline.' : 'You are not allowed to change the deadline of this task.' });
  } catch (e) { console.error('changeDate error:', e.message); res.status(500).json({ message: 'Could not change the date.', error: e.message }); }
};

// POST /api/tasks/:taskId/date-request  { decision: 'approve' | 'reject', note }
exports.decideRequest = async (req, res) => {
  try {
    const ctx = await load(req, res); if (!ctx) return;
    const { m, task, tenant } = ctx;
    const uid = uidOf(req);
    if (!(isAdminReq(req) || D.idOf(task.assignerId) === uid || D.idOf(task.coordinatorId) === uid)) return res.status(403).json({ message: 'Only the assigner or an admin can answer this.' });
    const pr = task.pendingDateRequest;
    if (!pr || !pr.byId) return res.status(400).json({ message: 'There is no waiting request on this task.' });
    const decision = String(req.body && req.body.decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ message: 'Decision must be approve or reject.' });
    const actor = await actorOf(req, m);
    const requester = await m.Employee.findById(pr.byId).select('name whatsappNumber').lean();
    let answer = 'REJECTED';
    if (decision === 'approve') {
      const lock = D.blockedReason(task, tenant); if (lock) return res.status(400).json({ message: lock });
      const r = D.applyDateChange(task, { actor, newDeadline: pr.proposedDeadline, reason: pr.reason, reasonNote: pr.reasonNote, byRole: 'approved' });
      answer = 'APPROVED';
      if (isOn(tenant, 'dates_notifyDoer')) await tell(tenant, task.doerId, 'task_deadline_changed', [task.doerId && task.doerId.name, task.title, D.fmt(r.oldDeadline), D.fmt(r.newDeadline), `${actor.name} (on ${pr.byName || 'a follower'}'s request)`, [pr.reason, pr.reasonNote].filter(Boolean).join(' - ') || 'Not given', linkOf(tenant)]);
    } else {
      task.history.push({ action: 'Date Request Rejected', performedBy: actor.id, timestamp: new Date(), remarks: `Request for ${D.fmt(pr.proposedDeadline)} rejected${req.body && req.body.note ? ` | ${String(req.body.note).slice(0, 300)}` : ''}` });
    }
    task.pendingDateRequest = undefined;
    await task.save();
    await tell(tenant, requester, 'task_date_request_result', [requester && requester.name, task.title, answer, D.fmt(task.deadline), linkOf(tenant)]);
    res.json({ message: `Request ${answer.toLowerCase()}.`, task });
  } catch (e) { console.error('decideRequest error:', e.message); res.status(500).json({ message: 'Could not answer the request.', error: e.message }); }
};

// POST /api/tasks/:taskId/hold  { reason, reasonNote }
exports.putOnHold = async (req, res) => {
  try {
    const ctx = await load(req, res); if (!ctx) return;
    const { m, task, tenant } = ctx;
    if (!isOn(tenant, 'tasks_onHold')) return res.status(403).json({ message: 'Your company has switched off putting tasks On hold.' });
    const uid = uidOf(req);
    if (!(D.idOf(task.doerId) === uid || isAdminReq(req))) return res.status(403).json({ message: 'Only the doer can put this task On hold.' });
    if (D.isDone(task)) return res.status(400).json({ message: 'This task is already done.' });
    if (task.onHold && task.onHold.isOn) return res.status(400).json({ message: 'This task is already On hold.' });
    const reason = String(req.body && req.body.reason || '').trim();
    const note = String(req.body && req.body.reasonNote || '').trim().slice(0, 500);
    if (!reason && !note) return res.status(400).json({ message: 'Please say why the work is stuck.' });
    const actor = await actorOf(req, m);
    task.onHold = { isOn: true, since: new Date(), reason, reasonNote: note, byId: actor.id };
    task.history.push({ action: 'On Hold', performedBy: actor.id, timestamp: new Date(), remarks: [reason, note].filter(Boolean).join(' | ') });
    await task.save();
    await tell(tenant, task.assignerId, 'task_on_hold', [task.assignerId && task.assignerId.name, task.title, task.doerId && task.doerId.name, [reason, note].filter(Boolean).join(' - '), linkOf(tenant)]);
    res.json({ message: 'The task is On hold. The waiting time will not be counted.', task });
  } catch (e) { console.error('putOnHold error:', e.message); res.status(500).json({ message: 'Could not put the task On hold.', error: e.message }); }
};

// Takes the task off hold and moves the deadline by the waiting time. Does not save. Returns the days moved (ms) or 0.
function endHold(task, actor) {
  if (!(task.onHold && task.onHold.isOn && task.onHold.since)) return 0;
  const held = Math.max(0, Date.now() - new Date(task.onHold.since).getTime());
  const since = task.onHold.since;
  task.onHold = { isOn: false };
  if (held > 0 && !D.isDone(task)) {
    D.applyDateChange(task, { actor, newDeadline: new Date(new Date(task.deadline).getTime() + held), reason: 'Paused (On hold)', reasonNote: `On hold since ${D.fmt(since)}`, byRole: 'hold' });
  }
  return held;
}
exports.endHold = endHold;

// POST /api/tasks/:taskId/resume
exports.resumeTask = async (req, res) => {
  try {
    const ctx = await load(req, res); if (!ctx) return;
    const { m, task, tenant } = ctx;
    const uid = uidOf(req);
    if (!(D.idOf(task.doerId) === uid || isAdminReq(req))) return res.status(403).json({ message: 'Only the doer can resume this task.' });
    if (!(task.onHold && task.onHold.isOn)) return res.status(400).json({ message: 'This task is not On hold.' });
    const actor = await actorOf(req, m);
    endHold(task, actor);
    task.history.push({ action: 'Resumed', performedBy: actor.id, timestamp: new Date(), remarks: 'Back to work. The waiting time was not counted.' });
    await task.save();
    await tell(tenant, task.assignerId, 'task_resumed', [task.assignerId && task.assignerId.name, task.title, task.doerId && task.doerId.name, D.fmt(task.deadline), linkOf(tenant)]);
    res.json({ message: 'Resumed. The deadline moved by the waiting time.', task });
  } catch (e) { console.error('resume error:', e.message); res.status(500).json({ message: 'Could not resume the task.', error: e.message }); }
};

// GET /api/tasks/date-changes-report?from=YYYY-MM-DD&to=YYYY-MM-DD   (Admin / Coordinator)
exports.report = async (req, res) => {
  try {
    const roles = rolesOf(req);
    if (!(isAdminReq(req) || roles.includes('Coordinator') || roles.includes('Assigner') || roles.includes('Viewer'))) return res.status(403).json({ message: 'Not allowed.' });
    const m = await getReqModels(req);
    const tenantId = req.user.tenantId;
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 90 * 86400000);
    const to = req.query.to ? new Date(new Date(req.query.to).getTime() + 86400000) : new Date(Date.now() + 86400000);
    const tasks = await m.DelegationTask.find({ tenantId, 'dateChanges.0': { $exists: true }, 'dateChanges.at': { $gte: from, $lt: to } })
      .select('title doerId assignerId deadline originalDeadline status dateChanges').populate('doerId assignerId', 'name').lean();
    const byDoer = {}, byChanger = {}, byReason = {};
    let total = 0, shortened = 0;
    const rows = [];
    for (const t of tasks) {
      for (const c of t.dateChanges) {
        const at = new Date(c.at); if (at < from || at >= to) continue;
        total++; if (c.shortened) shortened++;
        const dn = (t.doerId && t.doerId.name) || 'Unknown';
        const days = D.dayIst(c.newDeadline) - D.dayIst(c.oldDeadline);
        const d = byDoer[dn] || (byDoer[dn] = { name: dn, changes: 0, tasks: new Set(), days: 0, byDoer: 0 });
        d.changes++; d.tasks.add(String(t._id)); d.days += Math.max(0, days); if (c.byRole === 'doer') d.byDoer++;
        const cn = c.byName || 'Unknown';
        const g = byChanger[cn] || (byChanger[cn] = { name: cn, changes: 0, days: 0 });
        g.changes++; g.days += days;
        const rk = c.reason || 'No reason';
        byReason[rk] = (byReason[rk] || 0) + 1;
        rows.push({ taskId: t._id, title: t.title, doer: dn, assigner: t.assignerId && t.assignerId.name, at: c.at, by: cn, role: c.byRole, oldDeadline: c.oldDeadline, newDeadline: c.newDeadline, days, reason: c.reason, note: c.reasonNote, shortened: c.shortened });
      }
    }
    // Scoring both ways: finished late against the ORIGINAL date vs against the final date
    const done = await m.DelegationTask.find({ tenantId, status: { $in: ['Completed', 'Verified'] }, originalDeadline: { $ne: null } })
      .select('doerId deadline originalDeadline history').populate('doerId', 'name').lean();
    const honest = {};
    for (const t of done) {
      const h = [...(t.history || [])].reverse().find((x) => x.action === 'Completed' || x.action === 'Verified');
      const at = h ? new Date(h.timestamp) : null;
      if (!at || at < from || at >= to) continue;
      const dn = (t.doerId && t.doerId.name) || 'Unknown';
      const r = honest[dn] || (honest[dn] = { name: dn, finished: 0, lateVsFinal: 0, lateVsOriginal: 0 });
      r.finished++;
      if (at > new Date(t.deadline)) r.lateVsFinal++;
      if (at > new Date(t.originalDeadline)) r.lateVsOriginal++;
    }
    res.json({
      honest: Object.values(honest).sort((a, b) => (b.lateVsOriginal - b.lateVsFinal) - (a.lateVsOriginal - a.lateVsFinal)),
      total, shortened,
      perDoer: Object.values(byDoer).map((d) => ({ ...d, tasks: d.tasks.size })).sort((a, b) => b.changes - a.changes),
      perChanger: Object.values(byChanger).sort((a, b) => b.changes - a.changes),
      perReason: Object.entries(byReason).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      rows: rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 500),
    });
  } catch (e) { res.status(500).json({ message: 'Could not build the report.', error: e.message }); }
};
