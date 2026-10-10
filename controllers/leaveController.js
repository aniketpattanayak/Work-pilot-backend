// controllers/leaveController.js
// Leave management: leave types, balances, requests, approvals, adjustments, team calendar.
// Every route is behind requirePermission (see routes). Rules live in utils/leaveEngine.js.
const mongoose = require('mongoose');
const E = require('../utils/leaveEngine');

const IST = 330 * 60 * 1000;
const todayIST = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const oid = (v) => String(v && v._id ? v._id : v);
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;

const model = (req, name) => {
  const m = require('../models/' + name);
  return req.db ? (req.db.models[name] || req.db.model(name, m.schema)) : m;
};
const empModel = (req) => (req.db ? req.db.model('Employee') : require('../models/Employee'));
const tenantId = (req) => req.user.tenantId;

async function audit(req, action, description, extra) {
  try {
    const ActivityLog = require('../models/ActivityLog');
    await ActivityLog.create({
      tenantId: tenantId(req), employeeId: req.user.id, employeeName: (req.actor && req.actor.name) || '', employeeRole: (req.user.roles || []).join(', '),
      action, description, metadata: { ip: req.ip || '', extra: extra || {} }
    });
  } catch (e) { console.error('[Leave] audit failed:', e.message); }
}

// Company calendar facts used to count leave days
async function companyInfo(req) {
  const Tenant = require('../models/Tenant');
  const t = await Tenant.findById(tenantId(req)).select('weekends holidays leaveConfig').lean();
  const cfg = (t && t.leaveConfig) || {};
  return {
    weekends: Array.isArray(t && t.weekends) ? t.weekends : [0],
    holidays: new Set(((t && t.holidays) || []).filter((h) => h && h.date).map((h) => new Date(h.date).toISOString().slice(0, 10))),
    startMonth: Number.isInteger(cfg.yearStartMonth) && cfg.yearStartMonth >= 1 && cfg.yearStartMonth <= 12 ? cfg.yearStartMonth : 1,
    allowSelfApproval: !!cfg.allowSelfApproval
  };
}

const joinDateOf = (emp) => {
  const d = emp.joiningDate || emp.createdAt;
  return d ? new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10) : null;
};

// ---- who is inside a permission's reach -------------------------------------------------
// Returns null for "everyone in the company", else a Set of employee id strings.
async function reachIds(req, key) {
  const scope = (req.permissions || {})[key];
  if (!scope) return new Set();
  if (scope === 'company') return null;
  const me = req.actor || {};
  const mine = oid(req.user.id);
  if (scope === 'self') return new Set([mine]);
  if (scope === 'team') return new Set([mine, ...(me.managedDoers || []).map(oid), ...(me.managedAssigners || []).map(oid)]);
  const field = scope === 'department' ? 'department' : 'location';
  if (!me[field]) return new Set([mine]);
  const peers = await empModel(req).find({ tenantId: tenantId(req), [field]: me[field] }).select('_id').lean();
  return new Set([mine, ...peers.map((p) => oid(p._id))]);
}
const inReach = (set, id) => set === null || set.has(oid(id));

