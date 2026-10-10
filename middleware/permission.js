// middleware/permission.js
// requirePermission('payroll.viewSalary', 'department') - lets a request through only when the logged-in
// person holds that permission with at least that reach. Use after authMiddleware and tenantDbMiddleware.
// req.permissions is filled for the controller (e.g. to limit a list to the person's reach).
const { effectivePermissions, can } = require('../utils/permissions');

const cache = new Map(); // tenantId -> { at, accessRoles, hrModules }
const TTL = 30 * 1000;
const invalidate = (tenantId) => cache.delete(String(tenantId));

async function tenantAccess(tenantId) {
  const key = String(tenantId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const Tenant = require('../models/Tenant');
  const t = await Tenant.findById(key).select('accessRoles hrModules').lean();
  const val = { at: Date.now(), accessRoles: (t && t.accessRoles) || [], hrModules: (t && t.hrModules) || {} };
  cache.set(key, val);
  return val;
}

// Loads the person's current roles from the database (not from the token), so a change of role applies at once.
async function loadPermissions(req) {
  if (req.permissions) return req.permissions;
  const u = req.user;
  if (!u) return {};
  if (u.isSuperAdmin) { req.permissions = {}; return req.permissions; }
  if (!u.tenantId) { req.permissions = {}; return req.permissions; }
  const Employee = req.db ? req.db.model('Employee') : require('../models/Employee');
  const emp = await Employee.findById(u.id).select('roles accessRoleKeys tenantId name department location managedDoers managedAssigners').lean();
  if (!emp || String(emp.tenantId) !== String(u.tenantId)) { req.permissions = {}; return req.permissions; }
  req.actor = emp;
  const ta = await tenantAccess(u.tenantId);
  const keys = new Set(emp.accessRoleKeys || []);
  const custom = ta.accessRoles.filter((r) => keys.has(r.key));
  req.permissions = effectivePermissions(emp.roles, custom, ta.hrModules);
  req.accessModules = ta.hrModules;
  return req.permissions;
}

const requirePermission = (key, minScope = 'self') => async (req, res, next) => {
  try {
    const perms = await loadPermissions(req);
    if (!can(perms, key, minScope)) return res.status(403).json({ message: 'You do not have permission to do this.' });
    next();
  } catch (err) {
    console.error('[Permission]', err.message);
    res.status(500).json({ message: 'Could not check permission.' });
  }
};

// Lets a request through when the person holds at least one of the listed permissions.
const requireAnyPermission = (keys, minScope = 'self') => async (req, res, next) => {
  try {
    const perms = await loadPermissions(req);
    if (!keys.some((k) => can(perms, k, minScope))) return res.status(403).json({ message: 'You do not have permission to do this.' });
    next();
  } catch (err) {
    console.error('[Permission]', err.message);
    res.status(500).json({ message: 'Could not check permission.' });
  }
};

// Existing employee screens: only an Admin of the same company may add, change or remove employees.
// (Before this, any logged-in person could send these requests.)
const adminOfSameCompany = async (req, res, next) => {
  try {
    const u = req.user || {};
    if (u.isSuperAdmin) return next();
    if (!Array.isArray(u.roles) || !u.roles.includes('Admin')) return res.status(403).json({ message: 'Only an Admin can manage employees.' });
    const Employee = req.db ? req.db.model('Employee') : require('../models/Employee');
    if (req.params && req.params.id) {
      const target = await Employee.findById(req.params.id).select('tenantId').lean();
      if (target && String(target.tenantId) !== String(u.tenantId)) return res.status(403).json({ message: 'Forbidden. You do not have access to this company.' });
    } else if (req.body && req.body.tenantId && String(req.body.tenantId) !== String(u.tenantId)) {
      return res.status(403).json({ message: 'Forbidden. You do not have access to this company.' });
    }
    next();
  } catch (err) {
    res.status(400).json({ message: 'Invalid request.' });
  }
};

module.exports = { requirePermission, requireAnyPermission, loadPermissions, invalidate, adminOfSameCompany };
