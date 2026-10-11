// controllers/payrollController.js
// Payroll: salary structures, the monthly payroll run (Draft -> Approved -> Released), payslips and CSV files.
// Every route is behind requirePermission (see routes) except the person's own payslips, which need only the
// payroll module to be switched on for the company. Rules live in utils/payrollEngine.js.
const mongoose = require('mongoose');
const P = require('../utils/payrollEngine');
const AE = require('../utils/attendanceEngine');
const att = require('./attendanceController');
const { loadPermissions } = require('../middleware/permission');
const { atLeast } = require('../utils/permissions');

const oid = (v) => String(v && v._id ? v._id : v);
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;
const tenantId = (req) => req.user.tenantId;
const model = (req, name) => {
  const m = require('../models/' + name);
  return req.db ? (req.db.models[name] || req.db.model(name, m.schema)) : m;
};
const empModel = (req) => (req.db ? req.db.model('Employee') : require('../models/Employee'));
const MAX_PEOPLE = 2000;

async function audit(req, action, description, extra) {
  try {
    const ActivityLog = require('../models/ActivityLog');
    await ActivityLog.create({
      tenantId: tenantId(req), employeeId: req.user.id, employeeName: (req.actor && req.actor.name) || '', employeeRole: (req.user.roles || []).join(', '),
      action, description, metadata: { ip: req.ip || '', extra: extra || {} }
    });
  } catch (e) { console.error('[Payroll] audit failed:', e.message); }
}

const DEFAULT_CONFIG = { dayBasis: 'calendar', roundNet: true, allowSelfApproval: false, employerName: '', employerAddress: '', components: [] };
// Starting points offered in the setup screen. Statutory deductions (PF, ESI, tax) come in a later phase.
const SUGGESTED = [
  { name: 'House Rent Allowance', type: 'earning', calc: 'percentBasic', value: 40, prorate: true },
  { name: 'Conveyance Allowance', type: 'earning', calc: 'fixed', value: 1600, prorate: true },
  { name: 'Special Allowance', type: 'earning', calc: 'fixed', value: 0, prorate: true },
  { name: 'Professional Tax', type: 'deduction', calc: 'fixed', value: 200, prorate: false }
];

async function loadConfig(req) {
  const Tenant = require('../models/Tenant');
  const t = await Tenant.findById(tenantId(req)).select('payrollConfig companyName').lean();
  const c = { ...DEFAULT_CONFIG, ...((t && t.payrollConfig) || {}) };
  c.components = ((t && t.payrollConfig && t.payrollConfig.components) || []).map((x) => ({ ...x }));
  return { config: c, companyName: (t && t.companyName) || '' };
}
const can = (req, key, scope = 'self') => { const p = (req.permissions || {})[key]; return !!p && atLeast(p, scope); };
const mayDecideOwn = (req, cfg) => can(req, 'payroll.configure', 'company') || !!cfg.allowSelfApproval;

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
const joinDateOf = (emp) => { const d = emp.joiningDate || emp.createdAt; return d ? AE.istDate(new Date(d).getTime()) : null; };
const maskBank = (b) => ({ accountName: (b && b.accountName) || '', bankName: (b && b.bankName) || '', ifsc: (b && b.ifsc) || '', accountNumber: P.maskAccount(b && b.accountNumber) });
const lineView = (l) => ({ ...l, bank: maskBank(l.bank) });
const structureView = (s) => ({ _id: s._id, effectiveFrom: s.effectiveFrom, basic: s.basic, items: s.items || [], bank: s.bank || {}, note: s.note || '' });

// ---- settings ---------------------------------------------------------------------------------------------------
exports.getConfig = async (req, res) => {
  try {
    const { config } = await loadConfig(req);
    // Employer address is printed on payslips; only the salary people need the rest.
    res.json({ config, suggested: SUGGESTED, dayBasisOptions: P.DAY_BASIS });
  } catch (e) { res.status(500).json({ message: 'Could not load payroll settings.' }); }
};

