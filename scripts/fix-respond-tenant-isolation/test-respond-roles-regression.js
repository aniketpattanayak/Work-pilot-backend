// fix/respond-task-tenant-isolation: PUT /api/tasks/respond had NO
// tenant-isolation or ownership check at all. Fixed by allowing every role
// that legitimately has a stake in a task (doer, assigner, coordinator,
// helper doer, forward-chain member, the doer's buddy cover via
// leaveStatus.buddyId, Admin/superAdmin manager override) and blocking
// everyone else - same tenant or not. task.coworkers is deliberately NOT
// allowed (see the "Coworker block check" case below for why). One case
// per legitimate role, plus the block cases: a different company, an
// unrelated same-company employee, a non-buddy, a cross-company buddy-id
// reuse, and a coworker.
process.env.PORT = process.env.PORT || '5199';

const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 400));
}

async function j(base, method, p, body, token) {
  const headers = { Authorization: token ? `Bearer ${token}` : undefined };
  let sendBody;
  if (body !== undefined && method !== 'GET') { headers['Content-Type'] = 'application/json'; sendBody = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers, body: sendBody });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

(async () => {
  require('../../index.js');
  await new Promise((r) => setTimeout(r, 5000));
  const BASE = `http://localhost:${process.env.PORT}/api`;

  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  // --- Tenant A: a full cast of roles ---------------------------------------
  const subA = 'zzz-rolesresp-' + Date.now();
  let fd = new FormData();
  fd.append('companyName', subA); fd.append('subdomain', subA);
  fd.append('ownerEmail', `admin@${subA}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subA, email: `admin@${subA}.test`, password: 'TestPass123!' });
  const adminTokenA = r.data.token, tenantA = r.data.tenantId;
  check('setup: tenant A created, admin can log in', r.status === 200 && !!adminTokenA, r);
  const adminIdA = JSON.parse(Buffer.from(adminTokenA.split('.')[1], 'base64').toString()).id;

  async function addEmp(name, whatsapp) {
    const email = `${name.replace(/\s+/g, '').toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@${subA}.test`;
    const rr = await j(BASE, 'POST', '/tasks/add-employee', {
      tenantId: tenantA, name, email, department: 'Ops', whatsappNumber: whatsapp, roles: ['Doer'], password: 'TestPass123!',
    }, adminTokenA);
    const id = rr.data?.employee?._id;
    const lr = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subA, email, password: 'TestPass123!' });
    return { id, token: lr.data.token, name };
  }

  const assigner = { id: adminIdA, token: adminTokenA, name: 'Admin (assigner)' }; // the admin IS the assigner on these tasks
  const doer = await addEmp('Doer Real', '9999955501');
  const coordinator = await addEmp('Coord Real', '9999955502');
  const helper = await addEmp('Helper Real', '9999955503');
  const forwardMember = await addEmp('Forward Real', '9999955504');
  const bystander = await addEmp('Bystander Real', '9999955505');
  check('setup: doer/coordinator/helper/forward/bystander all created and can log in',
    [doer, coordinator, helper, forwardMember, bystander].every((e) => !!e.id && !!e.token), { doer, coordinator, helper, forwardMember, bystander });

  // --- Tenant B: a different company ----------------------------------------
  const subB = 'zzz-rolesrespb-' + Date.now();
  fd = new FormData();
  fd.append('companyName', subB); fd.append('subdomain', subB);
  fd.append('ownerEmail', `admin@${subB}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subB, email: `admin@${subB}.test`, password: 'TestPass123!' });
  const adminTokenB = r.data.token;
  check('setup: tenant B (a different company) created, admin can log in', r.status === 200 && !!adminTokenB, r);

  // Helper: create a fresh task with the given relationship fields set directly
  // in Mongo (coordinatorId/helperDoers/forwardChain aren't settable via the
  // create-task API today, so we create via API then patch the document
  // directly through the same tenant-scoped model the controller itself uses,
  // to test the PERMISSION CHECK, not the (separate, out-of-scope) question of
  // how those fields get populated in normal product use).
  const mongoose = require('mongoose');
  async function makeTask(title) {
    const rr = await j(BASE, 'POST', '/tasks/create-task', {
      tenantId: tenantA, assignerId: adminIdA, title,
      doerId: doer.id, deadline: new Date(Date.now() + 86400000).toISOString(), priority: 'Medium',
    }, adminTokenA);
    return rr.data?.task?._id;
  }

  async function setRelationships(taskId, { coordinatorId, helperIds, forwardIds, coworkerIds }) {
    const DelegationTask = mongoose.model('DelegationTask');
    const update = {};
    if (coordinatorId) update.coordinatorId = coordinatorId;
    if (helperIds) update.helperDoers = helperIds.map((id) => ({ helperId: id }));
    if (forwardIds) update.forwardChain = forwardIds.map((id) => ({ employeeId: id }));
    if (coworkerIds) update.coworkers = coworkerIds;
    await DelegationTask.findByIdAndUpdate(taskId, update);
  }

  // Sets the given employee's leaveStatus.buddyId directly, the same field
  // getDoerTasks reads ('leaveStatus.buddyId': doerId) to show a buddy their
  // covered colleague's tasks.
  async function setBuddy(employeeId, buddyId) {
    const Employee = mongoose.model('Employee');
    await Employee.findByIdAndUpdate(employeeId, {
      'leaveStatus.onLeave': true,
      'leaveStatus.startDate': new Date(),
      'leaveStatus.endDate': new Date(Date.now() + 86400000),
      'leaveStatus.buddyId': buddyId,
    });
  }

  // --- Case: the DOER can complete their own task ---------------------------
  let taskId = await makeTask('Doer role check');
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Completed', doerId: doer.id }, doer.token);
  check('the DOER can mark their own task Completed', r.status === 200, r);

  // --- Case: the ASSIGNER (here, the admin) can verify/send back -----------
  taskId = await makeTask('Assigner role check');
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Verified', doerId: adminIdA }, adminTokenA);
  check('the ASSIGNER can verify the task', r.status === 200, r);

  // --- Case: an ADMIN manager-override on a task they didn't assign --------
  // Add a second admin to prove it's the ADMIN ROLE, not just "the assigner".
  const secondAdminEmail = `admin2-${Date.now()}@${subA}.test`;
  await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId: tenantA, name: 'Second Admin', email: secondAdminEmail, department: 'Management',
    whatsappNumber: '9999955510', roles: ['Admin'], password: 'TestPass123!',
  }, adminTokenA);
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subA, email: secondAdminEmail, password: 'TestPass123!' });
  const secondAdminToken = r.data.token;
  taskId = await makeTask('Manager override check');
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Verified' }, secondAdminToken);
  check('a SECOND ADMIN (manager override, not the original assigner) can still act on the task', r.status === 200, r);

  // --- Case: the COORDINATOR can act -----------------------------------------
  taskId = await makeTask('Coordinator role check');
  await setRelationships(taskId, { coordinatorId: coordinator.id });
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Verified', doerId: coordinator.id }, coordinator.token);
  check('the COORDINATOR can act on the task (quality reviewer role)', r.status === 200, r);

  // --- Case: a HELPER DOER (buddy/cover) can act -----------------------------
  taskId = await makeTask('Helper doer role check');
  await setRelationships(taskId, { helperIds: [helper.id] });
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Completed', doerId: helper.id }, helper.token);
  check('a HELPER DOER (buddy/cover) can complete the task on the primary doer\'s behalf', r.status === 200, r);

  // --- Case: a FORWARD-CHAIN member can act -----------------------------------
  taskId = await makeTask('Forward chain role check');
  await setRelationships(taskId, { forwardIds: [forwardMember.id] });
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Completed', doerId: forwardMember.id }, forwardMember.token);
  check('a FORWARD-CHAIN member (task was passed onward to them) can act on the task', r.status === 200, r);

  // --- Case: the doer's BUDDY COVER (leaveStatus.buddyId) can act -----------
  // Same lookup getDoerTasks uses to show a buddy their colleague's tasks
  // while that colleague is on leave - the buddy must also be able to
  // actually complete those tasks, not just see them.
  const buddy = await addEmp('Buddy Real', '9999955506');
  taskId = await makeTask('Buddy cover role check');
  await setBuddy(doer.id, buddy.id);
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Completed', doerId: buddy.id }, buddy.token);
  check('the doer\'s BUDDY COVER (leaveStatus.buddyId) can complete the task while the doer is on leave', r.status === 200, r);

  // --- Block case: someone who is NOT the buddy, same company, is still blocked ---
  taskId = await makeTask('Not-the-buddy block check');
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Completed' }, bystander.token);
  check('a SAME-company employee who is NOT the buddy is BLOCKED (403)', r.status === 403, r);

  // --- Block case: the buddy relationship does not cross companies ----------
  // Tenant B's admin reusing Tenant A's buddy id - must be blocked by the
  // tenant check before the buddy check is ever reached.
  taskId = await makeTask('Cross-company buddy block check');
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Completed', doerId: buddy.id }, adminTokenB);
  check('a cross-company caller is BLOCKED (404) even if they happen to share a buddy id value', r.status === 404, r);

  // --- Finding (not a permission case): task.coworkers never gets a
  // "Complete" action from the frontend today. getDoerTasks's own query
  // (doerId / helperDoers.helperId / the buddy lookup / forwardChain) never
  // matches on coworkers, and neither TaskCard.jsx nor DoerChecklist.jsx
  // read task.coworkers anywhere - so a coworker is treated the same as any
  // other unrelated same-company employee here, deliberately.
  const coworker = await addEmp('Coworker Real', '9999955507');
  taskId = await makeTask('Coworker block check');
  await setRelationships(taskId, { coworkerIds: [coworker.id] });
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Completed', doerId: coworker.id }, coworker.token);
  check('a task.coworkers member is BLOCKED (403) - matches the frontend, which gives them no respond action', r.status === 403, r);

  // --- Block case: an unrelated SAME-company bystander -----------------------
  taskId = await makeTask('Bystander block check');
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Completed' }, bystander.token);
  check('an unrelated SAME-company employee is BLOCKED (403)', r.status === 403, r);

  // --- Block case: a COMPLETELY DIFFERENT company's admin --------------------
  taskId = await makeTask('Cross-company block check');
  const DelegationTaskCheck = mongoose.model('DelegationTask');
  const beforeStatus = (await DelegationTaskCheck.findById(taskId))?.status;
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId, status: 'Completed' }, adminTokenB);
  check('a DIFFERENT company\'s admin is BLOCKED (404, never confirms the id exists)', r.status === 404, r);

  // Confirm the blocked attempt did NOT change anything, whatever the task's
  // actual starting status was (this flow auto-advances new tasks past
  // "Pending" immediately, unrelated to this fix - not asserting a specific
  // value, just that the blocked call made no difference).
  const afterStatus = (await DelegationTaskCheck.findById(taskId))?.status;
  check('the cross-company blocked attempt did NOT change the task status', afterStatus === beforeStatus, { beforeStatus, afterStatus });

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} PASS / ${total - passed} FAIL / ${total} TOTAL`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
