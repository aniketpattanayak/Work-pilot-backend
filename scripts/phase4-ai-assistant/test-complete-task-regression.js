// Regression test for item 1c: complete_task must actually send
// status: 'Completed' to PUT /api/tasks/respond. Before this fix, the tool's
// autoFields did not set `status` at all, so respondToTask (which requires
// `status` in the body to do anything meaningful) ran with an undefined
// status - the HTTP call still returned 200, but the task's real status in
// the database never changed. Proves the task really becomes Completed, not
// just that the endpoint returned 200.
process.env.PORT = process.env.PORT || '5093';

const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 300));
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
  await new Promise((r) => setTimeout(r, 2500));
  const BASE = `http://localhost:${process.env.PORT}/api`;

  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  const sub = 'zzz-completetask-' + Date.now();
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token;
  const tenantId = r.data.tenantId;
  check('setup: tenant created, admin can log in', r.status === 200 && !!adminToken, r);

  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'Task Doer', email: `doer-${Date.now()}@${sub}.test`, department: 'Ops',
    whatsappNumber: '9999999993', roles: ['Doer'], password: 'TestPass123!',
  }, adminToken);
  const doerId = r.data?.employee?._id || r.data?._id;
  check('setup: doer created', !!doerId, r);

  r = await j(BASE, 'POST', '/tasks/create-task', { title: 'Finish the thing', doerId, assignerId: doerId, tenantId, deadline: '2026-12-01' }, adminToken);
  const taskId = r.data?.task?._id || r.data?._id;
  check('setup: a real task exists, not yet completed', !!taskId, r);

  await j(BASE, 'PUT', `/superadmin/tenants/${tenantId}/ai-assistant`, { enabled: true, monthlyLimit: 10000 }, superToken);

  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ messages }) => {
    const text = (messages[0]?.content || '').toString();
    const m = text.match(/COMPLETE_TASK_REGRESSION:(\S+)/);
    if (m) return { toolUse: { name: 'complete_task', input: { taskId: m[1] } }, text: '' };
    return { toolUse: null, text: 'unhandled' };
  };

  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: `COMPLETE_TASK_REGRESSION:${taskId}` }, adminToken);
  check('complete_task stages correctly', r.status === 200 && r.data.needsConfirmation === true, r);
  const confirmId = r.data.confirmId;

  r = await j(BASE, 'POST', '/ai-assistant/chat', { confirmId }, adminToken);
  check('confirming runs the PUT /tasks/respond call (200)', r.status === 200 && !!r.data.result, r);
  check('the executor really sent status: "Completed" in the request body', r.data.result?.data?.message !== 'Protocol Error: Task ID is missing. Ensure fields are sent before files in FormData.', r.data.result);

  // The real, decisive assertion: read the task back and check its ACTUAL status field.
  r = await j(BASE, 'GET', `/tasks/doer/${doerId}`, undefined, adminToken);
  const task = (Array.isArray(r.data) ? r.data : []).find((t) => String(t._id) === String(taskId));
  check('the task\'s real status in the database is now "Completed" (not still "Pending"/undefined)',
    task && task.status === 'Completed', task);

  console.log('\n' + results.filter((r2) => r2.pass).length + ' PASS / ' + results.filter((r2) => !r2.pass).length + ' FAIL / ' + results.length + ' TOTAL');
  require('fs').writeFileSync(__dirname + '/results-complete-task-regression.json', JSON.stringify(results, null, 2));
  process.exitCode = results.every((r2) => r2.pass) ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 500);
})().catch((e) => { console.error('COMPLETE_TASK_REGRESSION_FAILED', e); process.exit(1); });
