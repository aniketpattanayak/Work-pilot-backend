// Regression tests for feature/task-media-history-ux (backend half):
//   1. PUT /tasks/respond accepts MULTIPLE evidence files (not just one),
//      pushing every one of them onto task.files.
//   2. respondToTask persists remarks for ANY status change, not just
//      'Revision Requested'/'Completed' - previously a reject-style
//      ('Accepted', sent back for correction) remarks were silently
//      dropped, which meant the doer never saw why a task was rejected.
//
// Deliberately plain HTTP checks against the real running backend (no
// Jest/mongodb-memory-server), same style as
// scripts/release-security-fixes/test-security-fixes-regression.js.
process.env.PORT = process.env.PORT || '5092';

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

function pngBlob() {
  // Smallest possible valid 1x1 PNG, as bytes.
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  return new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' });
}

(async () => {
  require('../../index.js');
  await new Promise((r) => setTimeout(r, 2500));
  const BASE = `http://localhost:${process.env.PORT}/api`;

  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  const sub = `zzz-mediaux-${Date.now()}`;
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const tenantId = r.data.tenantId;
  const adminToken = r.data.token;
  const adminId = r.data.employee?._id || r.data._id || r.data.user?._id;
  check('setup: tenant created, admin logged in', r.status === 200 && !!tenantId && !!adminToken, r);

  // Create a Doer employee under this tenant.
  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'Doer One', email: `doer@${sub}.test`, password: 'TestPass123!', roles: ['Doer'],
  }, adminToken);
  check('setup: doer employee created', r.status === 200 || r.status === 201, r);
  const doerId = r.data?.employee?._id || r.data?._id;

  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `doer@${sub}.test`, password: 'TestPass123!' });
  const doerToken = r.data.token;
  check('setup: doer can log in', r.status === 200 && !!doerToken, r);

  // Create a delegation task (assigner = admin, doer = Doer One).
  const taskFd = new FormData();
  taskFd.append('tenantId', tenantId);
  taskFd.append('title', 'Media UX regression task');
  taskFd.append('description', 'Testing multi-file evidence + remarks persistence');
  taskFd.append('assignerId', adminId);
  taskFd.append('doerId', doerId);
  taskFd.append('deadline', new Date(Date.now() + 86400000).toISOString());
  r = await fetch(BASE + '/tasks/create-task', { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: taskFd });
  let taskData = await r.json().catch(() => ({}));
  check('setup: delegation task created', r.status === 200 || r.status === 201, { status: r.status, taskData });
  const taskId = taskData?._id || taskData?.task?._id;

  // --- TEST 1: doer completes the task with TWO evidence photos + remarks ---
  const completeFd = new FormData();
  completeFd.append('taskId', taskId);
  completeFd.append('status', 'Completed');
  completeFd.append('doerId', doerId);
  completeFd.append('remarks', 'Finished both parts, see photos.');
  completeFd.append('evidence', pngBlob(), 'proof1.png');
  completeFd.append('evidence', pngBlob(), 'proof2.png');
  r = await fetch(BASE + '/tasks/respond', { method: 'PUT', headers: { Authorization: `Bearer ${doerToken}` }, body: completeFd });
  let respondData = await r.json().catch(() => ({}));
  check('respond: multi-file completion request succeeds (200)', r.status === 200, { status: r.status, respondData });

  r = await j(BASE, 'GET', `/tasks/doer/${doerId}`, undefined, doerToken);
  let docAfterComplete = (Array.isArray(r.data) ? r.data : r.data?.data || []).find(t => String(t._id) === String(taskId));
  check('respond: BOTH evidence files were saved (task.files.length === 2)', docAfterComplete && (docAfterComplete.files || []).length === 2, docAfterComplete?.files);
  check('respond: remarks were persisted for a Completed status change', docAfterComplete?.remarks === 'Finished both parts, see photos.', docAfterComplete?.remarks);

  // --- TEST 2: assigner rejects/sends back with remarks + a photo (the
  // app's existing "reject" path sets status back to 'Accepted') ---
  const rejectFd = new FormData();
  rejectFd.append('taskId', taskId);
  rejectFd.append('status', 'Accepted');
  rejectFd.append('doerId', adminId);
  rejectFd.append('remarks', 'Please redo step 2, the numbers are wrong.');
  rejectFd.append('evidence', pngBlob(), 'reject-note.png');
  r = await fetch(BASE + '/tasks/respond', { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}` }, body: rejectFd });
  let rejectData = await r.json().catch(() => ({}));
  check('respond: reject-with-photo request succeeds (200)', r.status === 200, { status: r.status, rejectData });

  r = await j(BASE, 'GET', `/tasks/doer/${doerId}`, undefined, doerToken);
  let docAfterReject = (Array.isArray(r.data) ? r.data : r.data?.data || []).find(t => String(t._id) === String(taskId));
  check('respond: rejection remarks are now visible to the DOER (previously silently dropped)', docAfterReject?.remarks === 'Please redo step 2, the numbers are wrong.', docAfterReject?.remarks);
  check('respond: the reject photo was appended (task.files.length === 3)', docAfterReject && (docAfterReject.files || []).length === 3, docAfterReject?.files);
  check('respond: history entries carry a populated performer name', (docAfterReject?.history || []).every(h => !h.performedBy || typeof h.performedBy === 'object'), docAfterReject?.history);

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) {
    console.log('FAILURES:', JSON.stringify(failed, null, 2));
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
