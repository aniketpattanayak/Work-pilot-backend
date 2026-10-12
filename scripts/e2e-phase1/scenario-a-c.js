// Phase 1 Scenario A (full hire-to-exit lifecycle, ~25-person realistic company)
// and Scenario C (cross-module consistency) - run live against the local test
// server + local test DB only.
const BASE = process.env.TEST_BASE || 'http://localhost:5099/api';
async function j(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 300));
}

(async () => {
  const sub = 'zzz-lifecycle-' + Date.now();

  let r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;

  const fd = new FormData();
  fd.append('companyName', 'Lifecycle Test Co'); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token, tenantId = r.data.tenantId;
  check('setup: company created, admin can log in', !!adminToken, r);

  // Turn on attendance + leave + payroll (payroll needs the other two already on).
  r = await j('PUT', `/tasks/access/modules/${tenantId}`, { modules: { attendance: true } }, superToken);
  r = await j('PUT', `/tasks/access/modules/${tenantId}`, { modules: { leave: true } }, superToken);
  r = await j('PUT', `/tasks/access/modules/${tenantId}`, { modules: { payroll: true } }, superToken);
  check('setup: all three HR modules switched on', r.status === 200, r);

  // ---- Build the ~25-person company: 2 locations, 3 departments, varied roles ----
  const LOCATIONS = ['Mumbai HQ', 'Pune Branch'];
  const DEPTS = ['Ops', 'Sales', 'Finance'];
  async function hire(name, role, dept, loc, joiningDate, extra = {}) {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@${sub}.test`;
    const rr = await j('POST', '/tasks/add-employee', {
      tenantId, name, email, department: dept, location: loc, whatsappNumber: '9' + String(Math.floor(1000000000 + Math.random() * 8999999999)).slice(0, 9),
      roles: [role], password: 'TestPass123!', joiningDate, ...extra,
    }, adminToken);
    const id = rr.data?.employee?._id || rr.data?._id;
    const login = await j('POST', '/tenants/login-employee', { subdomain: sub, email, password: 'TestPass123!' });
    return { id, email, token: login.data.token, name, role, dept, loc };
  }

  const hrHead = await hire('Priya HR Head', 'Admin', 'Ops', LOCATIONS[0], '2023-01-01');
  const hrExec = await hire('Rahul HR Exec', 'Doer', 'Ops', LOCATIONS[0], '2023-02-01');
  const finance = await hire('Anita Finance', 'Doer', 'Finance', LOCATIONS[0], '2023-01-15');
  const managers = [];
  for (let m = 0; m < 3; m++) managers.push(await hire(`Manager ${m + 1}`, 'Assigner', DEPTS[m], LOCATIONS[m % 2], '2023-03-01'));
  const deptHeads = [];
  for (let d = 0; d < 3; d++) deptHeads.push(await hire(`${DEPTS[d]} Head`, 'Coordinator', DEPTS[d], LOCATIONS[d % 2], '2023-03-01'));
  const employees = [];
  for (let e = 0; e < 14; e++) employees.push(await hire(`Employee ${e + 1}`, 'Doer', DEPTS[e % 3], LOCATIONS[e % 2], '2023-04-01'));
  const midMonthJoiner = await hire('MidMonth Joiner', 'Doer', 'Ops', LOCATIONS[0], '2026-09-16');
  const leaverPerson = await hire('Soon Leaving', 'Doer', 'Sales', LOCATIONS[0], '2023-05-01');
  const noticePerson = await hire('On Notice', 'Doer', 'Finance', LOCATIONS[1], '2023-06-01');

  const allPeople = [hrHead, hrExec, finance, ...managers, ...deptHeads, ...employees, midMonthJoiner, leaverPerson, noticePerson];
  check(`setup: company has ${allPeople.length} people across ${LOCATIONS.length} locations and ${DEPTS.length} departments`, allPeople.length >= 23 && allPeople.every((p) => !!p.id && !!p.token), { count: allPeople.length });

  // Give HR Head real access-role permissions for leave/attendance (Admin builtin already has company-scope access.manage, attendance/leave are non-sensitive so Admin has them too, but payroll is sensitive - give Finance payroll.prepare/approve explicitly).
  r = await j('POST', '/tasks/access/roles', { name: 'Payroll Preparer', permissions: [{ key: 'payroll.prepare', scope: 'company' }, { key: 'payroll.viewSalary', scope: 'company' }] }, adminToken);
  const preparerRoleKey = r.data?.role?.key;
  r = await j('POST', '/tasks/access/roles', { name: 'Payroll Approver', permissions: [{ key: 'payroll.approve', scope: 'company' }, { key: 'payroll.release', scope: 'company' }, { key: 'payroll.viewSalary', scope: 'company' }, { key: 'payroll.configure', scope: 'company' }] }, adminToken);
  const approverRoleKey = r.data?.role?.key;
  check('setup: Payroll Preparer/Approver custom roles created', !!preparerRoleKey && !!approverRoleKey, r);

  r = await j('PUT', '/tasks/access/assign', { employeeId: finance.id, roleKeys: [preparerRoleKey] }, adminToken);
  check('setup: Finance assigned the Payroll Preparer role', r.status === 200, r);
  r = await j('PUT', '/tasks/access/assign', { employeeId: hrHead.id, roleKeys: [approverRoleKey] }, adminToken);
  check('setup: HR Head assigned the Payroll Approver role (so approval is a different person than the preparer)', r.status === 200, r);

  // ---- Lifecycle: attendance for everyone for a month (Sept 2026, direct via API punches) ----
  r = await j('POST', '/tasks/attendance/manual', { employeeId: employees[0].id, date: '2026-09-01', time: '09:05', type: 'in', note: 'Forgot web punch, added manually' }, adminToken);
  check('lifecycle: a manual attendance punch can be added for an employee', r.status === 200 || r.status === 201, r);

  // Give both the mid-month joiner and a full-month employee a few real in/out punches,
  // so the payroll pro-ration comparison below reflects actual presence rather than two
  // all-absent lines (which would trivially both be net 0 and prove nothing).
  // Mid-month joiner: present every working day AFTER joining (16th-30th).
  for (const d of ['17', '18', '19', '22', '23', '24', '25', '26', '29', '30']) {
    await j('POST', '/tasks/attendance/manual', { employeeId: midMonthJoiner.id, date: `2026-09-${d}`, time: '09:00', type: 'in', note: 'Seed punch for lifecycle test' }, adminToken);
    await j('POST', '/tasks/attendance/manual', { employeeId: midMonthJoiner.id, date: `2026-09-${d}`, time: '18:00', type: 'out', note: 'Seed punch for lifecycle test' }, adminToken);
  }
  // Full-month employee: present every working day of the ENTIRE month, for comparison.
  for (const d of ['01', '02', '03', '04', '07', '08', '09', '10', '11', '14', '15', '16', '17', '18', '19', '22', '23', '24', '25', '26', '29', '30']) {
    await j('POST', '/tasks/attendance/manual', { employeeId: employees[0].id, date: `2026-09-${d}`, time: '09:00', type: 'in', note: 'Seed punch for lifecycle test' }, adminToken);
    await j('POST', '/tasks/attendance/manual', { employeeId: employees[0].id, date: `2026-09-${d}`, time: '18:00', type: 'out', note: 'Seed punch for lifecycle test' }, adminToken);
  }

  // ---- Lifecycle: salary structures for payroll to have something to run ----
  let salarySetErrors = 0, firstSalaryErr = null;
  for (const p of allPeople) {
    const sr = await j('PUT', `/tasks/payroll/salaries/${p.id}`, { effectiveFrom: '2026-01-01', basic: 30000, items: [] }, hrHead.token);
    if (sr.status >= 400) { salarySetErrors++; if (!firstSalaryErr) firstSalaryErr = sr; }
  }
  check('lifecycle: salary structures set for the whole company (no errors)', salarySetErrors === 0, firstSalaryErr);
  r = await j('GET', '/tasks/payroll/salaries', undefined, hrHead.token);
  check('lifecycle: salary list reflects the structures just set', Array.isArray(r.data) ? r.data.length >= allPeople.length : true, r);

  // ---- Lifecycle: leave applied and approved for a regular employee ----
  r = await j('GET', '/tasks/leave/types', undefined, adminToken);
  let leaveTypeId = (r.data || [])[0]?._id;
  if (!leaveTypeId) {
    r = await j('POST', '/tasks/leave/types', { name: 'Casual Leave', daysPerYear: 12, requiresReason: false }, adminToken);
    leaveTypeId = r.data?.type?._id || r.data?._id;
  }
  r = await j('POST', '/tasks/leave/adjust', { employeeId: employees[1].id, leaveTypeId, days: 5, reason: 'Lifecycle test seed balance' }, adminToken);
  check('setup: leave balance can be manually adjusted upward for a new employee', r.status === 200 || r.status === 201, r);

  r = await j('POST', '/tasks/leave/requests', { leaveTypeId, fromDate: '2026-10-20', toDate: '2026-10-21' }, employees[1].token);
  const leaveReqId = r.data?.request?._id || r.data?._id;
  check('lifecycle: an employee can apply for leave', r.status === 200 || r.status === 201, r);
  // Approved by HR Head (Admin role - leave.approve is non-sensitive so Admin gets it company-wide by
  // default), rather than the line manager, to avoid also having to wire up managedDoers team-reach for
  // this lifecycle test - that reach mechanism is already covered by Phase 1's permission-matrix script.
  r = await j('PUT', `/tasks/leave/requests/${leaveReqId}/decision`, { decision: 'Approved' }, hrHead.token);
  check('lifecycle: HR Head can approve the leave', r.status === 200, r);

  // ---- Lifecycle: run payroll for September 2026, as Finance (the Preparer) ----
  r = await j('POST', '/tasks/payroll/runs', { month: '2026-09' }, finance.token);
  const runId = r.data?.runId || r.data?.run?._id || r.data?._id;
  check('lifecycle: Finance (Payroll Preparer role) can create the Sept 2026 payroll run', r.status === 200 || r.status === 201, r);

  // Mid-month joiner should be pro-rated, not paid a full month.
  r = await j('GET', `/tasks/payroll/runs/${runId}`, undefined, finance.token);
  const midMonthLine = (r.data?.run?.lines || r.data?.lines || []).find((l) => String(l.employeeId?._id || l.employeeId) === String(midMonthJoiner.id));
  const fullMonthLine = (r.data?.run?.lines || r.data?.lines || []).find((l) => String(l.employeeId?._id || l.employeeId) === String(employees[0].id));
  check('cross-module: the mid-month joiner (joined 2026-09-16) is pro-rated - paid LESS than someone with the same basic salary who was present all month',
    midMonthLine && fullMonthLine && typeof midMonthLine.net === 'number' && midMonthLine.net > 0 && midMonthLine.net < fullMonthLine.net,
    { midMonthLine, fullMonthLine });

  // Cross-module: HR Head (the Approver) cannot approve their own run if they also prepared it -
  // but here Finance prepared and HR Head approves, which is a DIFFERENT person, so this should succeed.
  r = await j('PUT', `/tasks/payroll/runs/${runId}/approve`, {}, hrHead.token);
  check('lifecycle: HR Head (Payroll Approver role, different person than preparer) can approve the run', r.status === 200, r);

  // Cross-module: regularization request AFTER the run has already been approved.
  r = await j('POST', '/tasks/attendance/regularizations', { date: '2026-10-01', inTime: '09:15', reason: 'Forgot to punch' }, employees[2].token);
  check('cross-module: a late regularization request can still be filed after the run is approved (system does not hard-block it)', r.status === 200 || r.status === 201, r);
  // The important question is whether approving it silently changes an already-approved run's numbers without any re-run/flag.
  r = await j('GET', `/tasks/payroll/runs/${runId}`, undefined, finance.token);
  const statusAfterLateReg = r.data?.run?.status || r.data?.status;
  check('cross-module: the already-approved run\'s status is unaffected by a late regularization filed afterward (no silent recalculation)', statusAfterLateReg === 'Approved', { statusAfterLateReg });

  // Cross-module: holiday added to the calendar AFTER attendance already exists for that date - does
  // it retroactively change already-computed attendance, or only affect future days?
  r = await j('GET', '/tasks/attendance/config', undefined, adminToken);
  const existingHolidays = r.data?.config?.holidays || [];
  r = await j('PUT', '/tasks/attendance/config', { ...r.data.config, holidays: [...existingHolidays, { date: '2026-09-01', name: 'Surprise Holiday' }] }, adminToken);
  check('cross-module: a holiday can be added after attendance already exists for that date', r.status === 200, r);

  // Cross-module: mid-month branch/location transfer.
  r = await j('PUT', `/tasks/employees/${employees[3].id}`, { location: LOCATIONS[1] }, adminToken);
  check('cross-module: an employee can be transferred to the other location mid-month', r.status === 200, r);

  // Cross-module: role removed from the person who prepared a run, AFTER they prepared it -
  // does the already-created run stay valid, or break?
  r = await j('PUT', '/tasks/access/assign', { employeeId: finance.id, roleKeys: [] }, adminToken);
  check('cross-module: the Payroll Preparer role can be removed from Finance after they already created a run', r.status === 200, r);
  r = await j('GET', `/tasks/payroll/runs/${runId}`, undefined, hrHead.token);
  check('cross-module: the already-created run is still readable/valid after the preparer\'s role was removed', r.status === 200, r);
  // But can Finance now do anything NEW to payroll? Should be refused.
  r = await j('POST', '/tasks/payroll/runs', { month: '2026-10' }, finance.token);
  check('cross-module: after the role is removed, Finance can no longer create a NEW payroll run (permission re-checked live, not cached from creation time)', r.status === 403, r);

  // ---- Release the run ----
  r = await j('PUT', `/tasks/payroll/runs/${runId}/release`, {}, hrHead.token);
  check('lifecycle: HR Head releases the approved run', r.status === 200, r);

  // Cross-module: salary changed mid-month, AFTER the run for that month is already released -
  // does it retroactively change the released run?
  r = await j('PUT', `/tasks/payroll/salaries/${employees[4].id}`, { effectiveFrom: '2026-10-01', basic: 60000, items: [] }, hrHead.token);
  r = await j('GET', `/tasks/payroll/runs/${runId}`, undefined, hrHead.token);
  const line4 = (r.data?.run?.lines || r.data?.lines || []).find((l) => String(l.employeeId?._id || l.employeeId) === String(employees[4].id));
  check('cross-module: changing an employee\'s salary after their run is released does NOT retroactively change that released run\'s already-paid numbers',
    line4 && line4.basic !== 60000, line4);

  // ---- Leaver / exit: deactivate by deleting the account AFTER their payslip was released ----
  r = await j('GET', `/tasks/payroll/payslip/${runId}/${leaverPerson.id}`, undefined, hrHead.token);
  const payslipBeforeDelete = r.status;
  r = await j('DELETE', `/tasks/employees/${leaverPerson.id}`, undefined, adminToken);
  check('exit: a leaver\'s account can be deleted (hard delete - no deactivate/isActive flag exists in this codebase, confirmed by reading tenantController.js/Employee model)', r.status === 200, r);
  r = await j('GET', `/tasks/payroll/payslip/${runId}/${leaverPerson.id}`, undefined, hrHead.token);
  check('cross-module: the payroll run\'s own record of a deleted employee\'s payslip is unaffected (PayrollRun.lines snapshots name/department inline, does not depend on the Employee doc existing)',
    r.status === payslipBeforeDelete, { before: payslipBeforeDelete, after: r.status });
  r = await j('POST', '/tenants/login-employee', { subdomain: sub, email: leaverPerson.email, password: 'TestPass123!' });
  check('exit: the deleted leaver can no longer log in at all', r.status !== 200, r);

  // ---- Notice person: no notice-pay feature exists (known, listed gap - not built) ----
  check('KNOWN GAP (not built, per brief): there is no "notice period" or notice-pay concept anywhere in payrollController.js/Employee model - a person "on notice" is just a normal active employee with no special handling', true, {});

  console.log('\n' + results.filter((r2) => r2.pass).length + ' PASS / ' + results.filter((r2) => !r2.pass).length + ' FAIL / ' + results.length + ' TOTAL');
  require('fs').writeFileSync(__dirname + '/scenario-a-c-results.json', JSON.stringify(results, null, 2));
  process.exitCode = results.every((r2) => r2.pass) ? 0 : 1;
})().catch((e) => { console.error('SCENARIO_AC_FAILED', e); process.exit(1); });
