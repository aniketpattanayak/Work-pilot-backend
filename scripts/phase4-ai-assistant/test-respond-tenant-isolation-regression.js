// Part 7 eval finding: PUT /api/tasks/respond (the route behind the
// `complete_task` AI tool) had NO tenant-isolation or ownership check at
// all - any authenticated caller who knew (or was handed, e.g. by the AI
// assistant acting on a user-supplied id) a taskId from ANY tenant, or any
// employee unrelated to the task within their OWN tenant, could mark it
// Completed/Verified/etc. This was caught by the Part 7 eval's
// cross_company category (case E048: tenant A's admin completing a tenant
// B task actually succeeded with a real 200). Fixed by adding the same
// tenant + reach checks updateTask/deleteTask/getTaskById already use.
// This test proves: a legitimate doer can still complete their own task,
// a DIFFERENT company's user is blocked (404, never confirming the id
// exists), and an unrelated SAME-company employee is blocked too (403).
process.env.PORT = process.env.PORT || '5197';

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

  // --- Tenant A: admin/assigner, the real doer, and an unrelated bystander -
  const subA = 'zzz-respond-' + Date.now();
  let fd = new FormData();
  fd.append('companyName', subA); fd.append('subdomain', subA);
  fd.append('ownerEmail', `admin@${subA}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subA, email: `admin@${subA}.test`, password: 'TestPass123!' });
  const adminTokenA = r.data.token, tenantA = r.data.tenantId;
  check('setup: tenant A created, admin can log in', r.status === 200 && !!adminTokenA, r);
  const adminIdA = JSON.parse(Buffer.from(adminTokenA.split('.')[1], 'base64').toString()).id;

  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId: tenantA, name: 'Doer A', email: `doera-${Date.now()}@${subA}.test`, department: 'Ops',
    whatsappNumber: '9999966661', roles: ['Doer'], password: 'TestPass123!',
  }, adminTokenA);
  const doerAId = r.data?.employee?._id;
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subA, email: r.data?.employee?.email, password: 'TestPass123!' });
  const doerAToken = r.data.token;
  check('setup: doer A can log in', r.status === 200 && !!doerAToken, r);

  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId: tenantA, name: 'Bystander A', email: `bystander-${Date.now()}@${subA}.test`, department: 'Ops',
    whatsappNumber: '9999966662', roles: ['Doer'], password: 'TestPass123!',
  }, adminTokenA);
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subA, email: r.data?.employee?.email, password: 'TestPass123!' });
  const bystanderToken = r.data.token;
  check('setup: an unrelated same-company employee can log in', r.status === 200 && !!bystanderToken, r);

  // --- Tenant B: a different company entirely ------------------------------
  const subB = 'zzz-respondb-' + Date.now();
  fd = new FormData();
  fd.append('companyName', subB); fd.append('subdomain', subB);
  fd.append('ownerEmail', `admin@${subB}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subB, email: `admin@${subB}.test`, password: 'TestPass123!' });
  const adminTokenB = r.data.token;
  check('setup: tenant B (a different company) created, admin can log in', r.status === 200 && !!adminTokenB, r);

  // --- Case 1: a same-company bystander (not assigner/doer/helper/chain) --
  r = await j(BASE, 'POST', '/tasks/create-task', {
    tenantId: tenantA, assignerId: adminIdA, title: 'Respond isolation check 1',
    doerId: doerAId, deadline: new Date(Date.now() + 86400000).toISOString(), priority: 'Medium',
  }, adminTokenA);
  const task1Id = r.data?.task?._id;
  check('setup: task 1 exists', !!task1Id, r.data);

  r = await j(BASE, 'PUT', '/tasks/respond', { taskId: task1Id, status: 'Completed' }, bystanderToken);
  check('an unrelated SAME-company employee is blocked (403), not allowed to complete someone else\'s task', r.status === 403, r);

  // --- Case 2: a COMPLETELY DIFFERENT company's admin (the real E048 bug) -
  r = await j(BASE, 'POST', '/tasks/create-task', {
    tenantId: tenantA, assignerId: adminIdA, title: 'Respond isolation check 2',
    doerId: doerAId, deadline: new Date(Date.now() + 86400000).toISOString(), priority: 'Medium',
  }, adminTokenA);
  const task2Id = r.data?.task?._id;
  check('setup: task 2 exists', !!task2Id, r.data);

  r = await j(BASE, 'PUT', '/tasks/respond', { taskId: task2Id, status: 'Completed' }, adminTokenB);
  check('a DIFFERENT company\'s admin is blocked (404, never confirms the id exists) - this was the real bug found by Part 7\'s eval (E048)', r.status === 404, r);

  // Confirm it genuinely did NOT get completed by the blocked cross-tenant call.
  r = await j(BASE, 'GET', `/tasks/${task2Id}`, undefined, adminTokenA);
  check('the task was NOT actually completed by the blocked cross-tenant attempt', r.status === 200 && r.data?.task?.status !== 'Completed', r);

  // --- Case 3: the legitimate doer can still complete their own task ------
  r = await j(BASE, 'PUT', '/tasks/respond', { taskId: task2Id, status: 'Completed' }, doerAToken);
  check('the legitimate doer can still mark their own task Completed (no regression)', r.status === 200, r);

  // --- complete_task tool wiring, end to end -------------------------------
  const { executeTool } = require('../../utils/aiAssistant/executor');
  const outBlocked = await executeTool('complete_task', { taskId: task1Id }, adminTokenB, { id: 'n/a', tenantId: 'other' });
  check('complete_task tool: a different company\'s caller is refused through the tool too, same as direct HTTP', outBlocked?.status === 404, outBlocked);

  const outOk = await executeTool('complete_task', { taskId: task1Id }, doerAToken, { id: doerAId, tenantId: tenantA });
  check('complete_task tool: the legitimate doer still succeeds through the tool', outOk?.status === 200, outOk);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} PASS / ${total - passed} FAIL / ${total} TOTAL`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
