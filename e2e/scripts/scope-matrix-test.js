// Tests that the SCOPE dropdown on a role's permission (Only themselves / Their team /
// Their department / Their branch / Whole company) actually restricts what data a person
// can see — not just that the permission itself exists. This can't be tested with one
// employee: scope only means something when there's someone else to compare against. Runs
// against the throwaway zzz-playwright-test tenant (never ARV), creating a small org
// structure (5 employees across 2 departments/locations, one manager relationship) and one
// dedicated "tester" role per scope level, then checks GET /tasks/attendance/sheet and
// GET /tasks/leave/requests?view=all return exactly the right set of people for each scope.
//
// Payroll is excluded on purpose: there is no payroll API route or frontend page anywhere
// in this app, so there is nothing to call — only the permission exists on paper.
//
// Plain Node (no Playwright): this is backend authorization logic, which is far more
// reliably and cheaply verified by calling the API directly than by driving a browser.

const API_BASE = process.env.PROD_API_BASE;
const SUPERADMIN_USER = process.env.PROD_SUPERADMIN_USER;
const SUPERADMIN_PASS = process.env.PROD_SUPERADMIN_PASS;
const SUBDOMAIN = 'zzz-playwright-test';

const results = [];
const log = (...a) => { const line = a.map(String).join(' '); results.push(line); console.log(line); };

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
async function req(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await json(res);
  return { ok: res.ok, status: res.status, data };
}

// Deterministic test employees, same every run, so reruns update rather than duplicate them.
const EMP = {
  manager: { name: 'Scope Test Manager', email: 'scope-test-manager@workpilot-test.invalid', department: 'Engineering', location: 'Mumbai' },
  teamMember: { name: 'Scope Test TeamMember', email: 'scope-test-teammember@workpilot-test.invalid', department: 'Engineering', location: 'Mumbai' },
  deptPeer: { name: 'Scope Test DeptPeer', email: 'scope-test-deptpeer@workpilot-test.invalid', department: 'Engineering', location: 'Delhi' },
  branchPeer: { name: 'Scope Test BranchPeer', email: 'scope-test-branchpeer@workpilot-test.invalid', department: 'Sales', location: 'Mumbai' },
  outsider: { name: 'Scope Test Outsider', email: 'scope-test-outsider@workpilot-test.invalid', department: 'Sales', location: 'Delhi' },
};
const PASSWORD = 'ScopeTest@123';

let failed = false;
const check = (label, cond, detail) => {
  if (cond) { log('  [OK]', label); }
  else { log('  [MISMATCH]', label, detail ? '— ' + detail : ''); failed = true; }
};

