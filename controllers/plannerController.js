// controllers/plannerController.js
// "Planner" tab: private plans made of ordered steps; a step can become a real task.
// PRIVACY: every query is scoped to the caller's own id (Admins get no extra access).
// The module is OFF until the platform owner switches Tenant.superAdmin.features.planner on.
const mongoose = require('mongoose');
const planSchema = require('../models/Plan').schema;
const delegationSchema = require('../models/DelegationTask').schema;
const checklistSchema = require('../models/ChecklistTask').schema;
const Tenant = require('../models/Tenant');

const OID = (v) => mongoose.Types.ObjectId.isValid(v);
const PRIORITIES = ['Low', 'Medium', 'High'];
const KINDS = ['Delegation', 'Checklist'];

function models(req) {
  const db = req.db || null;
  const get = (name, schema, fallback) => (db ? (db.models[name] || db.model(name, schema)) : fallback);
  return {
    Plan: get('Plan', planSchema, require('../models/Plan')),
    DelegationTask: get('DelegationTask', delegationSchema, require('../models/DelegationTask')),
    ChecklistTask: get('ChecklistTask', checklistSchema, require('../models/ChecklistTask')),
  };
}
const me = (req) => String(req.user?.id || '');
const tenantOf = (req) => String(req.user?.tenantId || '');
const mine = (req) => ({ tenantId: tenantOf(req), ownerId: me(req) });
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

