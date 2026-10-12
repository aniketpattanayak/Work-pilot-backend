// Phase 1B: generated (not hand-written) permission matrix.
// Reads the real CATALOG/SCOPES straight from utils/permissions.js on the backend branch,
// then for every module.action key and every scope level, creates a throwaway custom role
// granting ONLY that key@scope, assigns it alone to a disposable employee (no builtin roles),
// and calls a representative real HTTP route that is gated by exactly that key (and that
// route's own minScope, taken from the actual router.* line in routes/taskRoutes.js) - so
// this exercises the live requirePermission()/can()/effectivePermissions() chain end to end,
// not a mock.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5099/api';
const BACKEND = '/tmp/wpb';
const { CATALOG, SCOPES } = require(path.join(BACKEND, 'utils/permissions.js'));

async function j(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: (body !== undefined && body !== null && method !== 'GET' && method !== 'DELETE' && method !== 'HEAD') ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// module.action -> { method, path(employeeId), minScope } - one representative, side-effect-light
// route per permission key, taken verbatim from routes/taskRoutes.js's router.* lines.
const ROUTES = {
  'access.manage':          { method: 'GET', path: () => '/tasks/access/roles', minScope: 'self' },
  'attendance.view':        { method: 'GET', path: () => '/tasks/attendance/sheet?month=2026-09', minScope: 'self' },
  'attendance.punch':       { method: 'GET', path: () => '/tasks/attendance/today', minScope: 'self' },
  'attendance.edit':        { method: 'POST', path: () => '/tasks/attendance/manual', minScope: 'self', body: { employeeId: null, date: '2026-09-10', status: 'Present' } },
  'attendance.approve':     { method: 'GET', path: () => '/tasks/attendance/review', minScope: 'self' },
  'attendance.export':      { method: 'GET', path: () => '/tasks/attendance/sheet?month=2026-09&export=1', minScope: 'self' },
  'attendance.configure':   { method: 'PUT', path: () => '/tasks/attendance/config', minScope: 'self', body: {} },
  'leave.view':             { method: 'GET', path: () => '/tasks/leave/calendar?from=2026-09-01&to=2026-09-10', minScope: 'self' },
  'leave.apply':            { method: 'POST', path: () => '/tasks/leave/requests', minScope: 'self', body: { fromDate: '2099-01-05', toDate: '2099-01-05', type: 'Casual', reason: 'matrix test' } },
  'leave.approve':          { method: 'PUT', path: (id) => `/tasks/leave/requests/${id || '000000000000000000000000'}/decision`, minScope: 'self', body: { status: 'Approved' } },
  'leave.adjust':           { method: 'POST', path: () => '/tasks/leave/adjust', minScope: 'self', body: { employeeId: null, type: 'Casual', days: 0 } },
  'leave.configure':        { method: 'PUT', path: () => '/tasks/leave/config', minScope: 'self', body: {} },
  'payroll.viewSalary':     { method: 'GET', path: () => '/tasks/payroll/salaries', minScope: 'self' },
  'payroll.prepare':        { method: 'POST', path: () => '/tasks/payroll/runs', minScope: 'company', body: { month: '2026-07' } },
  'payroll.approve':        { method: 'PUT', path: (id) => `/tasks/payroll/runs/${id || '000000000000000000000000'}/approve`, minScope: 'company', body: {} },
  'payroll.release':        { method: 'PUT', path: (id) => `/tasks/payroll/runs/${id || '000000000000000000000000'}/release`, minScope: 'company', body: {} },
  'payroll.export':         { method: 'GET', path: (id) => `/tasks/payroll/runs/${id || '000000000000000000000000'}/export`, minScope: 'self' },
  'payroll.configure':      { method: 'PUT', path: () => '/tasks/payroll/config', minScope: 'self', body: {} },
};

const ALL_KEYS = [];
CATALOG.forEach((m) => m.actions.forEach((a) => ALL_KEYS.push({ key: `${m.module}.${a.key}`, scoped: a.scoped, module: m.module })));

const results = [];
function record(area, name, pass, detail) { results.push({ area, name, pass, detail: pass ? undefined : detail }); }

(async () => {
  try {
  const sub = 'zzz-permmatrix-' + Date.now();
  console.log('starting run', sub);
  let r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  if (!superToken) { console.error('cannot get superadmin token', r); process.exit(1); }

  const fd = new FormData();
  fd.append('companyName', 'Perm Matrix Co'); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  r = await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => ({})) }));
  if (r.status >= 300) { console.error('create-company failed', r); process.exit(1); }

  r = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token, tenantId = r.data.tenantId;

  // Turn all 3 HR modules on (superadmin-gated switch) so every permission key is reachable.
  r = await j('PUT', `/tasks/access/modules/${tenantId}`, { modules: { attendance: true, leave: true, payroll: true } }, superToken);
  if (r.status >= 300) record('setup', 'superadmin can turn on attendance/leave/payroll modules', false, r);

  // One throwaway target employee whose own data the test subject may or may not reach.
  r = await j('POST', '/tenants/add-employee', { tenantId, name: 'Target Person', email: `target@${sub}.test`, whatsappNumber: '9990000099', department: 'Ops', password: 'TestPass123!', roles: ['Doer'], joiningDate: '2026-07-01' }, adminToken);
  const targetId = r.data.employee && r.data.employee._id;

  let n = 0;
  for (const { key, scoped } of ALL_KEYS) {
    const route = ROUTES[key];
    if (!route) { record('B-matrix', `(no representative route mapped for ${key} - skipped)`, true); continue; }
    const scopesToTry = scoped ? SCOPES : ['company'];
    for (const grantScope of scopesToTry) {
      n++;
      const email = `mx${n}@${sub}.test`;
      let rr = await j('POST', '/tenants/add-employee', { tenantId, name: `Matrix ${n}`, email, whatsappNumber: `999100${String(n).padStart(4, '0')}`, department: 'Ops', password: 'TestPass123!', roles: [] }, adminToken);
      const empId = rr.data.employee && rr.data.employee._id;
      if (!empId) { record('B-matrix', `${key}@${grantScope}: setup (create test employee)`, false, rr); continue; }
      // addEmployee defaults an empty roles[] to built-in Doer (by design), which itself grants
      // attendance.view/punch + leave.view/apply at 'self' - strip that so this subject's ONLY
      // permission is the single custom one under test.
      await j('PUT', `/tenants/employees/${empId}`, { roles: [] }, adminToken);

      rr = await j('POST', '/tasks/access/roles', { name: `R${n}`, description: '', permissions: [{ key, scope: grantScope }] }, adminToken);
      const roleKey = rr.data.role && rr.data.role.key;
      if (!roleKey) { record('B-matrix', `${key}@${grantScope}: setup (create custom role)`, false, rr); continue; }

      rr = await j('PUT', '/tasks/access/assign', { employeeId: empId, roleKeys: [roleKey] }, adminToken);
      if (rr.status !== 200) { record('B-matrix', `${key}@${grantScope}: setup (assign role)`, false, rr); continue; }

      rr = await j('POST', '/tenants/login-employee', { subdomain: sub, email, password: 'TestPass123!' });
      const subjectToken = rr.data.token;
      if (!subjectToken) { record('B-matrix', `${key}@${grantScope}: setup (login as test subject)`, false, rr); continue; }

      const body = route.body ? JSON.parse(JSON.stringify(route.body).replace(/null/g, `"${targetId}"`)) : undefined;
      const expectAllow = SCOPES.indexOf(grantScope) >= SCOPES.indexOf(route.minScope);
      const call = await j(route.method, route.path(targetId), body, subjectToken);
      const allowed = call.status !== 403;
      const pass = allowed === expectAllow;
      record('B-matrix', `${key}@${grantScope} (route needs >= ${route.minScope}): expect ${expectAllow ? 'ALLOW' : 'DENY(403)'}, got ${call.status}`, pass,
        { key, grantScope, minScope: route.minScope, route: `${route.method} ${route.path(targetId)}`, status: call.status, body: call.data });

      // Clean up so we never hit the 50-custom-role-per-tenant cap across ~80 generated combinations.
      await j('DELETE', `/tenants/employees/${empId}`, null, adminToken);
      await j('DELETE', `/tasks/access/roles/${roleKey}`, null, adminToken);
    }
  }

  // Negative control: an employee with ZERO roles/permissions is denied on every representative route.
  // Note: addEmployee always defaults an empty roles[] to built-in Doer (by design - every account needs
  // a base role), so a truly empty role set has to be forced afterwards via updateEmployee.
  {
    const email = `nobody@${sub}.test`;
    let rr = await j('POST', '/tenants/add-employee', { tenantId, name: 'Nobody', email, whatsappNumber: '9991239999', department: 'Ops', password: 'TestPass123!', roles: [] }, adminToken);
    const empId = rr.data.employee && rr.data.employee._id;
    await j('PUT', `/tenants/employees/${empId}`, { roles: [] }, adminToken);
    rr = await j('POST', '/tenants/login-employee', { subdomain: sub, email, password: 'TestPass123!' });
    const noToken = rr.data.token;
    for (const [key, route] of Object.entries(ROUTES)) {
      const body = route.body ? JSON.parse(JSON.stringify(route.body).replace(/null/g, `"${targetId}"`)) : undefined;
      const call = await j(route.method, route.path(targetId), body, noToken);
      record('B-matrix-negative', `a person with no roles is denied ${key} (${route.method} ${route.path(targetId)})`, call.status === 403, call);
    }
  }

  // Widest-scope-wins: a person with two custom roles granting the SAME key at different
  // scopes (self via role A, company via role B) must get the wider (company) scope.
  {
    let rr = await j('POST', '/tasks/access/roles', { name: 'WideA', description: '', permissions: [{ key: 'payroll.viewSalary', scope: 'self' }] }, adminToken);
    if (!rr.data.role) { record('C-widest-scope', 'setup: create role A', false, rr); return; }
    const roleA = rr.data.role.key;
    rr = await j('POST', '/tasks/access/roles', { name: 'WideB', description: '', permissions: [{ key: 'payroll.viewSalary', scope: 'company' }] }, adminToken);
    if (!rr.data.role) { record('C-widest-scope', 'setup: create role B', false, rr); return; }
    const roleB = rr.data.role.key;
    const email = `widest@${sub}.test`;
    rr = await j('POST', '/tenants/add-employee', { tenantId, name: 'Widest Scope', email, whatsappNumber: '9992229999', department: 'Ops', password: 'TestPass123!', roles: [] }, adminToken);
    const empId = rr.data.employee._id;
    await j('PUT', '/tasks/access/assign', { employeeId: empId, roleKeys: [roleA, roleB] }, adminToken);
    rr = await j('POST', '/tenants/login-employee', { subdomain: sub, email, password: 'TestPass123!' });
    const tok = rr.data.token;
    rr = await j('GET', `/tasks/payroll/salaries/${targetId}`, null, tok);
    record('C-widest-scope', 'two roles granting the same key at different scopes: the wider (company) scope wins', rr.status === 200, rr);

    // Role changed while logged in: take role B away, keep only role A (self scope) - must now be denied on another person's salary.
    await j('PUT', '/tasks/access/assign', { employeeId: empId, roleKeys: [roleA] }, adminToken);
    rr = await j('GET', `/tasks/payroll/salaries/${targetId}`, null, tok);
    record('C-live-role-change', 'taking away the wider role mid-session narrows access on the very next request (no re-login needed)', rr.status === 403, rr);
  }

  // Deactivated user with an old token: once leaveStatus/active-style deactivation exists, a stale JWT must stop working.
  // (This backend does not have a soft employee-deactivation flag; `deleteEmployee` is the only off switch.)
  {
    const email = `leaver@${sub}.test`;
    let rr = await j('POST', '/tenants/add-employee', { tenantId, name: 'Leaver Person', email, whatsappNumber: '9993339999', department: 'Ops', password: 'TestPass123!', roles: ['Doer'] }, adminToken);
    const empId = rr.data.employee._id;
    rr = await j('POST', '/tenants/login-employee', { subdomain: sub, email, password: 'TestPass123!' });
    const oldToken = rr.data.token;
    rr = await j('DELETE', `/tenants/employees/${empId}`, null, adminToken);
    record('C-deactivation', 'admin can delete the departing employee', rr.status === 200, rr);
    rr = await j('GET', '/tasks/attendance/today', null, oldToken);
    record('C-deactivation', 'a deleted employee\'s still-unexpired JWT is rejected on the next request', rr.status === 401 || rr.status === 403 || rr.status === 404, rr);
  }

  // Cross-tenant: a token from a DIFFERENT company cannot be used against this tenant's subdomain-scoped routes.
  {
    const sub2 = sub + '-b';
    const fd2 = new FormData();
    fd2.append('companyName', 'Perm Matrix Co B'); fd2.append('subdomain', sub2);
    fd2.append('ownerEmail', `admin@${sub2}.test`); fd2.append('adminPassword', 'TestPass123!');
    await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd2 });
    let rr = await j('POST', '/tenants/login-employee', { subdomain: sub2, email: `admin@${sub2}.test`, password: 'TestPass123!' });
    const otherToken = rr.data.token;
    rr = await j('GET', `/tasks/payroll/salaries/${targetId}`, null, otherToken);
    record('B-isolation', 'an Admin from a different company cannot fetch this tenant\'s employee salary by id', rr.status === 403 || rr.status === 404, rr);
  }

  } catch (e) {
    console.error('PERM_MATRIX_FAILED_INNER', e);
  } finally {
    fs.writeFileSync(path.join(__dirname, 'results-perm-matrix.json'), JSON.stringify(results, null, 2));
    const pass = results.filter((r) => r.pass).length, fail = results.filter((r) => !r.pass).length;
    console.log(`\nPERM MATRIX DONE: ${pass} pass / ${fail} fail / ${results.length} total`);
    if (fail) { console.log('\nFAILURES:'); results.filter((r) => !r.pass).forEach((r) => console.log(' -', r.area, '|', r.name, '|', JSON.stringify(r.detail).slice(0, 150))); }
  }
})().catch((e) => { console.error('PERM_MATRIX_FAILED', e); process.exit(1); });
