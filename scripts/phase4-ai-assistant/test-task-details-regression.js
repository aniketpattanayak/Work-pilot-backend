// Part 3 follow-up (AI-layer-v2): GET /api/tasks/:taskId (task_details).
// This route didn't exist before - it was reported as a confirmed gap, and
// was added on explicit instruction, with the SAME tenant-isolation and
// reach checks the rest of the task routes already use. This test proves:
//  - the assigner can read their own task;
//  - the doer can read it too;
//  - a DIFFERENT company's user gets 404 (not 403 - never confirms the id
//    exists to someone outside the tenant);
//  - a same-company employee who is not assigner/doer/coordinator/helper/
//    forward-chain also gets 404 (not shown just because they share a tenant);
//  - the task_details tool wires to this same route end to end.
process.env.PORT = process.env.PORT || '5099';

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

  // --- Tenant A: assigner, doer, and an unrelated same-company employee ----
  const subA = 'zzz-taskdeta-' + Date.now();
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
    whatsappNumber: '9999977771', roles: ['Doer'], password: 'TestPass123!',
  }, adminTokenA);
  const doerAId = r.data?.employee?._id;
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subA, email: r.data?.employee?.email, password: 'TestPass123!' });
  const doerAToken = r.data.token;
  check('setup: doer A can log in', r.status === 200 && !!doerAToken, r);

  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId: tenantA, name: 'Bystander A', email: `bystander-${Date.now()}@${subA}.test`, department: 'Ops',
    whatsappNumber: '9999977772', roles: ['Doer'], password: 'TestPass123!',
  }, adminTokenA);
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subA, email: r.data?.employee?.email, password: 'TestPass123!' });
  const bystanderToken = r.data.token;
  check('setup: an unrelated same-company employee can log in', r.status === 200 && !!bystanderToken, r);

  r = await j(BASE, 'POST', '/tasks/create-task', {
    tenantId: tenantA, assignerId: adminIdA, title: 'Task detail visibility check',
    doerId: doerAId, deadline: new Date(Date.now() + 86400000).toISOString(), priority: 'Medium',
  }, adminTokenA);
  const taskId = r.data?.task?._id;
  check('setup: a real task exists', !!taskId, r.data);

  // --- Tenant B: a different company entirely -----------------------------
  const subB = 'zzz-taskdetb-' + Date.now();
  fd = new FormData();
  fd.append('companyName', subB); fd.append('subdomain', subB);
  fd.append('ownerEmail', `admin@${subB}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: subB, email: `admin@${subB}.test`, password: 'TestPass123!' });
  const adminTokenB = r.data.token;
  check('setup: tenant B (a different company) created, admin can log in', r.status === 200 && !!adminTokenB, r);

  // --- Assertions ------------------------------------------------------------
  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, adminTokenA);
  check('the assigner/admin can read the task', r.status === 200 && r.data?.task?.title === 'Task detail visibility check', r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, doerAToken);
  check('the doer can read the task too', r.status === 200 && r.data?.task?._id === taskId, r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, bystanderToken);
  check('an unrelated employee IN THE SAME company gets 404, not the task', r.status === 404, r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, adminTokenB);
  check('a user from a COMPLETELY DIFFERENT company gets 404, not 403 (never confirms the id exists)', r.status === 404, r);

  r = await j(BASE, 'GET', `/tasks/${taskId}`, undefined, undefined);
  check('no token at all is rejected (401), not leaked as 404/200', r.status === 401, r);

  // --- task_details tool wiring --------------------------------------------
  const { executeTool } = require('../../utils/aiAssistant/executor');
  const out = await executeTool('task_details', { taskId }, adminTokenA, { id: adminIdA, tenantId: tenantA });
  check('task_details tool: wires to the real GET /tasks/:taskId route and returns the task', out?.status === 200 && out?.data?.task?._id === taskId, out);

  const outBlocked = await executeTool('task_details', { taskId }, bystanderToken, { id: 'n/a', tenantId: tenantA });
  check('task_details tool: an unrelated employee still gets refused through the tool, same as direct HTTP', outBlocked?.status === 404, outBlocked);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} PASS / ${total - passed} FAIL / ${total} TOTAL`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