const flagCache = new Map();
exports.requireEnabled = async (req, res, next) => {
  try {
    const tid = tenantOf(req);
    if (!tid) return res.status(403).json({ message: 'Planner is not available.', disabled: true });
    const hit = flagCache.get(tid);
    let on;
    if (hit && hit.exp > Date.now()) on = hit.on;
    else {
      const t = await Tenant.findById(tid).select('superAdmin.features.planner').lean();
      on = t?.superAdmin?.features?.planner === true;   // off unless the platform owner switched it on
      flagCache.set(tid, { on, exp: Date.now() + 30 * 1000 });
    }
    if (!on) return res.status(403).json({ message: 'Planner is switched off for your company.', disabled: true });
    next();
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Used by createTask / createChecklistTask: keep planId only when it is the caller's own plan. */
exports.validPlanFor = async (req, planId) => {
  try {
    if (!planId || !OID(planId)) return null;
    const { Plan } = models(req);
    const p = await Plan.findOne({ _id: planId, ...mine(req) }).select('_id').lean();
    return p ? String(p._id) : null;
  } catch (e) { return null; }
};

// One plan with live status of the tasks its steps became.
async function shapePlans(req, plans) {
  const { DelegationTask, ChecklistTask } = models(req);
  const dIds = []; const cIds = [];
  plans.forEach((p) => p.steps.forEach((s) => { if (s.taskId) (s.taskType === 'Checklist' ? cIds : dIds).push(s.taskId); }));
  const [ds, cs] = await Promise.all([
    dIds.length ? DelegationTask.find({ _id: { $in: dIds }, tenantId: tenantOf(req) }).select('status deadline doerId title').populate('doerId', 'name').lean() : [],
    cIds.length ? ChecklistTask.find({ _id: { $in: cIds }, tenantId: tenantOf(req) }).select('status nextDueDate frequency doerId taskName').populate('doerId', 'name').lean() : [],
  ]);
  const dm = new Map(ds.map((t) => [String(t._id), t])); const cm = new Map(cs.map((t) => [String(t._id), t]));
  return plans.map((p) => {
    const o = p.toObject ? p.toObject() : p;
    o.steps = (o.steps || []).map((s) => {
      if (!s.taskId) return { ...s, state: 'Planned' };
      const t = s.taskType === 'Checklist' ? cm.get(String(s.taskId)) : dm.get(String(s.taskId));
      if (!t) return { ...s, state: 'Task removed', taskGone: true };
      return s.taskType === 'Checklist'
        ? { ...s, state: t.status || 'Active', due: t.nextDueDate, frequency: t.frequency, doerName: t.doerId && t.doerId.name, done: false }
        : { ...s, state: t.status, due: t.deadline, doerName: t.doerId && t.doerId.name, done: ['Completed', 'Verified'].includes(t.status) };
    });
    return o;
  });
}

exports.list = async (req, res) => {
  try {
    const { Plan } = models(req);
    const plans = await Plan.find(mine(req)).sort({ order: 1, createdAt: -1 });
    res.json(await shapePlans(req, plans));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.create = async (req, res) => {
  try {
    const { Plan } = models(req);
    const title = clip(req.body.title, 200);
    if (!title) return res.status(400).json({ message: 'Please give the plan a name.' });
    const lt = req.body.linkedTask || {};
    const linkedTask = (OID(lt.taskId) && KINDS.includes(lt.taskType)) ? { taskType: lt.taskType, taskId: lt.taskId, title: clip(lt.title, 200) } : { taskType: '', title: '' };
    const first = await Plan.findOne(mine(req)).sort({ order: 1 }).select('order').lean();
    const plan = await Plan.create({ ...mine(req), title, notes: clip(req.body.notes, 2000), linkedTask, order: first ? (first.order || 0) - 1 : 0 });
    res.status(201).json((await shapePlans(req, [plan]))[0]);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

const findMine = async (req) => {
  if (!OID(req.params.id)) return null;
  const { Plan } = models(req);
  return Plan.findOne({ _id: req.params.id, ...mine(req) });
};

exports.update = async (req, res) => {
  try {
    const plan = await findMine(req); if (!plan) return res.status(404).json({ message: 'Plan not found.' });
    if (req.body.title !== undefined) { const t = clip(req.body.title, 200); if (!t) return res.status(400).json({ message: 'Please give the plan a name.' }); plan.title = t; }
    if (req.body.notes !== undefined) plan.notes = clip(req.body.notes, 2000);
    if (req.body.linkedTask !== undefined) {
      const lt = req.body.linkedTask || {};
      plan.linkedTask = (OID(lt.taskId) && KINDS.includes(lt.taskType)) ? { taskType: lt.taskType, taskId: lt.taskId, title: clip(lt.title, 200) } : { taskType: '', title: '' };
    }
    plan.updatedAt = new Date(); await plan.save();
    res.json((await shapePlans(req, [plan]))[0]);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.remove = async (req, res) => {
  try {
    const plan = await findMine(req); if (!plan) return res.status(404).json({ message: 'Plan not found.' });
    const { DelegationTask, ChecklistTask } = models(req);
    // The real tasks stay; they just go back to the normal lists.
    await Promise.all([
      DelegationTask.updateMany({ planId: plan._id, tenantId: tenantOf(req) }, { $unset: { planId: '', planStepId: '' } }),
      ChecklistTask.updateMany({ planId: plan._id, tenantId: tenantOf(req) }, { $unset: { planId: '', planStepId: '' } }),
    ]);
    await plan.deleteOne();
    res.json({ message: 'Plan deleted. Tasks made from it were kept.' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.reorderPlans = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.orderedIds) ? req.body.orderedIds.filter(OID) : [];
    const { Plan } = models(req);
    await Promise.all(ids.map((id, i) => Plan.updateOne({ _id: id, ...mine(req) }, { $set: { order: i } })));
    res.json({ message: 'Saved.' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.addStep = async (req, res) => {
  try {
    const plan = await findMine(req); if (!plan) return res.status(404).json({ message: 'Plan not found.' });
    const title = clip(req.body.title, 200);
    if (!title) return res.status(400).json({ message: 'Please type the step.' });
    if (plan.steps.length >= 100) return res.status(400).json({ message: 'A plan can have up to 100 steps.' });
    plan.steps.push({
      title, notes: clip(req.body.notes, 2000),
      priority: PRIORITIES.includes(req.body.priority) ? req.body.priority : 'Medium',
      kind: KINDS.includes(req.body.kind) ? req.body.kind : 'Delegation',
    });
    plan.updatedAt = new Date(); await plan.save();
    res.status(201).json((await shapePlans(req, [plan]))[0]);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.updateStep = async (req, res) => {
  try {
    const plan = await findMine(req); if (!plan) return res.status(404).json({ message: 'Plan not found.' });
    const s = plan.steps.id(req.params.stepId); if (!s) return res.status(404).json({ message: 'Step not found.' });
    if (req.body.title !== undefined) { const t = clip(req.body.title, 200); if (!t) return res.status(400).json({ message: 'Please type the step.' }); s.title = t; }
    if (req.body.notes !== undefined) s.notes = clip(req.body.notes, 2000);
    if (PRIORITIES.includes(req.body.priority)) s.priority = req.body.priority;
    if (KINDS.includes(req.body.kind) && !s.taskId) s.kind = req.body.kind;   // type is fixed once a task exists
    plan.updatedAt = new Date(); await plan.save();
    res.json((await shapePlans(req, [plan]))[0]);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.removeStep = async (req, res) => {
  try {
    const plan = await findMine(req); if (!plan) return res.status(404).json({ message: 'Plan not found.' });
    const s = plan.steps.id(req.params.stepId); if (!s) return res.status(404).json({ message: 'Step not found.' });
    if (s.taskId) {
      const { DelegationTask, ChecklistTask } = models(req);
      const M = s.taskType === 'Checklist' ? ChecklistTask : DelegationTask;
      await M.updateOne({ _id: s.taskId, tenantId: tenantOf(req) }, { $unset: { planId: '', planStepId: '' } });
    }
    s.deleteOne(); plan.updatedAt = new Date(); await plan.save();
    res.json((await shapePlans(req, [plan]))[0]);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.reorderSteps = async (req, res) => {
  try {
    const plan = await findMine(req); if (!plan) return res.status(404).json({ message: 'Plan not found.' });
    const ids = Array.isArray(req.body.orderedIds) ? req.body.orderedIds.map(String) : [];
    const byId = new Map(plan.steps.map((s) => [String(s._id), s]));
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    plan.steps.forEach((s) => { if (!ids.includes(String(s._id))) next.push(s); });   // never lose a step
    plan.steps = next; plan.updatedAt = new Date(); await plan.save();
    res.json((await shapePlans(req, [plan]))[0]);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// After the app created the real task (with planId + planStepId) it links it back to the step.
exports.linkStep = async (req, res) => {
  try {
    const plan = await findMine(req); if (!plan) return res.status(404).json({ message: 'Plan not found.' });
    const s = plan.steps.id(req.params.stepId); if (!s) return res.status(404).json({ message: 'Step not found.' });
    if (s.taskId) return res.status(409).json({ message: 'This step already has a task.' });
    const taskType = KINDS.includes(req.body.taskType) ? req.body.taskType : null;
    if (!taskType || !OID(req.body.taskId)) return res.status(400).json({ message: 'Missing task.' });
    const { DelegationTask, ChecklistTask } = models(req);
    const M = taskType === 'Checklist' ? ChecklistTask : DelegationTask;
    const t = await M.findOne({ _id: req.body.taskId, tenantId: tenantOf(req), planId: plan._id }).select('_id').lean();
    if (!t) return res.status(404).json({ message: 'That task was not created from this plan.' });
    s.taskId = t._id; s.taskType = taskType; s.kind = taskType;
    await M.updateOne({ _id: t._id }, { $set: { planStepId: s._id } });
    plan.updatedAt = new Date(); await plan.save();
    res.json((await shapePlans(req, [plan]))[0]);
  } catch (e) { res.status(500).json({ message: e.message }); }
};
