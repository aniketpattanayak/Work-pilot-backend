// fix/chat-task-thread-and-composer (backend): GET /api/tasks/:taskId is a
// NEW route, added only because the frontend's task-thread details card
// needs a way to fetch one task's title/deadline/status/assigner/doer - no
// such single-task GET route existed before this branch. Same "who is part
// of this task" permission shape as handleRevision: the assigner/
// coordinator/forward-chain side, the doer side (doer, a helper doer, or an
// on-leave doer's buddy), a listed coworker, or an Admin/superadmin in the
// same tenant are allowed; everyone else - including a same-company
// bystander and a cross-tenant caller - is blocked.
//
// NOTE: this environment cannot reach a real MongoDB (no mongod binary,
// and fastdl.mongodb.org/repo.mongodb.org are blocked by this sandbox's
// egress allowlist - the same limitation noted on earlier branches this
// session), so this script could not actually be executed here. It is
// written in the same request-driven style as
// scripts/fix-respond-tenant-isolation/test-respond-roles-regression.js so
// it can be run wherever a MongoDB instance is reachable (e.g. CI, or a
// dev machine with mongod installed) - `node scripts/chat-task-thread/test-get-task-by-id-regression.js`.
process.env.PORT = process.env.PORT || '5198';

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
  const subA = 'zzz-gettaskA-' + Date.now();
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

  const assigner = { id: adminIdA, token: adminTokenA, name: 'Admin (assigner)' };
  const doer = await addEmp('Doer Real', '9999966601');
  const coordinator = await addEmp('Coord Real', '9999966602');
  const helper = await addEmp('Helper Real', '9999966603');
  const forwardMember = await addEmp('Forward Real', '9999966604');
  const coworker = await addEmp('Coworker Real', '9999966605');
  const bystander = await addEmp('Bystander Real', '9999966606');
  const buddy = await addEmp('Buddy Real', '9999966607');
  check('setup: all roles created and can log in',
    [doer, coordinator, helper, forwardMember, coworker, bystander, buddy].every((e) => !!e.id && !!e.token),
    { doer, coordinator, helper, forwardMember, coworker, bystander, buddy });

  // --- Tenant B: a different company, for the cross-tenant block case -------
  const subB = 'zzz-gettaskB-' + Date.now();
  fd = new FormData();
  fd.append('companyName', subB); fd.append('subdomain', subB);
  fd.append('ownerEmail', `admin@${subB}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subB, email: `admin@${subB}.test`, password: 'TestPass123!' });
  const adminTokenB = r.data.token;
  check('setup: tenant B (a different company) created, admin can log in', r.status === 200 && !!adminTokenB, r);

  // Mark the doer as on leave with `buddy` covering, via Mongo directly
  // (leaveStatus.buddyId isn't settable through any task-creation endpoint).
  const mongoose = require('mongoose');
  const EmployeeModel = mongoose.connection.useDb(`tenant_${tenantA}`).model(
    'Employee', require('../../models/Employee').schema
  );
  await EmployeeModel.findByIdAndUpdate(doer.id, { leaveStatus: { onLeave: true, buddyId: buddy.id } });

  // --- Create a task with the full cast wired in ----------------------------
  fd = new FormData();
  fd.append('title', 'Get-task-by-id regression task');
  fd.append('description', 'desc');
  fd.append('doerId', doer.id);
  fd.append('deadline', new Date(Date.now() + 86400000).toISOString());
  fd.append('priority', 'Medium');
  fd.append('coworkers', JSON.stringify([coworker.id]));
  r = await j(BASE, 'POST', '/tasks/create-task', undefined, assigner.token);
  // create-task needs multipart; redo with fetch directly since j() only does JSON
  const createRes = await fetch(BASE + '/tasks/create-task', { method: 'POST', headers: { Authorization: `Bearer ${assigner.token}` }, body: fd });
  const created = await createRes.json();
  const taskId = created?.task?._id || created?._id;
  check('setup: task created', createRes.status === 200 || createRes.status === 201, created);

  // Wire coordinatorId / helperDoers / forwardChain directly (same approach
  // the existing respond-roles regression test uses - these aren't settable
  // through create-task).
  const DelegationTaskModel = mongoose.connection.useDb(`tenant_${tenantA}`).model(
    'DelegationTask', require('../../models/DelegationTask').schema
  );
  await DelegationTaskModel.findByIdAndUpdate(taskId, {
    coordinatorId: coordinator.id,
    helperDoers: [{ helperId: helper.id, name: helper.name }],
    forwardChain: [{ employeeId: forwardMember.id }],
  });

  // --- Allowed: every legitimate role can read the task ----------------------
  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, assigner.token);
  check('assigner can GET the task', r.status === 200 && r.data.title === 'Get-task-by-id regression task', r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, doer.token);
  check('doer can GET the task', r.status === 200, r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, coordinator.token);
  check('coordinator can GET the task', r.status === 200, r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, helper.token);
  check('helper doer can GET the task', r.status === 200, r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, forwardMember.token);
  check('forward-chain member can GET the task', r.status === 200, r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, coworker.token);
  check('coworker can GET the task', r.status === 200, r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, buddy.token);
  check('the on-leave doer\'s buddy can GET the task', r.status === 200, r);

  // --- Blocked: a same-company bystander and a different company -----------
  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, bystander.token);
  check('an unrelated same-company employee is blocked (403)', r.status === 403, r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, adminTokenB);
  check('a different company\'s admin is blocked (403, not just an empty result)', r.status === 403, r);

  // --- Response shape --------------------------------------------------------
  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, assigner.token);
  check('response includes assignerId.name and doerId.name (for "assigned by -> assigned to")',
    r.data?.assignerId?.name && r.data?.doerId?.name, r);
  check('response includes wasRevised:false for a never-revised task', r.data?.wasRevised === false, r);

  // --- Not found / invalid id --------------------------------------------
  r = await j(BASE, 'GET', `/tasks/000000000000000000000000`, undefined, assigner.token);
  check('a well-formed but nonexistent task id returns 404', r.status === 404, r);

  r = await j(BASE, 'GET', `/tasks/not-an-id`, undefined, assigner.token);
  check('a malformed task id returns 400, not a 500', r.status === 400, r);

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  require('fs').writeFileSync(__dirname + '/results-get-task-by-id-regression.json', JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
