// Part 8 (AI-layer-v2): load and cost checks.
//  - the self-call executor now has an explicit timeout (it had none before
//    this part - an AbortController now bounds it), proven here by pointing
//    AI_ASSISTANT_SELF_BASE at a server that never responds and a very
//    short timeout, and checking we get a clean 504 back, not a hang;
//  - the chat route does not block the Node event loop: a slow self-call is
//    in flight (via a deliberately slow dummy upstream) at the same time as
//    a second, unrelated HTTP request to this same process, and the second
//    request completes well before the slow one does - proving the single
//    process is still servicing other requests while one chat call is
//    waiting on I/O;
//  - token usage accounting (utils/aiAssistant/provider.js getTokenUsageStats)
//    starts at zero calls when no real model call has been made (there is no
//    ANTHROPIC_API_KEY in this sandbox), which is the honest state for an
//    environment where the real model has never been called - not faked.
process.env.PORT = process.env.PORT || '5198';

const http = require('http');
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

  // --- 1. executeTool's self-call now has a real, short timeout ----------
  // A tiny HTTP server that accepts the connection but never responds.
  const hangingServer = http.createServer(() => { /* never calls res.end() */ });
  await new Promise((resolve) => hangingServer.listen(0, '127.0.0.1', resolve));
  const hangingPort = hangingServer.address().port;

  process.env.AI_ASSISTANT_SELF_CALL_TIMEOUT_MS = '500';
  // executeTool reads SELF_BASE once at module load, so re-require with the
  // override already set and a fresh module cache entry for this one check.
  delete require.cache[require.resolve('../../utils/aiAssistant/executor')];
  process.env.AI_ASSISTANT_SELF_BASE = `http://127.0.0.1:${hangingPort}`;
  const { executeTool } = require('../../utils/aiAssistant/executor');

  const started = Date.now();
  const out = await executeTool('my_tasks', {}, 'dummy-token', { id: 'n/a', tenantId: 'n/a' });
  const elapsedMs = Date.now() - started;
  check('a self-call to a hanging upstream times out (does not wait forever)', elapsedMs < 4000, { elapsedMs });
  check('a timed-out self-call returns a clean 504, not a thrown/uncaught error', out?.status === 504 && out?.timedOut === true, out);
  hangingServer.close();

  // Restore the real self-base for the rest of this process (and any test
  // run after this file in the same process, if ever chained).
  delete process.env.AI_ASSISTANT_SELF_BASE;
  delete require.cache[require.resolve('../../utils/aiAssistant/executor')];

  // --- 2. the chat route does not block the event loop -------------------
  // Point a chat call's model step at a fake model that itself awaits a
  // slow (1.5s) promise before responding - this simulates "the model call
  // is slow" without needing a real key - while concurrently firing a
  // trivial unrelated request at the same server. The unrelated request
  // must come back fast, proving the process kept serving other requests.
  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  const sub = 'zzz-part8-' + Date.now();
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token, tenantId = r.data.tenantId;
  check('setup: tenant created, admin can log in', r.status === 200 && !!adminToken, r);
  await j(BASE, 'PUT', `/superadmin/tenants/${tenantId}/ai-assistant`, { enabled: true, monthlyLimit: 10000 }, superToken);

  global.__AI_ASSISTANT_FAKE_MODEL__ = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { toolUse: null, text: 'slow reply' };
  };

  const slowStart = Date.now();
  const slowPromise = j(BASE, 'POST', '/ai-assistant/chat', { message: 'SLOW_PATH_TEST' }, adminToken);
  // Give the slow request a moment to actually be in flight before firing
  // the unrelated one, so this is a real concurrency check, not a race.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const fastStart = Date.now();
  const fastResult = await j(BASE, 'GET', `/tenants/login-employee`, undefined, undefined).catch(() => null);
  // The above GET may 404/405 (it's a POST-only route) - that's fine, we
  // only care about latency, not its status. Use a route guaranteed cheap:
  const fastReal = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' }, undefined);
  const fastElapsed = Date.now() - fastStart;
  const slowResult = await slowPromise;
  const slowElapsed = Date.now() - slowStart;

  check('the slow chat call really did take close to the full 1.5s (sanity check on the test itself)', slowElapsed >= 1400, { slowElapsed });
  check('an unrelated request completes quickly WHILE the slow chat call is still in flight - the event loop was not blocked', fastElapsed < 1000 && fastReal.status === 200, { fastElapsed, fastReal: fastReal.data });
  check('the slow chat call itself still completed successfully', slowResult.status === 200, slowResult.data);

  // --- 3. token usage accounting is honest about never having run -------
  const { getTokenUsageStats } = require('../../utils/aiAssistant/provider');
  const stats = getTokenUsageStats();
  check('token usage stats report zero real-model calls in this sandbox (no ANTHROPIC_API_KEY was ever used) - not fabricated', stats.calls === 0 && stats.avgInputTokens === 0 && stats.avgOutputTokens === 0, stats);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} PASS / ${total - passed} FAIL / ${total} TOTAL`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
