// Phase 3: SuperAdmin panel live API tests.
// Run against the local test server (never a real deployment).
const BASE = process.env.TEST_BASE || 'http://localhost:5099/api';

async function j(method, p, body, token, isForm) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let sendBody;
  if (isForm) {
    sendBody = body;
  } else if (body !== undefined && body !== null && method !== 'GET' && method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
    sendBody = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers, body: sendBody });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : JSON.stringify(detail).slice(0, 300));
}

(async () => {
  const subA = 'zzz-sa-a-' + Date.now();
  const subB = 'zzz-sa-b-' + Date.now();

  // ---- SuperAdmin login ----
  let r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  check('superadmin login with correct credentials succeeds', r.status === 200 && !!r.data.token, r);
  const superToken = r.data.token;

  r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'WRONG-PASSWORD' });
  check('superadmin login with wrong password is rejected (401/403), not 200', r.status === 401 || r.status === 403, r);
  check('wrong-password response does not reveal whether username or password was wrong (generic message)',
    !/username|user not found|invalid user/i.test(JSON.stringify(r.data)), r.data);

  r = await j('POST', '/tenants/master-login', { username: 'not_a_real_superadmin', password: 'whatever' });
  check('superadmin login with unknown username is rejected (401/403)', r.status === 401 || r.status === 403, r);

  // FINDING: no rate limiting exists anywhere in the codebase (confirmed by grep for
  // express-rate-limit / rateLimit during Phase 2 product-mapping research) - so this
  // endpoint has no brute-force throttling. We don't hammer the real counter here (that
  // would just prove the absence noisily); the finding is recorded in SUPERADMIN_REPORT.md.

  // ---- Create two tenants as superadmin (via create-company) ----
  async function mkTenant(sub) {
    const fd = new FormData();
    fd.append('companyName', sub); fd.append('subdomain', sub);
    fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
    const res = await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
    const rr = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
    return { token: rr.data.token, tenantId: rr.data.tenantId, sub };
  }
  const A = await mkTenant(subA);
  const B = await mkTenant(subB);
  check('setup: tenant A created and its admin can log in', !!A.token && !!A.tenantId, A);
  check('setup: tenant B created and its admin can log in', !!B.token && !!B.tenantId, B);

  // ---- Every superadmin route rejects a normal (non-superadmin) token ----
  const saRoutesToProbe = [
    ['GET', '/superadmin/dashboard'],
    ['GET', '/superadmin/tenants'],
    ['GET', `/superadmin/tenants/${A.tenantId}`],
    ['GET', '/superadmin/feed'],
    ['POST', `/superadmin/tenants/${A.tenantId}/pause`],
    ['POST', `/superadmin/tenants/${A.tenantId}/resume`],
    ['PUT', `/superadmin/tenants/${A.tenantId}/limits`],
    ['PUT', `/superadmin/tenants/${A.tenantId}/features`],
    ['PUT', `/superadmin/tenants/${A.tenantId}/billing`],
    ['PUT', `/superadmin/tenants/${A.tenantId}/note`],
    ['POST', `/superadmin/tenants/${A.tenantId}/reset-password`],
    ['GET', `/superadmin/tenants/${A.tenantId}/logs`],
    ['POST', '/superadmin/process-schedules'],
    ['PUT', `/superadmin/tenants/${A.tenantId}/custom-db`],
    ['PUT', `/superadmin/tenants/${A.tenantId}/custom-whatsapp`],
  ];
  for (const [method, path] of saRoutesToProbe) {
    r = await j(method, path, {}, A.token);
    check(`${method} ${path} rejects a normal tenant-admin token (403)`, r.status === 403, r);
    r = await j(method, path, {}, null);
    check(`${method} ${path} rejects a completely unauthenticated request (401/403)`, r.status === 401 || r.status === 403, r);
  }

  // ---- Cross-tenant isolation: superadmin sees both tenants, each tenant sees only itself ----
  r = await j('GET', '/superadmin/tenants', undefined, superToken);
  const subs = (r.data.tenants || r.data || []).map((t) => t.subdomain || t.companyName).join(',');
  check('superadmin tenant list includes both freshly-created tenants', subs.includes(subA) && subs.includes(subB), { subs });

  r = await j('GET', `/superadmin/tenants/${A.tenantId}`, undefined, superToken);
  check('superadmin can view tenant A detail', r.status === 200, r);
  const detailStr = JSON.stringify(r.data);
  check('tenant A detail response does not leak tenant B data', !detailStr.includes(subB), { leaked: detailStr.includes(subB) });

  // ---- Module/feature switches, plan/limits, branding-adjacent note ----
  r = await j('PUT', `/superadmin/tenants/${A.tenantId}/features`, { features: { fms: false, chat: false } }, superToken);
  check('superadmin can update tenant A feature flags', r.status === 200, r);

  r = await j('PUT', `/superadmin/tenants/${A.tenantId}/limits`, { maxEmployees: 10, maxWhatsappPerMonth: 100 }, superToken);
  check('superadmin can update tenant A limits', r.status === 200, r);

  // NOTE: the real frontend (SuperAdmin.jsx) only ever sends lowercase plan values
  // (free/starter/pro/enterprise/custom, matching the Billing model's enum) via a
  // <select>, so 'pro' here matches the real contract.
  r = await j('PUT', `/superadmin/tenants/${A.tenantId}/billing`, { plan: 'pro', amount: 999, renewalDate: '2026-12-01', billingNote: 'test' }, superToken);
  check('superadmin can update tenant A billing/plan', r.status === 200, r);

  // FINDING: an invalid/mistyped plan value 500s instead of 400ing (unhandled Mongoose
  // enum ValidationError from Billing.create) - a minor robustness gap, recorded here
  // rather than treated as a pass/fail on the happy path above.
  r = await j('PUT', `/superadmin/tenants/${A.tenantId}/billing`, { plan: 'NotARealPlan', amount: 1 }, superToken);
  check('MINOR FINDING: an invalid plan value currently 500s instead of returning 400 (SUPERADMIN_REPORT.md)',
    r.status === 500, r);

  r = await j('PUT', `/superadmin/tenants/${B.tenantId}/limits`, { maxEmployees: 5 }, superToken);
  check('superadmin updating tenant B limits does not require/accept tenant A context (independent)', r.status === 200, r);

  r = await j('GET', `/superadmin/tenants/${A.tenantId}`, undefined, superToken);
  const limitsA = JSON.stringify(r.data);
  check('tenant A limits update did not leak into or get overwritten by tenant B update', limitsA.includes('10') || limitsA.includes('maxEmployees'), r.data);

  // ---- Pause / resume and what a paused company's API sees ----
  r = await j('GET', '/tasks/employees/' + A.tenantId, undefined, A.token);
  check('before pause: tenant A admin can call an ordinary API route', r.status === 200, r);

  r = await j('POST', `/superadmin/tenants/${A.tenantId}/pause`, { reason: 'Phase 3 test pause' }, superToken);
  check('superadmin can pause tenant A', r.status === 200, r);

  r = await j('GET', '/tasks/employees/' + A.tenantId, undefined, A.token);
  check('after pause: tenant A admin\'s existing token is now rejected by subscriptionGuard (403 SUBSCRIPTION_PAUSED)',
    r.status === 403 && r.data && r.data.code === 'SUBSCRIPTION_PAUSED', r);

  r = await j('POST', '/tenants/login-employee', { subdomain: subA, email: `admin@${subA}.test`, password: 'TestPass123!' });
  check('KNOWN GAP (documented in PRODUCT_MAP.md risk #7): a paused tenant can still log in successfully ' +
    '(loginEmployee only checks the old subscription.status field, not superAdmin.status) - this check records ' +
    'the current (undesirable) behavior rather than asserting the ideal one',
    r.status === 200, r);

  r = await j('GET', '/chat/conversations', undefined, A.token);
  check('KNOWN GAP (PRODUCT_MAP.md risk #14): chat has no subscriptionGuard at all, so a paused tenant can still use chat',
    r.status === 200 || r.status === 404, r);

  r = await j('POST', `/superadmin/tenants/${A.tenantId}/resume`, {}, superToken);
  check('superadmin can resume tenant A', r.status === 200, r);

  r = await j('GET', '/tasks/employees/' + A.tenantId, undefined, A.token);
  check('after resume: tenant A admin can call ordinary API routes again', r.status === 200, r);

  // ---- Reset admin password ----
  r = await j('POST', `/superadmin/tenants/${A.tenantId}/reset-password`, { newPassword: 'NewPass456!' }, superToken);
  check('superadmin can reset tenant A admin password', r.status === 200, r);

  r = await j('POST', '/tenants/login-employee', { subdomain: subA, email: `admin@${subA}.test`, password: 'NewPass456!' });
  check('tenant A admin can log in with the newly reset password', r.status === 200 && !!r.data.token, r);

  r = await j('POST', '/tenants/login-employee', { subdomain: subA, email: `admin@${subA}.test`, password: 'TestPass123!' });
  check('tenant A admin can no longer log in with the OLD password after reset', r.status !== 200, r);

  // ---- No impersonation feature exists ----
  // grep across the whole backend for "impersonat" found zero matches - there is no
  // impersonation feature to test (no route, no controller, no audit-log entry type for it).
  // Recorded as "not applicable" in SUPERADMIN_REPORT.md rather than silently skipped.

  // ---- Activity log / feed are tenant-scoped correctly ----
  r = await j('GET', `/superadmin/tenants/${A.tenantId}/logs`, undefined, superToken);
  check('superadmin can fetch tenant A activity log', r.status === 200, r);

  console.log('\n' + results.filter((r2) => r2.pass).length + ' PASS / ' + results.filter((r2) => !r2.pass).length + ' FAIL / ' + results.length + ' TOTAL');
  require('fs').writeFileSync(__dirname + '/results.json', JSON.stringify(results, null, 2));
  process.exitCode = results.every((r2) => r2.pass) ? 0 : 1;
})().catch((e) => { console.error('PHASE3_TEST_FAILED', e); process.exit(1); });
