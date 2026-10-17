// controllers/personalTaskController.js
// Private personal tasks / checklists ("Personal Tasks" tab).
// PRIVACY RULES (enforced here, nowhere else reads this collection):
//   * every query is scoped to the caller's own id - Admins get no extra access
//   * sharing is read-only and only to assigners that have the caller in their mapped doers
const mongoose = require('mongoose');
const moment = require('moment');
const { calculateNextDate } = require('../utils/scheduler');
const personalSchema = require('../models/PersonalTask').schema;
const employeeModel = require('../models/Employee');
const Tenant = require('../models/Tenant');

const OID = (v) => mongoose.Types.ObjectId.isValid(v);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const FREQS = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Interval'];

function models(req) {
  const db = req.db || null;
  const get = (name, schema, fallback) => {
    if (!db) return fallback;
    return db.models[name] || db.model(name, schema);
  };
  return {
    PersonalTask: get('PersonalTask', personalSchema, require('../models/PersonalTask')),
    Employee: db ? (db.models.Employee || db.model('Employee', employeeModel.schema)) : employeeModel,
  };
}

const me = (req) => String(req.user?.id || '');
const tenantOf = (req) => String(req.user?.tenantId || '');
const todayOf = (req) => (YMD.test(String(req.query?.today || req.body?.today || '')) ? String(req.query?.today || req.body?.today) : moment().format('YYYY-MM-DD'));
const nextAfter = (freq, cfg, baseYmd, initial) =>
  moment(calculateNextDate(freq, cfg, [], moment(baseYmd, 'YYYY-MM-DD').toDate(), initial, [])).format('YYYY-MM-DD');

function cleanConfig(freq, c = {}) {
  const ints = (a, lo, hi) => [...new Set((Array.isArray(a) ? a : []).map(Number).filter((n) => Number.isInteger(n) && n >= lo && n <= hi))].sort((x, y) => x - y);
  return {
    daysOfWeek: freq === 'Weekly' ? ints(c.daysOfWeek, 0, 6) : [],
    daysOfMonth: freq === 'Monthly' ? ints(c.daysOfMonth, 1, 31) : [],
    intervalDays: freq === 'Interval' ? Math.min(365, Math.max(1, parseInt(c.intervalDays, 10) || 1)) : 0,
  };
}

// What the owner (or a viewing assigner) sees for one item.
function shape(t, today, { forOwner = true } = {}) {
  const o = {
    _id: t._id, type: t.type, title: t.title, notes: t.notes, priority: t.priority,
    dueDate: t.dueDate, done: t.done, doneAt: t.doneAt,
    frequency: t.frequency, frequencyConfig: t.frequencyConfig, startDate: t.startDate,
    nextDueDate: t.nextDueDate, lastDoneDate: t.lastDoneDate, doneCount: t.doneCount,
    order: t.order, createdAt: t.createdAt,
  };
  if (t.type === 'Checklist') {
    o.dueNow = !!t.nextDueDate && t.nextDueDate <= today;
    o.doneToday = t.lastDoneDate === today;
  } else {
    o.overdue = !t.done && !!t.dueDate && t.dueDate < today;
  }
  if (forOwner) o.sharedWith = t.sharedWith || [];
  return o;
}


