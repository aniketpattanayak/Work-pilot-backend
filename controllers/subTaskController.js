// controllers/subTaskController.js
// Sub tasks: a person who is both Doer and Assigner splits a task of their own and gives parts of it
// to people from their Doer Mapping. A sub task is an ordinary delegation task (so scoring, completion,
// WhatsApp and history all work as usual) that remembers which main task it belongs to.
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const { notifyTenant } = require('../utils/notify');
const { isOn } = require('../utils/settingsRegistry');
const D = require('../utils/dateChanges');

const safe = (db, name, fallback) => { if (!db) return fallback; try { return db.model(name); } catch (e) { return fallback; } };
const modelsOf = (req) => ({
  DelegationTask: safe(req.db, 'DelegationTask', require('../models/DelegationTask')),
  ChecklistTask:  safe(req.db, 'ChecklistTask', require('../models/ChecklistTask')),
  FlowInstance:   safe(req.db, 'FlowInstance', require('../models/FlowInstance')),
  Employee:       safe(req.db, 'Employee', require('../models/Employee')),
});
const TYPES = ['Delegation', 'Checklist', 'FMS'];
const oid = (x) => String((x && x._id) || x || '');
const isAdminReq = (req) => !!(req.user && req.user.isSuperAdmin) || (Array.isArray(req.user && req.user.roles) && req.user.roles.includes('Admin'));

// What a main task looks like for the rules: who does it, who gave it, its deadline, whether it is open
async function describeParent(m, type, id) {
  if (type === 'Delegation') {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const t = await m.DelegationTask.findById(id).lean();
    return t && { tenantId: t.tenantId, title: t.title, doerId: oid(t.doerId), assignerId: oid(t.assignerId), deadline: t.deadline, open: !['Completed', 'Verified'].includes(t.status), key: '' };
  }
  if (type === 'Checklist') {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const t = await m.ChecklistTask.findById(id).lean();
    return t && { tenantId: t.tenantId, title: t.taskName, doerId: oid(t.doerId), assignerId: oid(t.createdBy), deadline: t.nextDueDate, open: t.status !== 'Paused', key: '' };
  }
  if (type === 'FMS') {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const t = await m.FlowInstance.findById(id).lean();
    return t && { tenantId: t.tenantId, title: `${(t.activeStep && t.activeStep.nodeName) || t.templateName} (#${t.orderIdentifier})`, doerId: oid(t.activeStep && t.activeStep.assignedToId), assignerId: '', deadline: t.activeStep && t.activeStep.plannedDeadline, open: t.status !== 'completed', key: oid(t.activeStep && t.activeStep.nodeId) };
  }
  return null;
}

// POST /api/tasks/sub-task  { parentType, parentId, title, description, receiverId, deadline, priority }
exports.createSubTask = async (req, res) => {
  try {
    const m = modelsOf(req);
    const me = oid(req.user && req.user.id);
    const b = req.body || {};
    const tenant = await Tenant.findById(req.user.tenantId).lean();
    if (!isOn(tenant, 'tasks_subTasks')) return res.status(403).json({ message: 'Your company has switched off sub tasks.' });
    if (!TYPES.includes(b.parentType)) return res.status(400).json({ message: 'Unknown main task type.' });
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ message: 'Please write the sub task name.' });
    if (title.length > 200) return res.status(400).json({ message: 'The sub task name is too long.' });
    if (!mongoose.Types.ObjectId.isValid(b.receiverId)) return res.status(400).json({ message: 'Please choose who gets the sub task.' });
    const dl = new Date(b.deadline);
    if (!b.deadline || isNaN(dl.getTime())) return res.status(400).json({ message: 'Please choose the deadline.' });

    const creator = await m.Employee.findById(me).select('name roles managedDoers tenantId').lean();
    if (!creator) return res.status(403).json({ message: 'Not allowed.' });
    const roles = creator.roles || [];
    if (!(roles.includes('Doer') && roles.includes('Assigner'))) return res.status(403).json({ message: 'Only a person who is both Doer and Assigner can create sub tasks.' });

    const parent = await describeParent(m, b.parentType, b.parentId);
    if (!parent) return res.status(404).json({ message: 'Main task not found.' });
    if (String(parent.tenantId) !== String(req.user.tenantId)) return res.status(403).json({ message: 'Not allowed.' });
    if (parent.doerId !== me) return res.status(403).json({ message: 'You can only split a task that is assigned to you.' });
    if (!parent.open) return res.status(400).json({ message: 'The main task is already finished.' });
    // Sub tasks only for tasks scheduled today or later (Indian date)
    if (b.parentType !== 'FMS' && parent.deadline) {
      const istDay = (d) => new Date(new Date(d).getTime() + 19800000).toISOString().slice(0, 10);
      if (istDay(parent.deadline) < istDay(new Date())) return res.status(400).json({ message: 'This task is scheduled for a past date, so a sub task cannot be added to it.' });
    }

    if (!(creator.managedDoers || []).map(String).includes(String(b.receiverId))) return res.status(403).json({ message: 'You can only give a sub task to people in your Doer Mapping.' });
    if (String(b.receiverId) === me) return res.status(400).json({ message: 'Choose someone other than yourself.' });
    const receiver = await m.Employee.findById(b.receiverId).select('name whatsappNumber tenantId').lean();
    if (!receiver || String(receiver.tenantId) !== String(req.user.tenantId)) return res.status(404).json({ message: 'That person was not found.' });

    const cf = await require('../utils/customFields').validateForEntity(req, 'subtask', b.customFields, 'create', req.user.tenantId);
    if (cf.errors.length) return res.status(400).json({ message: cf.errors[0], errors: cf.errors });
    const prioMap = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
    const priority = prioMap[String(b.priority || 'medium').toLowerCase()] || 'Medium';
    const mainAssigner = parent.assignerId && parent.assignerId !== me && parent.assignerId !== String(b.receiverId) ? parent.assignerId : null;

    const task = new m.DelegationTask({
      tenantId: req.user.tenantId,
      title, description: String(b.description || '').slice(0, 2000),
      assignerId: me, doerId: b.receiverId,
      coworkers: mainAssigner ? [mainAssigner] : [],   // the main task's assigner can see it (watch only)
      priority, deadline: dl, status: 'Accepted',
      isRevisionAllowed: true, maxExtensionDays: 0, followersCanChangeDate: false,
      parentTask: { type: b.parentType, taskId: String(b.parentId), title: parent.title, key: parent.key },
      customFields: cf.values,
      history: [{ action: 'Task Created', performedBy: me, timestamp: new Date(), remarks: `Sub task of "${parent.title}"` }],
    });
    await task.save();

    // Warn (never block) when the sub task ends after the main task
    const warnings = [];
    if (parent.deadline && dl.getTime() > new Date(parent.deadline).getTime()) warnings.push(`This sub task ends after the main task (${D.fmt(parent.deadline)}).`);

    // WhatsApp: the receiver, and the main task's assigner (not the creator)
    try {
      const link = `https://${(tenant && tenant.subdomain) || 'portal'}.lrbcloud.ai/dashboard/my-tasks`;
      if (receiver.whatsappNumber) await notifyTenant(req.user.tenantId, receiver.whatsappNumber, { templateName: 'subtask_assigned', variables: [receiver.name, title, parent.title, creator.name, D.fmt(dl), link].map(String) });
      if (mainAssigner) {
        const ma = await m.Employee.findById(mainAssigner).select('name whatsappNumber').lean();
        if (ma && ma.whatsappNumber) await notifyTenant(req.user.tenantId, ma.whatsappNumber, { templateName: 'subtask_created_info', variables: [ma.name, title, parent.title, receiver.name, link].map(String) });
      }
    } catch (e) { console.error('[subtask] WhatsApp failed:', e.message); }

    res.status(201).json({ message: 'Sub task created.', task, warnings });
  } catch (e) { console.error('createSubTask error:', e.message); res.status(500).json({ message: 'Could not create the sub task.', error: e.message }); }
};

