// controllers/activityReport.js
// "Who did what" for one company between two dates (India dates, both days included).
// Sources: the login / admin ActivityLog, delegation task history, checklist completions and FMS steps.
const mongoose = require('mongoose');
const moment = require('moment');
const ExcelJS = require('exceljs');

const IST = 330 * 60 * 1000;
const ist = (...a) => moment(...a).utcOffset(330);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 20000;
const HIDDEN_ACTIONS = ['tenant_paused', 'tenant_resumed', 'plan_changed', 'limit_changed'];

const MODULE_OF = {
  login: 'Login', logout: 'Login',
  task_created: 'Tasks', task_assigned: 'Tasks', task_completed: 'Tasks', task_revision: 'Tasks',
  flow_created: 'FMS', flow_updated: 'FMS', flow_deleted: 'FMS', order_submitted: 'FMS', step_completed: 'FMS', flow_completed: 'FMS',
  employee_created: 'Employees', employee_updated: 'Employees', employee_deleted: 'Employees',
  message_sent: 'Chat', announcement_created: 'Chat', whatsapp_sent: 'WhatsApp', file_uploaded: 'Files'
};
const label = (a) => String(a || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Reads from / to (YYYY-MM-DD, India). Both missing = today only.
const parseRange = (q) => {
  const todayStr = ist().format('YYYY-MM-DD');
  const from = q.from || todayStr;
  const to = q.to || (q.from ? q.from : todayStr);
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) return { error: 'Please choose valid dates.' };
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const start = new Date(Date.UTC(fy, fm - 1, fd) - IST);
  const end = new Date(Date.UTC(ty, tm - 1, td + 1) - IST - 1);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return { error: 'Please choose valid dates.' };
  if (end < start) return { error: 'The "to" date cannot be before the "from" date.' };
  if (end.getTime() - start.getTime() > 366 * 86400000) return { error: 'Please choose a range of at most one year.' };
  return { start, end, from, to };
};

const model = (req, name, fallback) => (req.db ? req.db.model(name) : fallback);