(async () => {
  if (!API_BASE || !SUPERADMIN_USER || !SUPERADMIN_PASS) {
    throw new Error('Missing PROD_API_BASE / PROD_SUPERADMIN_USER / PROD_SUPERADMIN_PASS.');
  }

  const superLogin = await req('POST', '/tenants/master-login', null, { username: SUPERADMIN_USER, password: SUPERADMIN_PASS });
  if (!superLogin.ok) throw new Error('Super admin login failed: ' + superLogin.status + ' ' + JSON.stringify(superLogin.data));
  const superToken = superLogin.data.token;

  const verify = await req('GET', `/tenants/verify/${SUBDOMAIN}`, null);
  if (!verify.ok) throw new Error('Could not find test tenant: ' + JSON.stringify(verify.data));
  const tenantId = verify.data.id;
  log('Tenant:', SUBDOMAIN, tenantId);

  await req('PUT', `/tenants/access/modules/${tenantId}`, superToken, { modules: { attendance: true, leave: true, payroll: true } });

  // Admin login (seeded qa-admin, same as the rest of the e2e suite) to manage employees/roles.
  const adminLogin = await req('POST', '/tasks/login-employee', null, { email: process.env.E2E_EMAIL || 'qa-admin@workpilot-test.com', password: process.env.E2E_PASSWORD || 'TestPass123!', subdomain: SUBDOMAIN });
  if (!adminLogin.ok) throw new Error('Admin login failed: ' + JSON.stringify(adminLogin.data));
  const adminToken = adminLogin.data.token;

  // --- create (or reuse) the 5 test employees ---------------------------------------
  const existing = await req('GET', '/tasks/access/roles', adminToken);
  const existingByEmail = new Map((existing.data.employees || []).map((e) => [e.email, e]));

  const ids = {};
  for (const [key, e] of Object.entries(EMP)) {
    if (existingByEmail.has(e.email)) {
      ids[key] = existingByEmail.get(e.email)._id;
      log('Reusing employee', key, e.email, ids[key]);
      continue;
    }
    const bulk = await req('POST', '/tenants/bulk-employees', adminToken, { tenantId, employees: [{ name: e.name, email: e.email, password: PASSWORD, department: e.department, Doer: true }] });
    log('Created employee', key, e.email, JSON.stringify(bulk.data));
    if (!bulk.ok || (bulk.data.results && bulk.data.results.failed.length)) throw new Error(`Could not create employee ${e.email}: ${JSON.stringify(bulk.data)}`);
  }

  // Re-fetch to get ids for anyone just created, and to set department/location/manager links.
  const after = await req('GET', '/tasks/access/roles', adminToken);
  const byEmail = new Map((after.data.employees || []).map((e) => [e.email, e]));
  for (const [key, e] of Object.entries(EMP)) ids[key] = byEmail.get(e.email)._id;

  for (const [key, e] of Object.entries(EMP)) {
    const body = { name: e.name, email: e.email, department: e.department, location: e.location, roles: ['Doer'] };
    if (key === 'manager') body.managedDoers = [ids.teamMember];
    const up = await req('PUT', `/tasks/employees/${ids[key]}`, adminToken, body);
    if (!up.ok) throw new Error(`Could not update employee ${key}: ${JSON.stringify(up.data)}`);
  }
  log('Org structure set: manager manages teamMember; Engineering/Mumbai = manager+teamMember, Engineering/Delhi = deptPeer, Sales/Mumbai = branchPeer, Sales/Delhi = outsider');

  // --- build/update one role per scope level, each assigned to its own tester --------
  const SCOPES = ['self', 'team', 'department', 'branch', 'company'];
  const roleKeyByScope = {};
  const rolesList = (await req('GET', '/tasks/access/roles', adminToken)).data.roles || [];
  for (const scope of SCOPES) {
    const roleName = `Scope Test (${scope})`;
    const existingRole = rolesList.find((r) => r.name === roleName);
    const permissions = [
      { key: 'attendance.view', scope },
      { key: 'leave.view', scope },
    ];
    const body = { name: roleName, description: 'Automated scope-matrix test role', permissions };
    const saved = existingRole
      ? await req('PUT', `/tasks/access/roles/${existingRole.key}`, adminToken, body)
      : await req('POST', '/tasks/access/roles', adminToken, body);
    if (!saved.ok) throw new Error(`Could not save role for scope ${scope}: ${JSON.stringify(saved.data)}`);
    roleKeyByScope[scope] = (saved.data.role || existingRole).key;
  }

  // Tester-per-scope: self->manager is wrong (manager also used for team test) so use
  // dedicated testers: self=teamMember, team=manager, department=deptPeer, branch=branchPeer, company=outsider.
  const testerForScope = { self: 'teamMember', team: 'manager', department: 'deptPeer', branch: 'branchPeer', company: 'outsider' };
  for (const scope of SCOPES) {
    const empKey = testerForScope[scope];
    await req('PUT', '/tasks/access/assign', adminToken, { employeeId: ids[empKey], roleKeys: [roleKeyByScope[scope]] });
  }
  log('Assigned scope-test roles:', JSON.stringify(testerForScope));

  // --- a couple of real leave requests to check leave.view filtering against -----------
  const typesRes = await req('GET', '/tasks/leave/types', adminToken);
  let typeId = (typesRes.data.types || [])[0]?._id;
  if (!typeId) {
    const createType = await req('POST', '/tasks/leave/types', adminToken, { name: 'Casual Leave', paid: true, annualQuota: 12 });
    typeId = createType.data.type._id;
  }
  const nextWeekday = () => { const d = new Date(); d.setDate(d.getDate() + 20); while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

  async function loginAs(key) {
    const r = await req('POST', '/tasks/login-employee', null, { email: EMP[key].email, password: PASSWORD, subdomain: SUBDOMAIN });
    if (!r.ok) throw new Error(`Login failed for ${key}: ${JSON.stringify(r.data)}`);
    return r.data.token;
  }

  const teamMemberToken = await loginAs('teamMember');
  const branchPeerToken = await loginAs('branchPeer');
  const applyDate = nextWeekday();
  await req('POST', '/tasks/leave/requests', teamMemberToken, { leaveTypeId: typeId, fromDate: applyDate, toDate: applyDate, reason: 'scope matrix test (teamMember)' }).catch(() => {});
  await req('POST', '/tasks/leave/requests', branchPeerToken, { leaveTypeId: typeId, fromDate: applyDate, toDate: applyDate, reason: 'scope matrix test (branchPeer)' }).catch(() => {});
  log('Seeded (or confirmed already seeded) leave requests for teamMember and branchPeer on', applyDate);

  // --- run the actual checks -----------------------------------------------------------
  log('\n=== Attendance sheet (GET /tasks/attendance/sheet) reach by scope ===');
  for (const scope of SCOPES) {
    const empKey = testerForScope[scope];
    const token = await loginAs(empKey);
    const sheet = await req('GET', '/tasks/attendance/sheet', token);
    if (!sheet.ok) { check(`${scope} (${empKey}) sheet request succeeds`, false, JSON.stringify(sheet.data)); continue; }
    const names = new Set((sheet.data.rows || []).map((r) => r.name));
    log(`${scope} (${empKey}) sees:`, [...names].join(', '));

    if (scope === 'self') {
      check('self sees only themselves', names.size === 1 && names.has(EMP.teamMember.name), [...names].join(','));
    } else if (scope === 'team') {
      check('team sees manager + teamMember only', names.has(EMP.manager.name) && names.has(EMP.teamMember.name) && !names.has(EMP.deptPeer.name) && !names.has(EMP.branchPeer.name) && !names.has(EMP.outsider.name));
    } else if (scope === 'department') {
      check('department (Engineering) sees manager+teamMember+deptPeer, not Sales people', names.has(EMP.manager.name) && names.has(EMP.teamMember.name) && names.has(EMP.deptPeer.name) && !names.has(EMP.branchPeer.name) && !names.has(EMP.outsider.name));
    } else if (scope === 'branch') {
      check('branch (Mumbai) sees manager+teamMember+branchPeer, not Delhi people', names.has(EMP.manager.name) && names.has(EMP.teamMember.name) && names.has(EMP.branchPeer.name) && !names.has(EMP.deptPeer.name) && !names.has(EMP.outsider.name));
    } else if (scope === 'company') {
      check('company sees everyone', ['manager', 'teamMember', 'deptPeer', 'branchPeer', 'outsider'].every((k) => names.has(EMP[k].name)));
    }
  }

  log('\n=== Leave requests (GET /tasks/leave/requests?view=all) reach by scope ===');
  for (const scope of SCOPES) {
    const empKey = testerForScope[scope];
    const token = await loginAs(empKey);
    const listRes = await req('GET', '/tasks/leave/requests?view=all', token);
    if (!listRes.ok) { check(`${scope} (${empKey}) leave list request succeeds`, false, JSON.stringify(listRes.data)); continue; }
    const seenNames = new Set((listRes.data.requests || []).map((r) => r.employeeName));
    log(`${scope} (${empKey}) sees leave requests from:`, [...seenNames].join(', ') || '(none)');

    const sawTeamMember = seenNames.has(EMP.teamMember.name);
    const sawBranchPeer = seenNames.has(EMP.branchPeer.name);
    if (scope === 'self') check('self sees no one else\'s leave', !sawBranchPeer);
    if (scope === 'team') check('team (manager) sees teamMember\'s leave but not branchPeer\'s', sawTeamMember && !sawBranchPeer);
    if (scope === 'department') check('department (Engineering, via deptPeer) sees teamMember\'s leave but not branchPeer\'s (Sales)', sawTeamMember && !sawBranchPeer);
    // branchPeer and teamMember are both location=Mumbai (different departments), so branch
    // scope should see both seeded requests — department scope is what tells them apart.
    if (scope === 'branch') check('branch (Mumbai, via branchPeer) sees both Mumbai people\'s leave (teamMember + own)', sawBranchPeer && sawTeamMember);
    if (scope === 'company') check('company sees both seeded requests', sawTeamMember && sawBranchPeer);
  }

  log('\n=== Payroll ===');
  log('Skipped: no payroll API route exists anywhere in the backend (confirmed by source search) — the permission is saved on a role but nothing in this app reads or enforces it yet.');

  if (failed) { console.error('\nSCOPE MATRIX: one or more mismatches found.'); process.exitCode = 1; }
  else console.log('\nSCOPE MATRIX: all checks passed.');
})().catch((e) => {
  log('\nCRASHED:', e.stack || e.message);
  process.exitCode = 1;
}).finally(() => {
  const reportPath = require('path').join(__dirname, '..', 'scope-matrix-report.log');
  require('fs').writeFileSync(reportPath, results.join('\n'));
});
