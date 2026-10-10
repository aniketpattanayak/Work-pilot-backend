// controllers/accessController.js
// Custom roles and permissions for the attendance / leave / payroll modules.
const crypto = require('crypto');
const { CATALOG, SCOPES, MODULES, sanitizePermissions } = require('../utils/permissions');
const { loadPermissions, invalidate } = require('../middleware/permission');

const MAX_ROLES = 50, MAX_ROLES_PER_PERSON = 5;
const empModel = (req) => (req.db ? req.db.model('Employee') : require('../models/Employee'));
const tenantOf = (req) => req.user && req.user.tenantId;

async function audit(req, action, description, extra) {
  try {
    const ActivityLog = require('../models/ActivityLog');
    await ActivityLog.create({
      tenantId: tenantOf(req), employeeId: req.user.id, employeeName: req.user.name || '', employeeRole: (req.user.roles || []).join(', '),
      action, description, metadata: { ip: req.ip || '', extra: extra || {} }
    });
  } catch (e) { console.error('[Access] audit failed:', e.message); }
}

exports.getCatalog = (req, res) => res.json({ catalog: CATALOG, scopes: SCOPES });

// What the logged-in person may do (the client uses this to show or hide screens)
exports.getMyAccess = async (req, res) => {
  try {
    const permissions = await loadPermissions(req);
    res.json({ permissions, modules: req.accessModules || {} });
  } catch (e) { res.status(500).json({ message: 'Could not load access.' }); }
};

exports.listRoles = async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const t = await Tenant.findById(tenantOf(req)).select('accessRoles hrModules').lean();
    const emps = await empModel(req).find({ tenantId: tenantOf(req) }).select('name email department roles accessRoleKeys').lean();
    const roles = ((t && t.accessRoles) || []).map((r) => ({ ...r, people: emps.filter((e) => (e.accessRoleKeys || []).includes(r.key)).length }));
    res.json({ roles, modules: (t && t.hrModules) || {}, employees: emps.map((e) => ({ _id: e._id, name: e.name, email: e.email, department: e.department, roles: e.roles, accessRoleKeys: e.accessRoleKeys || [] })) });
  } catch (e) { res.status(500).json({ message: 'Could not load roles.' }); }
};

function readRoleBody(body) {
  const name = String((body && body.name) || '').trim();
  const description = String((body && body.description) || '').trim();
  if (name.length < 2 || name.length > 40) return { error: 'Role name must be 2 to 40 characters.' };
  if (description.length > 200) return { error: 'Description can be at most 200 characters.' };
  const p = sanitizePermissions(body && body.permissions);
  if (p.error) return { error: p.error };
  return { name, description, permissions: p.permissions };
}

exports.createRole = async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const r = readRoleBody(req.body);
    if (r.error) return res.status(400).json({ message: r.error });
    const t = await Tenant.findById(tenantOf(req)).select('accessRoles').lean();
    if (!t) return res.status(404).json({ message: 'Company not found.' });
    t.accessRoles = t.accessRoles || [];
    if (t.accessRoles.length >= MAX_ROLES) return res.status(400).json({ message: `At most ${MAX_ROLES} roles are allowed.` });
    if (t.accessRoles.some((x) => x.name.toLowerCase() === r.name.toLowerCase())) return res.status(400).json({ message: 'A role with this name already exists.' });
    const role = { key: 'r_' + crypto.randomBytes(6).toString('hex'), ...r, createdBy: req.user.id, createdAt: new Date() };
    await Tenant.updateOne({ _id: tenantOf(req) }, { $push: { accessRoles: role } });
    invalidate(tenantOf(req));
    await audit(req, 'role_saved', `Created role "${r.name}"`, { roleKey: role.key, permissions: r.permissions.length });
    res.status(201).json({ role });
  } catch (e) { console.error('[Access] createRole', e.message); res.status(500).json({ message: 'Could not create the role.' }); }
};