async function collect(req, tenantId, start, end) {
  const Employee = model(req, 'Employee', require('../models/Employee'));
  const DelegationTask = model(req, 'DelegationTask', require('../models/DelegationTask'));
  const ChecklistTask = model(req, 'ChecklistTask', require('../models/ChecklistTask'));
  const FlowInstance = model(req, 'FlowInstance', require('../models/FlowInstance'));
  const ActivityLog = require('../models/ActivityLog');
  const inRange = (d) => { if (!d) return false; const t = new Date(d).getTime(); return t >= start.getTime() && t <= end.getTime(); };
  const tid = new mongoose.Types.ObjectId(String(tenantId));

  const [emps, logs, dels, cls, flows] = await Promise.all([
    Employee.find({ tenantId: tid }).select('name roles').lean(),
    ActivityLog.find({ tenantId: tid, createdAt: { $gte: start, $lte: end }, action: { $nin: HIDDEN_ACTIONS } }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    DelegationTask.find({ tenantId: tid, $or: [{ createdAt: { $gte: start, $lte: end } }, { 'history.timestamp': { $gte: start, $lte: end } }] }).select('title assignerId doerId createdAt history').lean(),
    ChecklistTask.find({ tenantId: tid, 'history.timestamp': { $gte: start, $lte: end } }).select('title doerId history').lean(),
    FlowInstance.find({ tenantId: tid, $or: [{ startedAt: { $gte: start, $lte: end } }, { 'nodeHistory.completedAt': { $gte: start, $lte: end } }] }).select('templateName orderIdentifier startedAt nodeHistory').lean()
  ]);

  const byId = new Map(emps.map((e) => [String(e._id), e]));
  const nameOf = (id) => (id && byId.get(String(id)) ? byId.get(String(id)).name : '');
  const roleOf = (id) => (id && byId.get(String(id)) ? (byId.get(String(id)).roles || []).join(', ') : '');
  const rows = [];
  const add = (r) => rows.push({ at: new Date(r.at), employee: r.employee || '—', role: r.role || '', module: r.module, action: r.action, details: r.details || '', reference: r.reference || '', ip: r.ip || '' });

  logs.forEach((l) => add({
    at: l.createdAt, employee: l.employeeName, role: l.employeeRole || roleOf(l.employeeId),
    module: MODULE_OF[l.action] || 'System', action: label(l.action), details: l.description || '',
    reference: l.metadata?.taskTitle || l.metadata?.orderId || l.metadata?.flowName || '', ip: l.metadata?.ip || ''
  }));

  dels.forEach((t) => {
    const hist = Array.isArray(t.history) ? t.history : [];
    const hasCreate = hist.some((h) => /^(created|assigned)/i.test(h.action || ''));
    if (!hasCreate && inRange(t.createdAt)) {
      add({ at: t.createdAt, employee: nameOf(t.assignerId), role: roleOf(t.assignerId), module: 'Delegation', action: 'Task assigned', details: `Assigned to ${nameOf(t.doerId) || 'a doer'}`, reference: t.title });
    }
    hist.forEach((h) => {
      if (!inRange(h.timestamp)) return;
      const by = h.performedBy || (/^(created|assigned|forwarded)/i.test(h.action || '') ? t.assignerId : t.doerId);
      add({ at: h.timestamp, employee: nameOf(by), role: roleOf(by), module: 'Delegation', action: h.action || 'Updated', details: h.remarks || '', reference: t.title });
    });
  });

  cls.forEach((t) => {
    (t.history || []).forEach((h) => {
      if (!inRange(h.timestamp)) return;
      const admin = /administrative/i.test(h.action || '');
      const details = [h.instanceDate ? `For ${ist(h.instanceDate).format('DD MMM YYYY')}` : '', admin ? 'Marked by an Admin' : '', h.remarks || ''].filter(Boolean).join(' · ');
      add({ at: h.timestamp, employee: nameOf(t.doerId), role: roleOf(t.doerId), module: 'Checklist', action: h.action || 'Updated', details, reference: t.title });
    });
  });

  flows.forEach((f) => {
    const ref = `${f.templateName || 'Flow'} · ${f.orderIdentifier || ''}`.trim();
    if (inRange(f.startedAt)) add({ at: f.startedAt, employee: '—', module: 'FMS', action: 'Order started', details: '', reference: ref });
    (f.nodeHistory || []).forEach((n) => {
      if (!inRange(n.completedAt)) return;
      const who = n.completedByName || nameOf(n.completedById) || n.assignedToName || '—';
      const bits = [n.decision ? `Decision: ${n.decision}` : '', n.onTime === false ? `Late by ${Math.round((n.delayMinutes || 0))} min` : ''].filter(Boolean).join(' · ');
      add({ at: n.completedAt, employee: who, role: roleOf(n.completedById), module: 'FMS', action: `Step completed: ${n.nodeName || ''}`.trim(), details: bits, reference: ref });
    });
  });

  rows.sort((a, b) => b.at - a.at);
  return rows;
}

const guard = (req, res) => {
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  if (!(req.user?.isSuperAdmin || roles.includes('Admin'))) { res.status(403).json({ message: 'Only the company Admin can open the activity log.' }); return false; }
  if (!mongoose.Types.ObjectId.isValid(req.params.tenantId)) { res.status(400).json({ message: 'Invalid company.' }); return false; }
  return true;
};

exports.getActivityLog = async (req, res) => {
  try {
    if (!guard(req, res)) return;
    const r = parseRange(req.query);
    if (r.error) return res.status(400).json({ message: r.error });
    const rows = await collect(req, req.params.tenantId, r.start, r.end);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const page = rows.slice(skip, skip + limit).map((x) => ({ ...x, at: x.at.toISOString() }));
    res.status(200).json({ from: r.from, to: r.to, total: rows.length, skip, limit, rows: page });
  } catch (err) {
    console.error('Activity log error:', err.message);
    res.status(500).json({ message: 'Could not load the activity log.' });
  }
};

exports.downloadActivityLog = async (req, res) => {
  try {
    if (!guard(req, res)) return;
    const r = parseRange(req.query);
    if (r.error) return res.status(400).json({ message: r.error });
    const rows = await collect(req, req.params.tenantId, r.start, r.end);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Activity log');
    ws.columns = [
      { header: 'Date & Time (IST)', key: 'at', width: 22 }, { header: 'Employee', key: 'employee', width: 24 },
      { header: 'Role', key: 'role', width: 16 }, { header: 'Module', key: 'module', width: 14 },
      { header: 'Action', key: 'action', width: 30 }, { header: 'Details', key: 'details', width: 50 },
      { header: 'Reference', key: 'reference', width: 36 }, { header: 'IP', key: 'ip', width: 16 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    rows.slice(0, MAX_ROWS).forEach((x) => ws.addRow({ ...x, at: ist(x.at).format('DD MMM YYYY, hh:mm:ss A') }));
    ws.autoFilter = { from: 'A1', to: 'H1' };
    const info = wb.addWorksheet('Info');
    info.addRow(['From', r.from]); info.addRow(['To', r.to]); info.addRow(['Rows', Math.min(rows.length, MAX_ROWS)]);
    if (rows.length > MAX_ROWS) info.addRow(['Note', `Only the newest ${MAX_ROWS} rows are included. Choose a shorter range for the rest.`]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="WorkPilot_Activity_${r.from}_to_${r.to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Activity download error:', err.message);
    if (!res.headersSent) res.status(500).json({ message: 'Could not build the activity log.', error: err.message });
  }
};