exports.setConfig = async (req, res) => {
  try {
    const b = req.body || {};
    const set = {};
    if (b.dayBasis !== undefined) { if (!P.DAY_BASIS.includes(b.dayBasis)) return res.status(400).json({ message: 'Choose calendar month or fixed 30 days.' }); set['payrollConfig.dayBasis'] = b.dayBasis; }
    if (b.roundNet !== undefined) set['payrollConfig.roundNet'] = !!b.roundNet;
    if (b.allowSelfApproval !== undefined) set['payrollConfig.allowSelfApproval'] = !!b.allowSelfApproval;
    if (b.employerName !== undefined) { const v = P.cleanStr(b.employerName, 100); set['payrollConfig.employerName'] = v; }
    if (b.employerAddress !== undefined) { const v = P.cleanStr(b.employerAddress, 250); set['payrollConfig.employerAddress'] = v; }
    if (b.components !== undefined) {
      const c = P.sanitizeComponents(b.components);
      if (c.error) return res.status(400).json({ message: c.error });
      set['payrollConfig.components'] = c.components;
    }
    if (!Object.keys(set).length) return res.status(400).json({ message: 'Nothing to save.' });
    const Tenant = require('../models/Tenant');
    await Tenant.updateOne({ _id: tenantId(req) }, { $set: set });
    await audit(req, 'payroll_config_saved', 'Changed payroll settings', { fields: Object.keys(set).map((k) => k.replace('payrollConfig.', '')) });
    const { config } = await loadConfig(req);
    res.json({ config });
  } catch (e) { res.status(500).json({ message: 'Could not save payroll settings.' }); }
};

// ---- salary structures -----------------------------------------------------------------------------------------------
exports.listSalaries = async (req, res) => {
  try {
    const reach = await reachIds(req, 'payroll.viewSalary');
    const { config } = await loadConfig(req);
    const emps = (await empModel(req).find({ tenantId: tenantId(req) }).select('name department joiningDate createdAt').sort({ name: 1 }).lean()).filter((e) => inReach(reach, e._id));
    const all = await model(req, 'PayrollStructure').find({ tenantId: tenantId(req), employeeId: { $in: emps.map((e) => e._id) } }).lean();
    const by = new Map();
    all.forEach((s) => { (by.get(oid(s.employeeId)) || by.set(oid(s.employeeId), []).get(oid(s.employeeId))).push(s); });
    const today = AE.istDate(Date.now());
    res.json({
      today,
      people: emps.map((e) => {
        const list = by.get(oid(e._id)) || [];
        const cur = P.structureForMonth(list, today.slice(0, 7));
        const m = cur ? P.monthlyAmounts(cur, config.components) : null;
        return { _id: e._id, name: e.name, department: e.department || '', hasSalary: !!cur, effectiveFrom: cur ? cur.effectiveFrom : '', basic: cur ? cur.basic : 0, gross: m ? m.gross : 0, net: m ? m.net : 0, versions: list.length };
      })
    });
  } catch (e) { res.status(500).json({ message: 'Could not load salaries.' }); }
};

exports.getSalary = async (req, res) => {
  try {
    const empId = req.params.employeeId;
    if (!isId(empId)) return res.status(400).json({ message: 'Invalid person.' });
    const reach = await reachIds(req, 'payroll.viewSalary');
    if (!inReach(reach, empId)) return res.status(403).json({ message: 'You cannot see this person\'s salary.' });
    const emp = await empModel(req).findOne({ _id: empId, tenantId: tenantId(req) }).select('name department').lean();
    if (!emp) return res.status(404).json({ message: 'Person not found.' });
    const { config } = await loadConfig(req);
    const list = await model(req, 'PayrollStructure').find({ tenantId: tenantId(req), employeeId: empId }).sort({ effectiveFrom: -1 }).lean();
    if (oid(empId) !== oid(req.user.id)) await audit(req, 'payroll_salary_viewed', `Viewed the salary of ${emp.name}`, { employeeId: empId });
    // Account numbers are masked unless the person can change salaries
    const full = can(req, 'payroll.configure', 'company');
    res.json({
      employee: { _id: emp._id, name: emp.name, department: emp.department || '' },
      components: config.components,
      versions: list.map((s) => { const v = structureView(s); const m = P.monthlyAmounts(s, config.components); return { ...v, bank: full ? v.bank : maskBank(v.bank), gross: m.gross, net: m.net, earnings: m.earnings, deductions: m.deductions }; })
    });
  } catch (e) { res.status(500).json({ message: 'Could not load the salary.' }); }
};