// Super-admin on/off switch (Tenant.superAdmin.features.personalTasks). Missing = on, so existing
// companies keep working until the switch is turned off. Cached briefly to avoid a lookup per request.
const flagCache = new Map();
exports.requireEnabled = async (req, res, next) => {
  try {
    const tid = tenantOf(req);
    if (!tid) return next();
    const hit = flagCache.get(tid);
    let on;
    if (hit && hit.exp > Date.now()) on = hit.on;
    else {
      const t = await Tenant.findById(tid).select('superAdmin.features.personalTasks').lean();
      on = t?.superAdmin?.features?.personalTasks !== false;
      flagCache.set(tid, { on, exp: Date.now() + 30 * 1000 });
    }
    if (!on) return res.status(403).json({ message: 'Personal Tasks is switched off for your company.', disabled: true });
    next();
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.listMine = async (req, res) => {
  try {
    const { PersonalTask } = models(req);
    const today = todayOf(req);
    const rows = await PersonalTask.find({ tenantId: tenantOf(req), ownerId: me(req) }).sort({ order: 1, createdAt: -1 }).lean();
    res.json(rows.map((t) => shape(t, today)));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.create = async (req, res) => {
  try {
    const { PersonalTask } = models(req);
    const b = req.body || {};
    const type = b.type === 'Checklist' ? 'Checklist' : 'Task';
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ message: 'Please enter a title.' });
    const today = todayOf(req);
    const doc = {
      tenantId: tenantOf(req), ownerId: me(req), type, title: title.slice(0, 200),
      notes: String(b.notes || '').slice(0, 2000),
      priority: ['Low', 'Medium', 'High'].includes(b.priority) ? b.priority : 'Medium',
    };
    if (type === 'Task') {
      if (b.dueDate) { if (!YMD.test(b.dueDate)) return res.status(400).json({ message: 'Invalid due date.' }); doc.dueDate = b.dueDate; }
    } else {
      if (!FREQS.includes(b.frequency)) return res.status(400).json({ message: 'Please choose how often it repeats.' });
      doc.frequency = b.frequency;
      doc.frequencyConfig = cleanConfig(b.frequency, b.frequencyConfig);
      if (b.frequency === 'Weekly' && !doc.frequencyConfig.daysOfWeek.length) return res.status(400).json({ message: 'Pick at least one weekday.' });
      if (b.frequency === 'Monthly' && !doc.frequencyConfig.daysOfMonth.length) return res.status(400).json({ message: 'Pick at least one date of the month.' });
      doc.startDate = YMD.test(b.startDate || '') ? b.startDate : today;
      doc.nextDueDate = nextAfter(doc.frequency, doc.frequencyConfig, doc.startDate, true);
    }
    // New items go to the very top.
    const first = await PersonalTask.findOne({ tenantId: tenantOf(req), ownerId: me(req) }).sort({ order: 1 }).select('order').lean();
    doc.order = first ? first.order - 1 : 0;
    const created = await PersonalTask.create(doc);
    res.status(201).json(shape(created.toObject(), today));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

async function ownItem(req, res) {
  if (!OID(req.params.id)) { res.status(400).json({ message: 'Invalid id.' }); return null; }
  const { PersonalTask } = models(req);
  const t = await PersonalTask.findOne({ _id: req.params.id, tenantId: tenantOf(req), ownerId: me(req) });
  if (!t) { res.status(404).json({ message: 'Not found.' }); return null; }
  return t;
}

exports.update = async (req, res) => {
  try {
    const t = await ownItem(req, res); if (!t) return;
    const b = req.body || {};
    const today = todayOf(req);
    if (b.title !== undefined) { const s = String(b.title).trim(); if (!s) return res.status(400).json({ message: 'Title cannot be empty.' }); t.title = s.slice(0, 200); }
    if (b.notes !== undefined) t.notes = String(b.notes).slice(0, 2000);
    if (b.priority && ['Low', 'Medium', 'High'].includes(b.priority)) t.priority = b.priority;
    if (t.type === 'Task' && b.dueDate !== undefined) {
      if (b.dueDate && !YMD.test(b.dueDate)) return res.status(400).json({ message: 'Invalid due date.' });
      t.dueDate = b.dueDate || '';
    }
    if (t.type === 'Checklist' && (b.frequency || b.frequencyConfig || b.startDate)) {
      const freq = FREQS.includes(b.frequency) ? b.frequency : t.frequency;
      const cfg = cleanConfig(freq, b.frequencyConfig || t.frequencyConfig);
      if (freq === 'Weekly' && !cfg.daysOfWeek.length) return res.status(400).json({ message: 'Pick at least one weekday.' });
      if (freq === 'Monthly' && !cfg.daysOfMonth.length) return res.status(400).json({ message: 'Pick at least one date of the month.' });
      t.frequency = freq; t.frequencyConfig = cfg;
      if (b.startDate && YMD.test(b.startDate)) t.startDate = b.startDate;
      const base = t.startDate && t.startDate > today ? t.startDate : today;
      t.nextDueDate = nextAfter(freq, cfg, base, true);
    }
    t.updatedAt = new Date();
    await t.save();
    res.json(shape(t.toObject(), today));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Task: set done true/false. Checklist: tick today's run (only when it is due) and move to the next date.
exports.complete = async (req, res) => {
  try {
    const t = await ownItem(req, res); if (!t) return;
    const today = todayOf(req);
    if (t.type === 'Task') {
      const done = req.body?.done === undefined ? !t.done : !!req.body.done;
      t.done = done; t.doneAt = done ? new Date() : undefined;
    } else {
      if (!t.nextDueDate || t.nextDueDate > today) return res.status(400).json({ message: 'This checklist is not due yet.' });
      t.history.push({ instanceDate: t.nextDueDate, completedAt: new Date() });
      if (t.history.length > 400) t.history = t.history.slice(-400);
      t.lastDoneDate = today; t.doneCount = (t.doneCount || 0) + 1;
      // Missed days do not pile up: continue from today, not from an old due date.
      const base = t.nextDueDate > today ? t.nextDueDate : today;
      t.nextDueDate = nextAfter(t.frequency, t.frequencyConfig, base, false);
    }
    t.updatedAt = new Date();
    await t.save();
    res.json(shape(t.toObject(), today));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.remove = async (req, res) => {
  try {
    const t = await ownItem(req, res); if (!t) return;
    await t.deleteOne();
    res.json({ message: 'Deleted.' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Body: { orderedIds: [...] } - the owner's full visible order, top first. Only the owner's own items are touched.
exports.reorder = async (req, res) => {
  try {
    const { PersonalTask } = models(req);
    const ids = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.filter(OID) : [];
    if (!ids.length) return res.status(400).json({ message: 'Nothing to reorder.' });
    const ops = ids.map((id, i) => ({ updateOne: { filter: { _id: id, tenantId: tenantOf(req), ownerId: me(req) }, update: { $set: { order: i } } } }));
    await PersonalTask.bulkWrite(ops);
    res.json({ message: 'Order saved.' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// People this user may share with = assigners who have this user in their mapped doers.
exports.shareOptions = async (req, res) => {
  try {
    const { Employee } = models(req);
    if (!OID(me(req))) return res.json([]);
    const rows = await Employee.find({ tenantId: tenantOf(req), managedDoers: me(req), _id: { $ne: me(req) } }).select('name roles role department').lean();
    res.json(rows.map((r) => ({ _id: r._id, name: r.name, department: r.department || '' })));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.setShare = async (req, res) => {
  try {
    const t = await ownItem(req, res); if (!t) return;
    const { Employee } = models(req);
    const want = (Array.isArray(req.body?.sharedWith) ? req.body.sharedWith : []).filter(OID).map(String);
    let allowed = [];
    if (want.length && OID(me(req))) {
      const rows = await Employee.find({ tenantId: tenantOf(req), _id: { $in: want }, managedDoers: me(req) }).select('_id').lean();
      allowed = rows.map((r) => String(r._id));
    }
    if (allowed.length !== want.length) return res.status(403).json({ message: 'You can only share with the assigners mapped to you.' });
    t.sharedWith = allowed; t.updatedAt = new Date();
    await t.save();
    res.json({ sharedWith: t.sharedWith });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Items other people shared with me. Read-only. Re-checks the mapping every time so
// removing the mapping instantly hides the items.
exports.sharedWithMe = async (req, res) => {
  try {
    const { PersonalTask, Employee } = models(req);
    if (!OID(me(req))) return res.json([]);
    const today = todayOf(req);
    const mine = await Employee.findById(me(req)).select('managedDoers').lean();
    const mapped = new Set((mine?.managedDoers || []).map(String));
    if (!mapped.size) return res.json([]);
    const rows = await PersonalTask.find({ tenantId: tenantOf(req), sharedWith: me(req), ownerId: { $in: [...mapped] } }).sort({ order: 1, createdAt: -1 }).lean();
    const owners = await Employee.find({ _id: { $in: [...new Set(rows.map((r) => String(r.ownerId)))] } }).select('name').lean();
    const nameOf = Object.fromEntries(owners.map((o) => [String(o._id), o.name]));
    res.json(rows.map((t) => ({ ...shape(t, today, { forOwner: false }), ownerId: t.ownerId, ownerName: nameOf[String(t.ownerId)] || 'Team member' })));
  } catch (e) { res.status(500).json({ message: e.message }); }
};