// ---- leave types ---------------------------------------------------------------------
function readTypeBody(b) {
  const name = String((b && b.name) || '').trim();
  if (name.length < 2 || name.length > 40) return { error: 'Leave type name must be 2 to 40 characters.' };
  const num = (v, min, max, label) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`); return n; };
  try {
    const unlimited = !!b.unlimited;
    const accrual = b.accrual === 'upfront' ? 'upfront' : 'monthly';
    return {
      value: {
        name, paid: b.paid !== false, unlimited, accrual,
        annualQuota: unlimited ? 0 : num(b.annualQuota ?? 0, 0, 366, 'Yearly days'),
        carryForwardMax: unlimited ? 0 : num(b.carryForwardMax ?? 0, 0, 366, 'Carry forward'),
        maxNegative: unlimited ? 0 : num(b.maxNegative ?? 0, 0, 366, 'Allowed negative balance'),
        halfDayAllowed: b.halfDayAllowed !== false,
        maxConsecutiveDays: num(b.maxConsecutiveDays ?? 0, 0, 366, 'Maximum days at a time'),
        minNoticeDays: num(b.minNoticeDays ?? 0, 0, 365, 'Notice days'),
        backdateDays: num(b.backdateDays ?? 7, 0, 365, 'Days back allowed'),
        sandwich: !!b.sandwich, requiresReason: b.requiresReason !== false, active: b.active !== false
      }
    };
  } catch (e) { return { error: e.message }; }
}

exports.listTypes = async (req, res) => {
  try {
    const { LeaveType } = { LeaveType: model(req, 'LeaveType') };
    const q = { tenantId: tenantId(req) };
    const showAll = req.query.all === '1' && (req.permissions || {})['leave.configure'];
    if (!showAll) q.active = true;
    const types = await LeaveType.find(q).sort({ name: 1 }).lean();
    res.json({ types });
  } catch (e) { console.error('[Leave] listTypes', e.message); res.status(500).json({ message: 'Could not load leave types.' }); }
};

exports.createType = async (req, res) => {
  try {
    const LeaveType = model(req, 'LeaveType');
    const r = readTypeBody(req.body || {});
    if (r.error) return res.status(400).json({ message: r.error });
    const all = await LeaveType.find({ tenantId: tenantId(req) }).select('name').lean();
    if (all.length >= 40) return res.status(400).json({ message: 'At most 40 leave types are allowed.' });
    if (all.some((t) => t.name.toLowerCase() === r.value.name.toLowerCase())) return res.status(400).json({ message: 'A leave type with this name already exists.' });
    const type = await LeaveType.create({ ...r.value, tenantId: tenantId(req), createdBy: req.user.id });
    await audit(req, 'leave_type_saved', `Created leave type "${type.name}"`, { typeId: String(type._id) });
    res.status(201).json({ type });
  } catch (e) { console.error('[Leave] createType', e.message); res.status(500).json({ message: 'Could not create the leave type.' }); }
};

exports.updateType = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid leave type.' });
    const LeaveType = model(req, 'LeaveType');
    const r = readTypeBody(req.body || {});
    if (r.error) return res.status(400).json({ message: r.error });
    const cur = await LeaveType.findOne({ _id: req.params.id, tenantId: tenantId(req) }).lean();
    if (!cur) return res.status(404).json({ message: 'Leave type not found.' });
    const all = await LeaveType.find({ tenantId: tenantId(req) }).select('name').lean();
    if (all.some((t) => oid(t._id) !== oid(cur._id) && t.name.toLowerCase() === r.value.name.toLowerCase())) return res.status(400).json({ message: 'A leave type with this name already exists.' });
    await LeaveType.updateOne({ _id: cur._id }, { $set: r.value });
    await audit(req, 'leave_type_saved', `Changed leave type "${r.value.name}"`, { typeId: oid(cur._id) });
    res.json({ type: { ...cur, ...r.value } });
  } catch (e) { console.error('[Leave] updateType', e.message); res.status(500).json({ message: 'Could not save the leave type.' }); }
};

exports.deleteType = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid leave type.' });
    const LeaveType = model(req, 'LeaveType'), LeaveRequest = model(req, 'LeaveRequest'), LeaveAdjustment = model(req, 'LeaveAdjustment');
    const cur = await LeaveType.findOne({ _id: req.params.id, tenantId: tenantId(req) }).lean();
    if (!cur) return res.status(404).json({ message: 'Leave type not found.' });
    const used = (await LeaveRequest.countDocuments({ tenantId: tenantId(req), leaveTypeId: cur._id })) + (await LeaveAdjustment.countDocuments({ tenantId: tenantId(req), leaveTypeId: cur._id }));
    if (used > 0) return res.status(400).json({ message: 'This leave type has been used, so it cannot be deleted. Switch it to inactive instead; history stays.' });
    await LeaveType.deleteOne({ _id: cur._id });
    await audit(req, 'leave_type_saved', `Deleted leave type "${cur.name}"`, { typeId: oid(cur._id) });
    res.json({ message: 'Leave type deleted.' });
  } catch (e) { res.status(500).json({ message: 'Could not delete the leave type.' }); }
};

// ---- settings ------------------------------------------------------------------------
exports.getConfig = async (req, res) => {
  try {
    const c = await companyInfo(req);
    res.json({ yearStartMonth: c.startMonth, allowSelfApproval: c.allowSelfApproval, weekends: c.weekends, holidayCount: c.holidays.size });
  } catch (e) { res.status(500).json({ message: 'Could not load settings.' }); }
};

exports.setConfig = async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const m = Number(req.body && req.body.yearStartMonth);
    if (!Number.isInteger(m) || m < 1 || m > 12) return res.status(400).json({ message: 'Choose the month the leave year starts (1 to 12).' });
    const allowSelfApproval = !!(req.body && req.body.allowSelfApproval);
    await Tenant.updateOne({ _id: tenantId(req) }, { $set: { 'leaveConfig.yearStartMonth': m, 'leaveConfig.allowSelfApproval': allowSelfApproval } });
    await audit(req, 'leave_type_saved', 'Changed leave settings', { yearStartMonth: m, allowSelfApproval });
    res.json({ yearStartMonth: m, allowSelfApproval });
  } catch (e) { res.status(500).json({ message: 'Could not save settings.' }); }
};

// ---- balances ------------------------------------------------------------------------
async function balancesFor(req, emp, types, company, extra = {}) {
  const LeaveRequest = model(req, 'LeaveRequest'), LeaveAdjustment = model(req, 'LeaveAdjustment');
  const reqs = await LeaveRequest.find({ tenantId: tenantId(req), employeeId: emp._id, status: { $in: ['Approved', 'Pending'] } }).lean();
  const adjs = await LeaveAdjustment.find({ tenantId: tenantId(req), employeeId: emp._id }).lean();
  const asOf = extra.asOf || todayIST();
  return types.map((t) => {
    const b = E.computeBalance({
      type: t, startMonth: company.startMonth, asOf, joinDate: joinDateOf(emp),
      requests: reqs.filter((r) => oid(r.leaveTypeId) === oid(t._id) && !(extra.excludeId && oid(r._id) === extra.excludeId)),
      adjustments: adjs.filter((a) => oid(a.leaveTypeId) === oid(t._id)).map((a) => ({ date: a.date, days: a.days }))
    });
    return { typeId: oid(t._id), name: t.name, paid: t.paid, unlimited: !!t.unlimited, maxNegative: t.maxNegative || 0, ...b };
  });
}

exports.getBalance = async (req, res) => {
  try {
    const Employee = empModel(req);
    const targetId = req.query.employeeId || req.user.id;
    if (!isId(targetId)) return res.status(400).json({ message: 'Invalid person.' });
    if (oid(targetId) !== oid(req.user.id)) {
      const reach = await reachIds(req, 'leave.view');
      if (!inReach(reach, targetId)) return res.status(403).json({ message: 'You do not have permission to see this person\'s leave.' });
    }
    const emp = await Employee.findOne({ _id: targetId, tenantId: tenantId(req) }).select('name createdAt joiningDate').lean();
    if (!emp) return res.status(404).json({ message: 'Person not found.' });
    const types = await model(req, 'LeaveType').find({ tenantId: tenantId(req), active: true }).sort({ name: 1 }).lean();
    const company = await companyInfo(req);
    res.json({ employee: { _id: emp._id, name: emp.name }, asOf: todayIST(), balances: await balancesFor(req, emp, types, company) });
  } catch (e) { console.error('[Leave] getBalance', e.message); res.status(500).json({ message: 'Could not load balances.' }); }
};

// Checks the balance for every leave year a request touches. Returns an error text or null.
async function balanceProblem(req, emp, type, detail, company, excludeId) {
  if (type.unlimited) return null;
  const byYear = new Map();
  detail.forEach((x) => { const y = E.leaveYearOf(x.d, company.startMonth); const cur = byYear.get(y) || { need: 0, last: x.d }; cur.need += x.u; if (x.d > cur.last) cur.last = x.d; byYear.set(y, cur); });
  for (const [, v] of byYear) {
    const [b] = await balancesFor(req, emp, [type], company, { asOf: v.last, excludeId });
    if (b.available + (type.maxNegative || 0) < v.need - 1e-9) {
      return `Not enough ${type.name}: ${b.available} day(s) available, ${v.need} needed.`;
    }
  }
  return null;
}

// ---- requests ------------------------------------------------------------------------
exports.createRequest = async (req, res) => {
  try {
    const LeaveRequest = model(req, 'LeaveRequest'), LeaveType = model(req, 'LeaveType'), Employee = empModel(req);
    const b = req.body || {};
    if (!isId(b.leaveTypeId)) return res.status(400).json({ message: 'Choose a leave type.' });
    const type = await LeaveType.findOne({ _id: b.leaveTypeId, tenantId: tenantId(req), active: true }).lean();
    if (!type) return res.status(400).json({ message: 'This leave type is not available.' });
    const emp = await Employee.findOne({ _id: req.user.id, tenantId: tenantId(req) }).select('name createdAt joiningDate workOnSunday').lean();
    if (!emp) return res.status(404).json({ message: 'Your account was not found.' });
    const company = await companyInfo(req);

    const halfDay = ['first', 'second'].includes(b.halfDay) ? b.halfDay : 'none';
    if (halfDay !== 'none' && !type.halfDayAllowed) return res.status(400).json({ message: `${type.name} cannot be taken as a half day.` });
    const reason = String(b.reason || '').trim().slice(0, 500);
    if (type.requiresReason && reason.length < 3) return res.status(400).json({ message: 'Please write a reason for the leave.' });

    const counted = E.countLeaveDays({ from: b.fromDate, to: b.toDate || b.fromDate, halfDay, sandwich: !!type.sandwich, weekends: company.weekends, holidays: company.holidays, workOnSunday: !!emp.workOnSunday });
    if (counted.error) return res.status(400).json({ message: counted.error });
    if (type.maxConsecutiveDays > 0 && counted.days > type.maxConsecutiveDays) return res.status(400).json({ message: `${type.name} can be taken for at most ${type.maxConsecutiveDays} day(s) at a time.` });

    const today = todayIST(), fromDate = b.fromDate, toDate = b.toDate || b.fromDate;
    if (fromDate < today) {
      if (E.diffDays(fromDate, today) > (type.backdateDays || 0)) return res.status(400).json({ message: `${type.name} can only be applied up to ${type.backdateDays || 0} day(s) after the leave started.` });
    } else if (E.diffDays(today, fromDate) < (type.minNoticeDays || 0)) {
      return res.status(400).json({ message: `${type.name} needs at least ${type.minNoticeDays} day(s) of notice.` });
    }

    let buddyId = null;
    if (b.buddyId) {
      if (!isId(b.buddyId) || oid(b.buddyId) === oid(emp._id)) return res.status(400).json({ message: 'Choose a different person as your buddy.' });
      const buddy = await Employee.findOne({ _id: b.buddyId, tenantId: tenantId(req) }).select('_id').lean();
      if (!buddy) return res.status(400).json({ message: 'Your buddy was not found in the company.' });
      buddyId = buddy._id;
    }

    const active = await LeaveRequest.find({ tenantId: tenantId(req), employeeId: emp._id, status: { $in: ['Pending', 'Approved'] } }).lean();
    const used = new Map();
    active.forEach((r) => (r.daysDetail || []).forEach((x) => used.set(x.d, (used.get(x.d) || 0) + x.u)));
    const clash = counted.detail.find((x) => (used.get(x.d) || 0) + x.u > 1 + 1e-9);
    if (clash) return res.status(400).json({ message: `You already have leave on ${clash.d}.` });

    const problem = await balanceProblem(req, emp, type, counted.detail, company, null);
    if (problem) return res.status(400).json({ message: problem });

    const doc = await LeaveRequest.create({
      tenantId: tenantId(req), employeeId: emp._id, leaveTypeId: type._id, typeName: type.name, paid: type.paid,
      fromDate, toDate, halfDay, days: counted.days, daysDetail: counted.detail, reason, buddyId, status: 'Pending'
    });
    req.actor = req.actor || { name: emp.name };
    await audit(req, 'leave_applied', `Applied for ${counted.days} day(s) of ${type.name} (${fromDate} to ${toDate})`, { requestId: String(doc._id) });
    res.status(201).json({ request: doc });
  } catch (e) { console.error('[Leave] createRequest', e.message); res.status(500).json({ message: 'Could not submit the leave request.' }); }
};

async function attachPeople(req, list) {
  const ids = [...new Set(list.map((r) => oid(r.employeeId)).concat(list.map((r) => r.decidedBy).filter(Boolean).map(oid)))];
  const emps = ids.length ? await empModel(req).find({ _id: { $in: ids } }).select('name department').lean() : [];
  const by = new Map(emps.map((e) => [oid(e._id), e]));
  return list.map((r) => ({ ...r, employeeName: (by.get(oid(r.employeeId)) || {}).name || 'Former employee', department: (by.get(oid(r.employeeId)) || {}).department || '', decidedByName: r.decidedBy ? ((by.get(oid(r.decidedBy)) || {}).name || '') : '' }));
}

exports.listRequests = async (req, res) => {
  try {
    const LeaveRequest = model(req, 'LeaveRequest');
    const view = ['mine', 'approvals', 'all'].includes(req.query.view) ? req.query.view : 'mine';
    const perms = req.permissions || {};
    const q = { tenantId: tenantId(req) };
    let reach = new Set([oid(req.user.id)]);
    if (view === 'approvals') {
      if (!perms['leave.approve']) return res.status(403).json({ message: 'You do not have permission to do this.' });
      reach = await reachIds(req, 'leave.approve');
    } else if (view === 'all') {
      if (!perms['leave.view']) return res.status(403).json({ message: 'You do not have permission to do this.' });
      reach = await reachIds(req, 'leave.view');
    } else q.employeeId = req.user.id;
    if (['Pending', 'Approved', 'Rejected', 'Cancelled'].includes(req.query.status)) q.status = req.query.status;
    else if (view === 'approvals') q.status = 'Pending';
    let list = await LeaveRequest.find(q).sort({ createdAt: -1 }).limit(1000).lean();
    if (view !== 'mine') list = list.filter((r) => inReach(reach, r.employeeId));
    const { from, to } = req.query;
    if (E.validDate(from) && E.validDate(to)) list = list.filter((r) => r.fromDate <= to && r.toDate >= from);
    res.json({ requests: await attachPeople(req, list.slice(0, 500)) });
  } catch (e) { console.error('[Leave] listRequests', e.message); res.status(500).json({ message: 'Could not load leave requests.' }); }
};

// The existing "on leave + buddy" flag (leaveStatus) makes tasks go to the buddy. Set it for an approved leave
// when the person has no leave window running or booked already; otherwise tell the approver.
async function syncLeaveStatus(req, doc) {
  const Employee = empModel(req);
  if (doc.toDate < todayIST()) return false;
  const emp = await Employee.findById(doc.employeeId).select('leaveStatus').lean();
  const ls = (emp && emp.leaveStatus) || {};
  const endStr = ls.endDate ? new Date(ls.endDate).toISOString().slice(0, 10) : null;
  if (ls.onLeave && endStr && endStr >= todayIST()) return false;
  await Employee.updateOne({ _id: doc.employeeId }, { $set: { leaveStatus: { onLeave: true, startDate: new Date(doc.fromDate + 'T00:00:00.000Z'), endDate: new Date(doc.toDate + 'T00:00:00.000Z'), buddyId: doc.buddyId || ls.buddyId || undefined } } });
  await model(req, 'LeaveRequest').updateOne({ _id: doc._id }, { $set: { leaveStatusSynced: true } });
  return true;
}
async function clearLeaveStatus(req, doc) {
  if (!doc.leaveStatusSynced) return;
  const Employee = empModel(req);
  const emp = await Employee.findById(doc.employeeId).select('leaveStatus').lean();
  const ls = (emp && emp.leaveStatus) || {};
  const s = ls.startDate ? new Date(ls.startDate).toISOString().slice(0, 10) : null;
  const e = ls.endDate ? new Date(ls.endDate).toISOString().slice(0, 10) : null;
  if (s === doc.fromDate && e === doc.toDate) await Employee.updateOne({ _id: doc.employeeId }, { $set: { 'leaveStatus.onLeave': false } });
}

exports.decideRequest = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid request.' });
    const LeaveRequest = model(req, 'LeaveRequest'), LeaveType = model(req, 'LeaveType'), Employee = empModel(req);
    const decision = req.body && req.body.decision;
    if (!['Approved', 'Rejected'].includes(decision)) return res.status(400).json({ message: 'Choose approve or reject.' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
    const doc = await LeaveRequest.findOne({ _id: req.params.id, tenantId: tenantId(req) }).lean();
    if (!doc) return res.status(404).json({ message: 'Leave request not found.' });
    if (doc.status !== 'Pending') return res.status(400).json({ message: `This request is already ${doc.status.toLowerCase()}.` });
    const company = await companyInfo(req);
    if (oid(doc.employeeId) === oid(req.user.id) && !company.allowSelfApproval) return res.status(403).json({ message: 'You cannot decide your own leave. Ask another approver.' });
    const reach = await reachIds(req, 'leave.approve');
    if (!inReach(reach, doc.employeeId)) return res.status(403).json({ message: 'This person is outside the people you can approve.' });

    if (decision === 'Approved') {
      const type = await LeaveType.findOne({ _id: doc.leaveTypeId, tenantId: tenantId(req) }).lean();
      const emp = await Employee.findOne({ _id: doc.employeeId, tenantId: tenantId(req) }).select('createdAt joiningDate').lean();
      if (type && emp) {
        const problem = await balanceProblem(req, emp, type, doc.daysDetail || [], company, oid(doc._id));
        if (problem) return res.status(400).json({ message: problem });
      }
    }
    const updated = await LeaveRequest.findOneAndUpdate(
      { _id: doc._id, tenantId: tenantId(req), status: 'Pending' },
      { $set: { status: decision, decidedBy: req.user.id, decidedAt: new Date(), decisionNote: note } }, { new: true });
    if (!updated) return res.status(409).json({ message: 'Someone else has already decided this request.' });
    let synced = null;
    if (decision === 'Approved') synced = await syncLeaveStatus(req, updated);
    await audit(req, 'leave_decided', `${decision} leave of ${updated.days} day(s) (${updated.fromDate} to ${updated.toDate})`, { requestId: oid(updated._id), employeeId: oid(updated.employeeId) });
    res.json({ request: updated, taskRedirect: synced === null ? undefined : synced,
      notice: synced === false ? 'Approved. This person already has a leave window set in their profile, so their tasks will not move to the buddy for this leave automatically.' : undefined });
  } catch (e) { console.error('[Leave] decideRequest', e.message); res.status(500).json({ message: 'Could not save the decision.' }); }
};

exports.cancelRequest = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid request.' });
    const LeaveRequest = model(req, 'LeaveRequest');
    const doc = await LeaveRequest.findOne({ _id: req.params.id, tenantId: tenantId(req) }).lean();
    if (!doc) return res.status(404).json({ message: 'Leave request not found.' });
    if (!['Pending', 'Approved'].includes(doc.status)) return res.status(400).json({ message: `This request is already ${doc.status.toLowerCase()}.` });
    const mine = oid(doc.employeeId) === oid(req.user.id);
    if (mine) {
      if (doc.status === 'Approved' && doc.fromDate < todayIST()) return res.status(400).json({ message: 'Leave that has already started cannot be cancelled here. Ask your approver.' });
    } else {
      const perms = req.permissions || {};
      if (!perms['leave.approve']) return res.status(403).json({ message: 'You do not have permission to do this.' });
      const reach = await reachIds(req, 'leave.approve');
      if (!inReach(reach, doc.employeeId)) return res.status(403).json({ message: 'This person is outside the people you can manage.' });
    }
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
    const updated = await LeaveRequest.findOneAndUpdate(
      { _id: doc._id, tenantId: tenantId(req), status: { $in: ['Pending', 'Approved'] } },
      { $set: { status: 'Cancelled', decidedBy: req.user.id, decidedAt: new Date(), decisionNote: note } }, { new: true });
    if (!updated) return res.status(409).json({ message: 'This request was just changed by someone else.' });
    if (doc.status === 'Approved') await clearLeaveStatus(req, doc);
    await audit(req, 'leave_cancelled', `Cancelled leave (${doc.fromDate} to ${doc.toDate})`, { requestId: oid(doc._id) });
    res.json({ request: updated });
  } catch (e) { console.error('[Leave] cancelRequest', e.message); res.status(500).json({ message: 'Could not cancel the request.' }); }
};

// ---- adjustments, calendar, joining dates -------------------------------------------
exports.adjustBalance = async (req, res) => {
  try {
    const b = req.body || {};
    if (!isId(b.employeeId) || !isId(b.leaveTypeId)) return res.status(400).json({ message: 'Choose a person and a leave type.' });
    const days = Number(b.days);
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 365) return res.status(400).json({ message: 'Enter the days to add (or a negative number to remove), up to 365.' });
    const reason = String(b.reason || '').trim().slice(0, 300);
    if (reason.length < 3) return res.status(400).json({ message: 'Please write the reason for this change.' });
    const date = b.date || todayIST();
    if (!E.validDate(date)) return res.status(400).json({ message: 'Choose a valid date.' });
    const reach = await reachIds(req, 'leave.adjust');
    if (!inReach(reach, b.employeeId)) return res.status(403).json({ message: 'This person is outside the people you can change.' });
    const emp = await empModel(req).findOne({ _id: b.employeeId, tenantId: tenantId(req) }).select('name').lean();
    if (!emp) return res.status(404).json({ message: 'Person not found.' });
    const type = await model(req, 'LeaveType').findOne({ _id: b.leaveTypeId, tenantId: tenantId(req) }).select('name').lean();
    if (!type) return res.status(404).json({ message: 'Leave type not found.' });
    const adj = await model(req, 'LeaveAdjustment').create({ tenantId: tenantId(req), employeeId: emp._id, leaveTypeId: type._id, days: Math.round(days * 100) / 100, date, reason, by: req.user.id });
    await audit(req, 'leave_adjusted', `${days > 0 ? 'Added' : 'Removed'} ${Math.abs(days)} day(s) of ${type.name} for ${emp.name}: ${reason}`, { adjustmentId: oid(adj._id), employeeId: oid(emp._id) });
    res.status(201).json({ adjustment: adj });
  } catch (e) { console.error('[Leave] adjust', e.message); res.status(500).json({ message: 'Could not save the change.' }); }
};

exports.calendar = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!E.validDate(from) || !E.validDate(to) || to < from) return res.status(400).json({ message: 'Choose valid dates.' });
    if (E.diffDays(from, to) > 62) return res.status(400).json({ message: 'Choose a range of at most 62 days.' });
    const reach = await reachIds(req, 'leave.view');
    let list = await model(req, 'LeaveRequest').find({ tenantId: tenantId(req), status: { $in: ['Approved', 'Pending'] } }).sort({ fromDate: 1 }).lean();
    list = list.filter((r) => r.fromDate <= to && r.toDate >= from && inReach(reach, r.employeeId));
    res.json({ requests: await attachPeople(req, list.slice(0, 1000)) });
  } catch (e) { res.status(500).json({ message: 'Could not load the calendar.' }); }
};

exports.listPeople = async (req, res) => {
  try {
    const list = await empModel(req).find({ tenantId: tenantId(req) }).select('name department joiningDate createdAt').sort({ name: 1 }).lean();
    res.json({ people: list.map((e) => ({ _id: e._id, name: e.name, department: e.department || '', joiningDate: e.joiningDate ? new Date(e.joiningDate).toISOString().slice(0, 10) : '', addedOn: e.createdAt ? new Date(e.createdAt).toISOString().slice(0, 10) : '' })) });
  } catch (e) { res.status(500).json({ message: 'Could not load people.' }); }
};

exports.setJoiningDate = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid person.' });
    const date = req.body && req.body.date;
    if (date !== null && date !== '' && !E.validDate(date)) return res.status(400).json({ message: 'Choose a valid date.' });
    const Employee = empModel(req);
    const emp = await Employee.findOne({ _id: req.params.id, tenantId: tenantId(req) }).select('name').lean();
    if (!emp) return res.status(404).json({ message: 'Person not found.' });
    await Employee.updateOne({ _id: emp._id }, date ? { $set: { joiningDate: new Date(date + 'T00:00:00.000Z') } } : { $unset: { joiningDate: 1 } });
    await audit(req, 'leave_adjusted', `Set joining date of ${emp.name}: ${date || 'cleared'}`, { employeeId: oid(emp._id) });
    res.json({ employeeId: emp._id, joiningDate: date || '' });
  } catch (e) { res.status(500).json({ message: 'Could not save the joining date.' }); }
};