exports.setSalary = async (req, res) => {
  try {
    const empId = req.params.employeeId;
    if (!isId(empId)) return res.status(400).json({ message: 'Invalid person.' });
    const emp = await empModel(req).findOne({ _id: empId, tenantId: tenantId(req) }).select('name').lean();
    if (!emp) return res.status(404).json({ message: 'Person not found.' });
    const { config } = await loadConfig(req);
    const r = P.sanitizeStructure(req.body, config.components.filter((c) => c.active !== false));
    if (r.error) return res.status(400).json({ message: r.error });
    const S = model(req, 'PayrollStructure');
    const existing = await S.findOne({ tenantId: tenantId(req), employeeId: empId, effectiveFrom: r.structure.effectiveFrom }).lean();
    // A new account number is needed only when the bank part changes: an empty one keeps the saved number
    const bank = { ...r.structure.bank };
    if (existing && !bank.accountNumber && existing.bank) bank.accountNumber = existing.bank.accountNumber || '';
    const doc = { ...r.structure, bank };
    if (existing) await S.updateOne({ _id: existing._id }, { $set: doc });
    else await S.create({ tenantId: tenantId(req), employeeId: empId, createdBy: req.user.id, ...doc });
    await audit(req, 'payroll_salary_saved', `${existing ? 'Changed' : 'Set'} the salary of ${emp.name} from ${doc.effectiveFrom}`, { employeeId: empId, effectiveFrom: doc.effectiveFrom, basic: doc.basic, previousBasic: existing ? existing.basic : null });
    res.status(existing ? 200 : 201).json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Could not save the salary.' }); }
};

// ---- building a run -----------------------------------------------------------------------------------------------
async function paidLeaveMaps(req, empIds, from, to) {
  const out = new Map();
  if (!empIds.length) return out;
  const rows = await model(req, 'LeaveRequest').find({ tenantId: tenantId(req), employeeId: { $in: empIds }, status: 'Approved', paid: true, fromDate: { $lte: to }, toDate: { $gte: from } }).lean();
  for (const r of rows) {
    const m = out.get(oid(r.employeeId)) || new Map();
    for (const x of r.daysDetail || []) if (x.d >= from && x.d <= to) m.set(x.d, Math.min(1, (m.get(x.d) || 0) + x.u));
    out.set(oid(r.employeeId), m);
  }
  return out;
}

// Works out every person's line for the month. `keep` maps employeeId -> { adjustments, hold, holdNote } from an earlier draft.
async function buildLines(req, month, config, keep) {
  const emps = await empModel(req).find({ tenantId: tenantId(req) }).select('name department workOnSunday joiningDate createdAt').sort({ name: 1 }).lean();
  if (emps.length > MAX_PEOPLE) throw Object.assign(new Error('too many'), { userMessage: `Payroll supports up to ${MAX_PEOPLE} people at a time.` });
  const ids = emps.map((e) => oid(e._id));
  const dates = AE.monthDays(month);
  const cal = await att.payrollHelpers.loadTenant(req);
  const maps = await att.payrollHelpers.assignmentMaps(req);
  const dayMap = await att.payrollHelpers.buildDays(req, emps, dates, cal, maps);
  const leaves = await paidLeaveMaps(req, ids, dates[0], dates[dates.length - 1]);
  const structs = await model(req, 'PayrollStructure').find({ tenantId: tenantId(req), employeeId: { $in: ids } }).lean();
  const sBy = new Map();
  structs.forEach((s) => { (sBy.get(oid(s.employeeId)) || sBy.set(oid(s.employeeId), []).get(oid(s.employeeId))).push(s); });
  const comps = config.components.filter((c) => c.active !== false);
  const lines = [];
  for (const e of emps) {
    const id = oid(e._id);
    const k = (keep && keep.get(id)) || {};
    const st = P.structureForMonth(sBy.get(id) || [], month);
    const base = { employeeId: e._id, name: e.name, department: e.department || '', hold: !!k.hold, holdNote: k.holdNote || '' };
    if (!st) { lines.push({ ...base, structureFrom: '', days: {}, earnings: [], deductions: [], adjustments: [], gross: 0, totalDeductions: 0, rounding: 0, net: 0, warnings: [], noStructure: true, bank: {} }); continue; }
    const counts = P.dayCounts({ month, days: dayMap.get(id), paidLeave: leaves.get(id), joined: joinDateOf(e), dayBasis: config.dayBasis });
    const line = P.computeLine({ structure: st, components: comps, counts, adjustments: k.adjustments || [], roundNet: config.roundNet });
    lines.push({ ...base, structureFrom: st.effectiveFrom, ...line, noStructure: false, bank: st.bank || {} });
  }
  return lines;
}

const monthOk = (month) => {
  if (!P.validMonth(month)) return 'Choose a valid month.';
  if (P.lastDayOf(month) >= AE.istDate(Date.now())) return 'A month can be run only after it has ended.';
  return null;
};
const runSummary = (r) => ({ _id: r._id, month: r.month, status: r.status, totals: r.totals || {}, preparedAt: r.preparedAt, approvedAt: r.approvedAt, releasedAt: r.releasedAt, lines: undefined });
const nameOf = (req) => (req.actor && req.actor.name) || '';
const hist = (req, action, note) => ({ at: new Date(), by: req.user.id, byName: nameOf(req), action, note: note || '' });

exports.listRuns = async (req, res) => {
  try {
    const runs = await model(req, 'PayrollRun').find({ tenantId: tenantId(req), status: { $ne: 'Cancelled' } }).sort({ month: -1 }).lean();
    res.json({ runs: runs.map(runSummary) });
  } catch (e) { res.status(500).json({ message: 'Could not load payroll runs.' }); }
};

exports.createRun = async (req, res) => {
  try {
    const month = req.body && req.body.month;
    const bad = monthOk(month);
    if (bad) return res.status(400).json({ message: bad });
    const R = model(req, 'PayrollRun');
    const exist = await R.findOne({ tenantId: tenantId(req), month, status: { $ne: 'Cancelled' } }).lean();
    if (exist) return res.status(409).json({ message: `A ${exist.status.toLowerCase()} payroll for this month already exists.`, runId: exist._id });
    const { config } = await loadConfig(req);
    const lines = await buildLines(req, month, config, null);
    if (!lines.some((l) => !l.noStructure)) return res.status(400).json({ message: 'No one has a salary set yet. Set salaries first (Salaries tab).' });
    const run = await R.create({
      tenantId: tenantId(req), month, status: 'Draft', dayBasis: config.dayBasis, roundNet: config.roundNet, components: config.components,
      lines, totals: P.runTotals(lines), preparedBy: req.user.id, preparedAt: new Date(), history: [hist(req, 'created', '')]
    });
    await audit(req, 'payroll_run_created', `Prepared the payroll for ${month}`, { runId: oid(run._id), month });
    res.status(201).json({ runId: oid(run._id) });
  } catch (e) {
    if (e.userMessage) return res.status(400).json({ message: e.userMessage });
    console.error('[Payroll] createRun', e.message); res.status(500).json({ message: 'Could not prepare the payroll.' });
  }
};

async function getRun(req, res, wantStatus) {
  if (!isId(req.params.id)) { res.status(400).json({ message: 'Invalid payroll.' }); return null; }
  const run = await model(req, 'PayrollRun').findOne({ _id: req.params.id, tenantId: tenantId(req) }).lean();
  if (!run || run.status === 'Cancelled') { res.status(404).json({ message: 'Payroll not found.' }); return null; }
  if (wantStatus && !wantStatus.includes(run.status)) { res.status(409).json({ message: `This payroll is ${run.status.toLowerCase()}, so this cannot be done.` }); return null; }
  return run;
}

exports.getRun = async (req, res) => {
  try {
    const run = await getRun(req, res); if (!run) return;
    res.json({ run: { ...run, lines: (run.lines || []).map(lineView), components: undefined }, canApproveOwn: mayDecideOwn(req, (await loadConfig(req)).config), me: oid(req.user.id) });
  } catch (e) { res.status(500).json({ message: 'Could not load the payroll.' }); }
};

exports.recalculate = async (req, res) => {
  try {
    const run = await getRun(req, res, ['Draft']); if (!run) return;
    const { config } = await loadConfig(req);
    const keep = new Map((run.lines || []).map((l) => [oid(l.employeeId), { adjustments: l.adjustments, hold: l.hold, holdNote: l.holdNote }]));
    const lines = await buildLines(req, run.month, config, keep);
    const r = await model(req, 'PayrollRun').updateOne({ _id: run._id, tenantId: tenantId(req), status: 'Draft' }, { $set: { lines, totals: P.runTotals(lines), dayBasis: config.dayBasis, roundNet: config.roundNet, components: config.components }, $push: { history: hist(req, 'recalculated', '') } });
    if (r && r.matchedCount === 0) return res.status(409).json({ message: 'This payroll changed. Reload and try again.' });
    await audit(req, 'payroll_run_recalculated', `Recalculated the payroll for ${run.month}`, { runId: oid(run._id) });
    res.json({ ok: true });
  } catch (e) {
    if (e.userMessage) return res.status(400).json({ message: e.userMessage });
    res.status(500).json({ message: 'Could not recalculate.' });
  }
};

// Adjustments (bonus, advance recovery ...) and hold for one person in a draft run
exports.updateLine = async (req, res) => {
  try {
    const run = await getRun(req, res, ['Draft']); if (!run) return;
    const empId = req.params.employeeId;
    const idx = (run.lines || []).findIndex((l) => oid(l.employeeId) === empId);
    if (idx < 0) return res.status(404).json({ message: 'This person is not in the payroll.' });
    const b = req.body || {};
    const line = run.lines[idx];
    let adjustments = line.adjustments || [];
    if (b.adjustments !== undefined) {
      if (!Array.isArray(b.adjustments) || b.adjustments.length > 10) return res.status(400).json({ message: 'At most 10 additions or recoveries per person.' });
      adjustments = [];
      for (const a of b.adjustments) {
        const amount = Number(a && a.amount);
        const label = P.cleanStr(a && a.label, 60);
        if (!label) return res.status(400).json({ message: 'Every addition or recovery needs a name.' });
        if (!(amount > 0) || amount > P.MAX_MONEY) return res.status(400).json({ message: `Enter a valid amount for "${label}".` });
        adjustments.push({ label, type: a.type === 'deduction' ? 'deduction' : 'earning', amount, note: P.cleanStr(a.note, 200) });
      }
    }
    const hold = b.hold === undefined ? !!line.hold : !!b.hold;
    const holdNote = b.holdNote === undefined ? line.holdNote || '' : P.cleanStr(b.holdNote, 200);
    if (hold && !holdNote && b.hold !== undefined && !line.hold) return res.status(400).json({ message: 'Write why this payment is on hold.' });
    const { config } = await loadConfig(req);
    const keep = new Map([[empId, { adjustments, hold, holdNote }]]);
    // Only this person is recalculated; everyone else keeps the figures already in the draft
    const fresh = (await buildLines(req, run.month, config, keep)).find((l) => oid(l.employeeId) === empId);
    const lines = run.lines.slice(); lines[idx] = fresh;
    const r = await model(req, 'PayrollRun').updateOne({ _id: run._id, tenantId: tenantId(req), status: 'Draft' }, { $set: { lines, totals: P.runTotals(lines) }, $push: { history: hist(req, 'line_changed', line.name) } });
    if (r && r.matchedCount === 0) return res.status(409).json({ message: 'This payroll changed. Reload and try again.' });
    await audit(req, 'payroll_line_adjusted', `Changed ${line.name}'s payroll for ${run.month}`, { runId: oid(run._id), employeeId: empId, adjustments: adjustments.length, hold });
    res.json({ ok: true, line: lineView(fresh) });
  } catch (e) {
    if (e.userMessage) return res.status(400).json({ message: e.userMessage });
    res.status(500).json({ message: 'Could not change this line.' });
  }
};

exports.cancelRun = async (req, res) => {
  try {
    const run = await getRun(req, res, ['Draft']); if (!run) return;
    await model(req, 'PayrollRun').updateOne({ _id: run._id, tenantId: tenantId(req), status: 'Draft' }, { $set: { status: 'Cancelled' }, $push: { history: hist(req, 'cancelled', '') } });
    await audit(req, 'payroll_run_cancelled', `Discarded the draft payroll for ${run.month}`, { runId: oid(run._id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Could not discard the payroll.' }); }
};

const blockers = (run) => {
  const bad = (run.lines || []).filter((l) => !l.noStructure && !l.hold && l.net < 0);
  return bad.length ? `Net pay is below zero for ${bad.map((l) => l.name).slice(0, 5).join(', ')}${bad.length > 5 ? ' and others' : ''}. Fix it or put the payment on hold.` : null;
};

exports.approveRun = async (req, res) => {
  try {
    const run = await getRun(req, res, ['Draft']); if (!run) return;
    const { config } = await loadConfig(req);
    if (oid(run.preparedBy) === oid(req.user.id) && !mayDecideOwn(req, config)) return res.status(403).json({ message: 'Someone else must approve a payroll you prepared.' });
    const bad = blockers(run);
    if (bad) return res.status(400).json({ message: bad });
    const note = P.cleanStr(req.body && req.body.note, 200);
    const r = await model(req, 'PayrollRun').updateOne({ _id: run._id, tenantId: tenantId(req), status: 'Draft' }, { $set: { status: 'Approved', approvedBy: req.user.id, approvedAt: new Date() }, $push: { history: hist(req, 'approved', note) } });
    if (r && r.matchedCount === 0) return res.status(409).json({ message: 'This payroll changed. Reload and try again.' });
    await audit(req, 'payroll_run_approved', `Approved the payroll for ${run.month}`, { runId: oid(run._id), net: run.totals && run.totals.net });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Could not approve the payroll.' }); }
};

exports.reopenRun = async (req, res) => {
  try {
    const run = await getRun(req, res, ['Approved']); if (!run) return;
    const note = P.cleanStr(req.body && req.body.note, 200);
    if (note.length < 3) return res.status(400).json({ message: 'Write why this payroll is sent back.' });
    await model(req, 'PayrollRun').updateOne({ _id: run._id, tenantId: tenantId(req), status: 'Approved' }, { $set: { status: 'Draft', approvedBy: null, approvedAt: null }, $push: { history: hist(req, 'reopened', note) } });
    await audit(req, 'payroll_run_reopened', `Sent the payroll for ${run.month} back to draft`, { runId: oid(run._id), note });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Could not send the payroll back.' }); }
};

exports.releaseRun = async (req, res) => {
  try {
    const run = await getRun(req, res, ['Approved']); if (!run) return;
    const r = await model(req, 'PayrollRun').updateOne({ _id: run._id, tenantId: tenantId(req), status: 'Approved' }, { $set: { status: 'Released', releasedBy: req.user.id, releasedAt: new Date() }, $push: { history: hist(req, 'released', '') } });
    if (r && r.matchedCount === 0) return res.status(409).json({ message: 'This payroll changed. Reload and try again.' });
    await audit(req, 'payroll_run_released', `Released the payroll and payslips for ${run.month}`, { runId: oid(run._id), net: run.totals && run.totals.net, people: run.totals && run.totals.count });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Could not release the payroll.' }); }
};

// ---- files ---------------------------------------------------------------------------------------------------------------
exports.exportRun = async (req, res) => {
  try {
    const run = await getRun(req, res); if (!run) return;
    const kind = req.query.kind === 'bank' ? 'bank' : 'register';
    const paid = (run.lines || []).filter((l) => !l.noStructure && !l.hold);
    let rows, filename;
    if (kind === 'bank') {
      if (!['Approved', 'Released'].includes(run.status)) return res.status(409).json({ message: 'The bank file is available after the payroll is approved.' });
      rows = [['Employee', 'Account holder', 'Bank', 'Account number', 'IFSC', 'Amount', 'Narration']];
      paid.filter((l) => l.net > 0).forEach((l) => rows.push([l.name, (l.bank && l.bank.accountName) || l.name, (l.bank && l.bank.bankName) || '', (l.bank && l.bank.accountNumber) || '', (l.bank && l.bank.ifsc) || '', l.net.toFixed(2), 'Salary ' + run.month]));
      filename = `bank-file-${run.month}.csv`;
    } else {
      const names = [];
      const addName = (arr) => arr.forEach((x) => { if (!names.includes(x.name)) names.push(x.name); });
      paid.forEach((l) => { addName(l.earnings.filter((x) => !x.adjustment)); });
      const dedNames = [];
      paid.forEach((l) => l.deductions.filter((x) => !x.adjustment).forEach((x) => { if (!dedNames.includes(x.name)) dedNames.push(x.name); }));
      rows = [['Employee', 'Department', 'Days in month', 'Paid days', 'Unpaid days', ...names, 'Additions', 'Gross', ...dedNames, 'Recoveries', 'Total deductions', 'Rounding', 'Net pay']];
      paid.forEach((l) => {
        const get = (arr, n) => (arr.find((x) => x.name === n && !x.adjustment) || { amount: 0 }).amount;
        const adds = l.earnings.filter((x) => x.adjustment).reduce((s, x) => s + x.amount, 0);
        const recs = l.deductions.filter((x) => x.adjustment).reduce((s, x) => s + x.amount, 0);
        const d = l.days || {};
        rows.push([l.name, l.department, d.daysInMonth, d.payableDays, d.unpaidDays, ...names.map((n) => get(l.earnings, n)), P.r2(adds), l.gross, ...dedNames.map((n) => get(l.deductions, n)), P.r2(recs), l.totalDeductions, l.rounding, l.net]);
      });
      const t = run.totals || {};
      rows.push(['TOTAL', '', '', '', '', ...names.map(() => ''), '', t.gross, ...dedNames.map(() => ''), '', t.deductions, '', t.net]);
      filename = `payroll-register-${run.month}.csv`;
    }
    await audit(req, 'payroll_exported', `Downloaded the ${kind === 'bank' ? 'bank file' : 'payroll register'} for ${run.month}`, { runId: oid(run._id), kind });
    res.json({ filename, csv: P.csv(rows) });
  } catch (e) { res.status(500).json({ message: 'Could not create the file.' }); }
};

// ---- payslips -------------------------------------------------------------------------------------------------------------
const moduleOn = async (req) => { await loadPermissions(req); return !!(req.accessModules && req.accessModules.payroll); };

exports.myPayslips = async (req, res) => {
  try {
    if (!(await moduleOn(req))) return res.status(403).json({ message: 'Payroll is not switched on for your company.' });
    const runs = await model(req, 'PayrollRun').find({ tenantId: tenantId(req), status: 'Released', 'lines.employeeId': req.user.id }).sort({ month: -1 }).lean();
    const me = oid(req.user.id);
    const slips = [];
    for (const r of runs) {
      const l = (r.lines || []).find((x) => oid(x.employeeId) === me && !x.hold && !x.noStructure);
      if (l) slips.push({ runId: r._id, month: r.month, gross: l.gross, net: l.net, releasedAt: r.releasedAt });
    }
    res.json({ payslips: slips });
  } catch (e) { res.status(500).json({ message: 'Could not load your payslips.' }); }
};

exports.payslip = async (req, res) => {
  try {
    const { runId, employeeId } = req.params;
    if (!isId(runId) || !isId(employeeId)) return res.status(400).json({ message: 'Invalid payslip.' });
    const own = employeeId === oid(req.user.id);
    if (own) { if (!(await moduleOn(req))) return res.status(403).json({ message: 'Payroll is not switched on for your company.' }); }
    else {
      await loadPermissions(req);
      const reach = await reachIds(req, 'payroll.viewSalary');
      if (!(req.permissions || {})['payroll.viewSalary'] || !inReach(reach, employeeId)) return res.status(403).json({ message: 'You cannot see this payslip.' });
    }
    const run = await model(req, 'PayrollRun').findOne({ _id: runId, tenantId: tenantId(req), status: 'Released' }).lean();
    const l = run && (run.lines || []).find((x) => oid(x.employeeId) === employeeId && !x.hold && !x.noStructure);
    if (!l) return res.status(404).json({ message: 'Payslip not found.' });
    const { config, companyName } = await loadConfig(req);
    if (!own) await audit(req, 'payroll_salary_viewed', `Viewed the payslip of ${l.name} for ${run.month}`, { runId, employeeId });
    const { bank, ...rest } = l;
    res.json({
      payslip: { ...rest, month: run.month, runId: run._id, releasedAt: run.releasedAt, bank: maskBank(bank) },
      company: { name: config.employerName || companyName, address: config.employerAddress || '' }
    });
  } catch (e) { res.status(500).json({ message: 'Could not load the payslip.' }); }
};

// Released payslips of one person (for someone who can see their salary)
exports.personPayslips = async (req, res) => {
  try {
    const empId = req.params.employeeId;
    if (!isId(empId)) return res.status(400).json({ message: 'Invalid person.' });
    const reach = await reachIds(req, 'payroll.viewSalary');
    if (!inReach(reach, empId)) return res.status(403).json({ message: 'You cannot see this person\'s payslips.' });
    const runs = await model(req, 'PayrollRun').find({ tenantId: tenantId(req), status: 'Released', 'lines.employeeId': empId }).sort({ month: -1 }).lean();
    res.json({ payslips: runs.map((r) => { const l = r.lines.find((x) => oid(x.employeeId) === empId && !x.hold && !x.noStructure); return l ? { runId: r._id, month: r.month, gross: l.gross, net: l.net } : null; }).filter(Boolean) });
  } catch (e) { res.status(500).json({ message: 'Could not load payslips.' }); }
};