// GET /api/tasks/sub-tasks?parentType=&parentId=  : everyone who may see the main task sees its sub tasks
exports.listSubTasks = async (req, res) => {
  try {
    const m = modelsOf(req);
    const { parentType, parentId } = req.query;
    if (!TYPES.includes(parentType) || !parentId) return res.status(400).json({ message: 'Send parentType and parentId.' });
    const me = oid(req.user && req.user.id);
    const parent = await describeParent(m, parentType, parentId);
    if (!parent) return res.status(404).json({ message: 'Main task not found.' });
    if (String(parent.tenantId) !== String(req.user.tenantId)) return res.status(403).json({ message: 'Not allowed.' });
    const list = await m.DelegationTask.find({ tenantId: req.user.tenantId, 'parentTask.type': parentType, 'parentTask.taskId': String(parentId) })
      .populate('doerId assignerId', 'name').sort({ createdAt: 1 }).lean();
    const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
    const mayAll = isAdminReq(req) || roles.includes('Coordinator') || parent.doerId === me || parent.assignerId === me;
    const out = list.filter((t) => mayAll || oid(t.doerId) === me || oid(t.assignerId) === me);
    res.json({ subTasks: out.map((t) => ({ _id: t._id, title: t.title, status: t.status, deadline: t.deadline, doer: t.doerId && t.doerId.name, doerId: oid(t.doerId), assigner: t.assignerId && t.assignerId.name, priority: t.priority, createdAt: t.createdAt })) });
  } catch (e) { res.status(500).json({ message: 'Could not load sub tasks.', error: e.message }); }
};

// POST /api/tasks/sub-tasks/summary  { parentType, ids: [] } -> { [id]: { total, done } }  (for the small badge in lists)
exports.summary = async (req, res) => {
  try {
    const m = modelsOf(req);
    const { parentType } = req.body || {};
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String).slice(0, 500) : [];
    if (!TYPES.includes(parentType) || !ids.length) return res.json({ summary: {} });
    const me = oid(req.user && req.user.id);
    const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
    const all = isAdminReq(req) || roles.includes('Coordinator');
    const q = { tenantId: req.user.tenantId, 'parentTask.type': parentType, 'parentTask.taskId': { $in: ids } };
    const list = await m.DelegationTask.find(q).select('parentTask status doerId assignerId coworkers').lean();
    const out = {};
    for (const t of list) {
      // only count sub tasks this person is on (doer, giver or follower); admins and coordinators see all
      if (!all && ![oid(t.doerId), oid(t.assignerId), ...(t.coworkers || []).map(oid)].includes(me)) continue;
      const k = t.parentTask.taskId;
      const r = out[k] || (out[k] = { total: 0, done: 0 });
      r.total++; if (['Completed', 'Verified'].includes(t.status)) r.done++;
    }
    res.json({ summary: out });
  } catch (e) { res.status(500).json({ message: 'Could not load the summary.', error: e.message }); }
};
