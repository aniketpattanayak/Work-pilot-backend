// Live regression test (needs the local test server running against the local test DB,
// per the session's safety rules - never point this at a real server).
// Confirms addEmployee/updateEmployee now accept and validate `joiningDate`.
const BASE = process.env.TEST_BASE || 'http://localhost:5099/api';
async function j(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: (body !== undefined && method !== 'GET' && method !== 'HEAD') ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
let ok = true;
function check(name, cond, detail) { console.log(cond ? 'PASS' : 'FAIL', '-', name, cond ? '' : String(JSON.stringify(detail)).slice(0, 200)); if (!cond) ok = false; }

(async () => {
  const sub = 'zzz-joindate-' + Date.now();
  let r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('superadmin login works', r.status === 200 && superToken, r);

  const form = new URLSearchParams();
  // create-company uses multipart in prod code but also accepts JSON in this backend's test path; fall back to fetch with FormData if needed.
  r = await fetch(BASE + '/tenants/create-company', {
    method: 'POST',
    headers: { Authorization: `Bearer ${superToken}` },
    body: (() => { const fd = new FormData(); fd.append('companyName', 'Join Date Test Co'); fd.append('subdomain', sub); fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!'); return fd; })()
  }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => ({})) }));
  check('test company created', r.status === 200 || r.status === 201, r);

  r = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token;
  const tenantId = r.data.tenantId;
  check('admin login works', r.status === 200 && adminToken && tenantId, r);

  // 1. addEmployee with a valid past joining date -> should be stored and returned.
  r = await j('POST', '/tenants/add-employee', { tenantId, name: 'Jo Joiner', email: `jo@${sub}.test`, whatsappNumber: '9990000001', department: 'Ops', password: 'TestPass123!', roles: ['Doer'], joiningDate: '2026-09-15' }, adminToken);
  check('addEmployee with a valid past joining date succeeds', r.status === 201 || r.status === 200, r);
  const empId = r.data.employee && (r.data.employee._id || r.data.employee.id);

  check('addEmployee response echoes the stored joiningDate as 2026-09-15 (not createdAt/today)',
    r.data.employee && String(r.data.employee.joiningDate).slice(0, 10) === '2026-09-15', r.data.employee);

  // 2. addEmployee with a future joining date -> rejected.
  r = await j('POST', '/tenants/add-employee', { tenantId, name: 'Future Joiner', email: `future@${sub}.test`, whatsappNumber: '9990000002', department: 'Ops', password: 'TestPass123!', roles: ['Doer'], joiningDate: '2099-01-01' }, adminToken);
  check('addEmployee rejects a joining date in the future', r.status === 400, r);

  // 3. addEmployee with an impossible calendar date -> rejected.
  r = await j('POST', '/tenants/add-employee', { tenantId, name: 'Bad Date', email: `baddate@${sub}.test`, whatsappNumber: '9990000003', department: 'Ops', password: 'TestPass123!', roles: ['Doer'], joiningDate: '2026-02-31' }, adminToken);
  check('addEmployee rejects an impossible calendar date (Feb 31)', r.status === 400, r);

  // 4. updateEmployee can change the joining date afterwards.
  if (empId) {
    r = await j('PUT', `/tenants/employees/${empId}`, { joiningDate: '2026-09-01' }, adminToken);
    check('updateEmployee accepts a corrected joining date', r.status === 200, r);
    check('updateEmployee\'s new joining date round-trips', r.data.employee && String(r.data.employee.joiningDate).slice(0, 10) === '2026-09-01', r.data.employee);

    r = await j('PUT', `/tenants/employees/${empId}`, { joiningDate: '2099-12-31' }, adminToken);
    check('updateEmployee rejects a future joining date', r.status === 400, r);
  }

  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exitCode = ok ? 0 : 1;
})().catch((e) => { console.error('TEST_FAILED', e); process.exit(1); });
