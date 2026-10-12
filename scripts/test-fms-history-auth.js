// Regression test for a security bug found during the Phase 1 E2E security pass:
// GET /api/fms/history/flow/:templateId and GET /api/fms/history/:instanceId had NO
// authMiddleware at all (every sibling route in routes/fmsRoutes.js has one), and the
// controller never checked tenant ownership either - so anyone, logged in or not, from
// any company, could read another tenant's legacy-FMS flow/instance history just by
// knowing or guessing an id.
//
// Needs the local test server running against the local test DB (never point this at a
// real server - see the session's safety rules).
const BASE = process.env.TEST_BASE || 'http://localhost:5099/api';
async function j(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: (body !== undefined && body !== null && method !== 'GET' && method !== 'DELETE') ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
let ok = true;
function check(name, cond, detail) { console.log(cond ? 'PASS' : 'FAIL', '-', name, cond ? '' : JSON.stringify(detail).slice(0, 200)); if (!cond) ok = false; }

(async () => {
  const subA = 'zzz-fmsauth-a-' + Date.now();
  const subB = 'zzz-fmsauth-b-' + Date.now();

  let r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;

  async function mkTenant(sub) {
    const fd = new FormData();
    fd.append('companyName', sub); fd.append('subdomain', sub);
    fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
    await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
    const rr = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
    return { token: rr.data.token, tenantId: rr.data.tenantId };
  }
  const A = await mkTenant(subA);
  const B = await mkTenant(subB);

  // Create a legacy FMS template + instance for tenant A (so there is real data to try to leak).
  r = await j('POST', '/fms/create-template', { tenantId: A.tenantId, name: 'Secret Flow A', flowName: 'Secret Flow A', tabName: 'Sheet1', scriptUrl: 'https://script.google.com/dummy', googleSheetId: 'dummy-sheet-id', nodes: [{ nodeName: 'Step 1', emailColumn: `admin@${subA}.test`, stepIndex: 0 }] }, A.token);
  const templateId = r.data && (r.data.template ? r.data.template._id : r.data._id);
  check('setup: tenant A can create a legacy FMS template', !!templateId, r);

  // 1. No token at all (unauthenticated) - must now be rejected, not leak history.
  r = await j('GET', `/fms/history/flow/${templateId || '000000000000000000000000'}`, undefined, null);
  check('getFlowHistory: completely unauthenticated request is rejected (401/403), not 200', r.status === 401 || r.status === 403, r);

  r = await j('GET', `/fms/history/${'000000000000000000000000'}`, undefined, null);
  check('getInstanceHistory: completely unauthenticated request is rejected (401/403), not 200', r.status === 401 || r.status === 403, r);

  // 2. Authenticated, but as tenant B trying to read tenant A's template history - must be denied.
  if (templateId) {
    r = await j('GET', `/fms/history/flow/${templateId}`, undefined, B.token);
    check('getFlowHistory: tenant B cannot read tenant A\'s flow history even when logged in', r.status === 404 || r.status === 403, r);

    r = await j('GET', `/fms/history/flow/${templateId}`, undefined, A.token);
    check('getFlowHistory: tenant A (the owner) can still read its own flow history', r.status === 200, r);
  }

  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exitCode = ok ? 0 : 1;
})().catch((e) => { console.error('TEST_FAILED', e); process.exit(1); });
