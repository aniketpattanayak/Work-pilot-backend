// utils/permissions.js
// The list of things a person can be allowed to do in the HR modules (attendance, leave, payroll),
// the built-in permissions of the existing roles, and the rule that turns a person's roles into
// what they may do. Pure functions only (no database), so it is easy to test.

// Scope = how far the permission reaches. Higher index reaches further.
const SCOPES = ['self', 'team', 'department', 'branch', 'company'];

const A = (key, label, scoped = true) => ({ key, label, scoped });

// sensitive = never given to Admin automatically; must be granted through a role.
const CATALOG = [
  {
    module: 'access', label: 'Roles & access', sensitive: false,
    actions: [A('manage', 'Create roles and give them to people', false)]
  },
  {
    module: 'attendance', label: 'Attendance', sensitive: false,
    actions: [
      A('view', 'See attendance'), A('punch', 'Punch in / out', true), A('edit', 'Correct attendance'),
      A('approve', 'Approve regularisation / overtime'), A('export', 'Download registers'),
      A('configure', 'Change attendance policies, shifts and locations', false)
    ]
  },
  {
    module: 'leave', label: 'Leave', sensitive: false,
    actions: [
      A('view', 'See leave and balances'), A('apply', 'Apply for leave'), A('approve', 'Approve leave'),
      A('adjust', 'Adjust balances'), A('configure', 'Change leave types and holidays', false)
    ]
  },
  {
    module: 'payroll', label: 'Payroll', sensitive: true,
    actions: [
      A('viewSalary', 'See salary details'), A('prepare', 'Prepare a payroll run'), A('approve', 'Approve a payroll run', false),
      A('release', 'Release payslips and bank file', false), A('export', 'Download payroll reports and statutory files'),
      A('configure', 'Change salary structures and rules', false)
    ]
  }
];

// "module.action" -> { module, action, scoped }
const KEYS = {};
CATALOG.forEach((m) => m.actions.forEach((a) => { KEYS[`${m.module}.${a.key}`] = { module: m.module, scoped: a.scoped, sensitive: m.sensitive }; }));

const MODULES = CATALOG.map((m) => m.module).filter((m) => m !== 'access');

const scopeRank = (s) => SCOPES.indexOf(s);
const maxScope = (a, b) => (scopeRank(a) >= scopeRank(b) ? a : b);
const atLeast = (have, need) => scopeRank(have) >= scopeRank(need);

// What the existing fixed roles can do in the new modules.
const BUILTIN = {
  Admin: () => {
    const out = {};
    Object.keys(KEYS).forEach((k) => { if (!KEYS[k].sensitive) out[k] = 'company'; });
    return out;
  },
  Coordinator: () => ({ 'attendance.view': 'team', 'attendance.punch': 'self', 'attendance.approve': 'team', 'leave.view': 'team', 'leave.apply': 'self', 'leave.approve': 'team' }),
  Assigner: () => ({ 'attendance.view': 'team', 'attendance.punch': 'self', 'leave.view': 'team', 'leave.apply': 'self' }),
  Doer: () => ({ 'attendance.view': 'self', 'attendance.punch': 'self', 'leave.view': 'self', 'leave.apply': 'self' }),
  Viewer: () => ({})
};

// roles: ['Admin', ...], customRoles: [{permissions:[{key,scope}]}], modules: {attendance:bool, ...}
// Returns { 'attendance.view': 'company', ... }. A module that is switched off for the company gives nothing.
function effectivePermissions(roles, customRoles, modules) {
  const out = {};
  const grant = (key, scope) => {
    const def = KEYS[key];
    if (!def) return;
    const sc = def.scoped ? (SCOPES.includes(scope) ? scope : 'self') : 'company';
    out[key] = out[key] ? maxScope(out[key], sc) : sc;
  };
  (roles || []).forEach((r) => { const f = BUILTIN[r]; if (f) Object.entries(f()).forEach(([k, s]) => grant(k, s)); });
  (customRoles || []).forEach((cr) => (cr.permissions || []).forEach((p) => grant(p.key, p.scope)));
  const on = modules || {};
  Object.keys(out).forEach((k) => { const m = KEYS[k].module; if (m !== 'access' && !on[m]) delete out[k]; });
  return out;
}

const can = (perms, key, minScope = 'self') => !!perms && !!perms[key] && atLeast(perms[key], minScope);

// Checks the permission list of a role being saved. Returns { error } or { permissions }.
function sanitizePermissions(list) {
  if (!Array.isArray(list)) return { error: 'Permissions must be a list.' };
  if (list.length > 100) return { error: 'Too many permissions.' };
  const seen = new Map();
  for (const p of list) {
    const key = p && p.key;
    const def = KEYS[key];
    if (!def) return { error: `Unknown permission: ${String(key).slice(0, 40)}` };
    let scope = p.scope;
    if (def.scoped) { if (!SCOPES.includes(scope)) return { error: `Choose how far "${key}" reaches.` }; } else scope = 'company';
    seen.set(key, scope);
  }
  return { permissions: [...seen].map(([key, scope]) => ({ key, scope })) };
}

module.exports = { SCOPES, CATALOG, KEYS, MODULES, BUILTIN, effectivePermissions, can, atLeast, sanitizePermissions };