exports.updateRole = async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const r = readRoleBody(req.body);
    if (r.error) return res.status(400).json({ message: r.error });
    const t = await Tenant.findById(tenantOf(req)).select('accessRoles').lean();
    const role = t && (t.accessRoles || []).find((x) => x.key === req.params.key);
    if (!role) return res.status(404).json({ message: 'Role not found.' });
    if (t.accessRoles.some((x) => x.key !== role.key && x.name.toLowerCase() === r.name.toLowerCase())) return res.status(400).json({ message: 'A role with this name already exists.' });
    const before = role.permissions.length;
    await Tenant.updateOne({ _id: tenantOf(req), 'accessRoles.key': role.key }, { $set: { 'accessRoles.$.name': r.name, 'accessRoles.$.description': r.description, 'accessRoles.$.permissions': r.permissions } });
    invalidate(tenantOf(req));
    await audit(req, 'role_saved', `Changed role "${r.name}"`, { roleKey: role.key, permissionsBefore: before, permissionsAfter: r.permissions.length });
    res.json({ role: { ...role, ...r } });
  } catch (e) { console.error('[Access] updateRole', e.message); res.status(500).json({ message: 'Could not save the role.' }); }
};

exports.deleteRole = async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const t = await Tenant.findById(tenantOf(req)).select('accessRoles').lean();
    const role = t && (t.accessRoles || []).find((x) => x.key === req.params.key);
    if (!role) return res.status(404).json({ message: 'Role not found.' });
    const inUse = await empModel(req).countDocuments({ tenantId: tenantOf(req), accessRoleKeys: role.key });
    if (inUse > 0) return res.status(400).json({ message: `${inUse} ${inUse === 1 ? 'person has' : 'people have'} this role. Take it away from them first.` });
    await Tenant.updateOne({ _id: tenantOf(req) }, { $pull: { accessRoles: { key: role.key } } });
    invalidate(tenantOf(req));
    await audit(req, 'role_deleted', `Deleted role "${role.name}"`, { roleKey: role.key });
    res.json({ message: 'Role deleted.' });
  } catch (e) { res.status(500).json({ message: 'Could not delete the role.' }); }
};

// Set the custom roles of one person (replaces the list)
exports.assignRoles = async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const { employeeId } = req.body || {};
    const keys = Array.isArray(req.body && req.body.roleKeys) ? [...new Set(req.body.roleKeys.map(String))] : null;
    if (!employeeId || !keys) return res.status(400).json({ message: 'Choose a person and their roles.' });
    if (keys.length > MAX_ROLES_PER_PERSON) return res.status(400).json({ message: `A person can have at most ${MAX_ROLES_PER_PERSON} roles.` });
    const t = await Tenant.findById(tenantOf(req)).select('accessRoles').lean();
    const valid = new Set(((t && t.accessRoles) || []).map((r) => r.key));
    if (keys.some((k) => !valid.has(k))) return res.status(400).json({ message: 'One of the roles does not exist.' });
    const Employee = empModel(req);
    const emp = await Employee.findOne({ _id: employeeId, tenantId: tenantOf(req) }).select('name accessRoleKeys').lean();
    if (!emp) return res.status(404).json({ message: 'Person not found in your company.' });
    const before = emp.accessRoleKeys || [];
    await Employee.updateOne({ _id: emp._id }, { $set: { accessRoleKeys: keys } });
    await audit(req, 'role_assigned', `Changed access roles of ${emp.name}`, { employeeId: String(emp._id), before, after: keys });
    res.json({ employeeId: emp._id, accessRoleKeys: keys });
  } catch (e) { console.error('[Access] assignRoles', e.message); res.status(500).json({ message: 'Could not save.' }); }
};

// Platform owner only: switch a module on or off for a company (all are off until switched on)
exports.setModules = async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const incoming = (req.body && req.body.modules) || {};
    const t = await Tenant.findById(req.params.tenantId).select('hrModules').lean();
    if (!t) return res.status(404).json({ message: 'Company not found.' });
    const next = { attendance: false, leave: false, payroll: false, ...(t.hrModules || {}) };
    for (const m of MODULES) if (typeof incoming[m] === 'boolean') next[m] = incoming[m];
    if (next.payroll && !(next.attendance && next.leave)) return res.status(400).json({ message: 'Payroll needs Attendance and Leave to be on first.' });
    await Tenant.updateOne({ _id: req.params.tenantId }, { $set: { hrModules: next } });
    invalidate(req.params.tenantId);
    res.json({ modules: next });
  } catch (e) { res.status(500).json({ message: 'Could not save.' }); }
};
