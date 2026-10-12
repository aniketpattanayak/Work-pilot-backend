// Regression test for item 1f: the monthly usage counter must be an atomic
// $inc (not read-then-save, which loses updates under concurrency), and idle
// rate-limit map entries must actually be removed, not just left with an
// empty/stale array forever.
process.env.PORT = process.env.PORT || '5092';

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
  const { _internal } = require('../../controllers/aiAssistantController');

  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  const sub = 'zzz-usage-' + Date.now();
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token;
  const tenantId = r.data.tenantId;
  check('setup: tenant created, admin can log in', r.status === 200 && !!adminToken, r);

  global.__AI_ASSISTANT_FAKE_MODEL__ = async () => ({ toolUse: null, text: 'ok' });

  // --- A. Atomic usage counter: a tight cap must never be exceeded under concurrency ---
  // monthlyLimit = 5, fire 20 concurrent requests from 20 DIFFERENT users (so the
  // per-user rate limiter never fires and can't confound this) sharing one
  // tenant's monthly counter. A read-then-save counter can lose updates under
  // real concurrency and let more than 5 through; an atomic $inc with the limit
  // check baked into the same query cannot.
  await j(BASE, 'PUT', `/superadmin/tenants/${tenantId}/ai-assistant`, { enabled: true, monthlyLimit: 5 }, superToken);
  const N = 20;
  const tokens = [];
  for (let i = 0; i < N; i++) {
    r = await j(BASE, 'POST', '/tasks/add-employee', {
      tenantId, name: `Usage Tester ${i}`, email: `usage-${i}-${Date.now()}@${sub}.test`, department: 'Ops',
      whatsappNumber: `70000000${String(i).padStart(2, '0')}`, roles: ['Doer'], password: 'TestPass123!',
    }, adminToken);
    const email = r.data?.employee?.email || r.data?.email;
    r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email, password: 'TestPass123!' });
    tokens.push(r.data.token);
  }
  check(`setup: ${N} distinct employees created and logged in`, tokens.every(Boolean), tokens.length);

  const settled = await Promise.all(tokens.map((t) => j(BASE, 'POST', '/ai-assistant/chat', { message: 'ping' }, t)));
  const okCount = settled.filter((r2) => r2.status === 200).length;
  const cappedCount = settled.filter((r2) => r2.status === 429 && r2.data.code === 'MONTHLY_LIMIT_REACHED').length;
  check(`exactly 5 of ${N} concurrent requests (from 20 different users) succeed under a monthlyLimit of 5 (atomic $inc, no lost updates letting extra through)`,
    okCount === 5, { okCount, cappedCount, N });
  check('all remaining concurrent requests are correctly capped, not errored or silently dropped', okCount + cappedCount === N, { okCount, cappedCount, N });

  // A follow-up request (yet another new user) must still be capped (the limit really is 5, not "5 or more by luck").
  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'One More', email: `usage-extra-${Date.now()}@${sub}.test`, department: 'Ops',
    whatsappNumber: '7000000099', roles: ['Doer'], password: 'TestPass123!',
  }, adminToken);
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: r.data?.employee?.email || r.data?.email, password: 'TestPass123!' });
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'ping' }, r.data.token);
  check('a request after the concurrent burst (new user, so not rate-limited) is still capped', r.status === 429 && r.data.code === 'MONTHLY_LIMIT_REACHED', r);

  // --- B. Rate-limit map sweep: idle entries are actually removed ---
  const rateBuckets = _internal.rateBuckets;
  const sweep = _internal.sweepIdleRateBuckets;
  check('sweepIdleRateBuckets is exposed for this test (and for the production interval) to call', typeof sweep === 'function', typeof sweep);

  rateBuckets.clear();
  const idleUser = 'idle-user-' + Date.now();
  const activeUser = 'active-user-' + Date.now();
  // Simulate an idle user whose last request was well outside the window, and
  // an active user whose last request was just now.
  rateBuckets.set(idleUser, [Date.now() - 10 * 60 * 1000]); // 10 minutes ago, window is 1 minute
  rateBuckets.set(activeUser, [Date.now()]);
  check('setup: both an idle and an active bucket exist before sweeping', rateBuckets.has(idleUser) && rateBuckets.has(activeUser), [...rateBuckets.keys()]);

  sweep();
  check('the idle user\'s entry is actually deleted from the map, not just left with an empty array', !rateBuckets.has(idleUser), [...rateBuckets.keys()]);
  check('the active user\'s entry survives the sweep', rateBuckets.has(activeUser), [...rateBuckets.keys()]);

  console.log('\n' + results.filter((r2) => r2.pass).length + ' PASS / ' + results.filter((r2) => !r2.pass).length + ' FAIL / ' + results.length + ' TOTAL');
  require('fs').writeFileSync(__dirname + '/results-usage-ratelimit-regression.json', JSON.stringify(results, null, 2));
  process.exitCode = results.every((r2) => r2.pass) ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 500);
})().catch((e) => { console.error('USAGE_RATELIMIT_REGRESSION_FAILED', e); process.exit(1); });
