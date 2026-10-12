// Regression test for the confirm-flow bug found in the real-model re-run
// (see AI_ASSISTANT_REPORT.md, "Update: full real-model re-run"):
//
//   Root cause: SYSTEM_PROMPT rule 3 used to tell the model to get the user's
//   "yes" ITSELF, in plain text, before calling the tool. But the backend's
//   actual confirm mechanism (needsConfirmation/confirmId) is built the other
//   way around: it expects the tool to be called immediately, and the APP
//   generates the confirmation card. A real model following the old rule 3
//   literally never called the tool on turn 1 (so no confirmId was ever
//   issued), and because /api/ai-assistant/chat is stateless, a later "yes"
//   got "I don't have enough context" instead of running anything.
//
// This fake model does not pretend to be smarter than that bug - it behaves
// exactly the way a model honestly following the SYSTEM_PROMPT text would:
// it inspects the actual `system` string the controller sends (the real
// prompt, unmodified by this test) and only calls the tool immediately if
// that prompt does NOT contain the old "get the user's explicit yes" wording.
// That means this test fails against the pre-fix controller and passes
// against the fixed one, without needing a real API key.
process.env.PORT = process.env.PORT || '5095';

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

  const sub = 'zzz-confirmfix-' + Date.now();
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token;
  const tenantId = r.data.tenantId;
  check('setup: tenant created, admin can log in', r.status === 200 && !!adminToken, r);

  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'Regression Doer', email: `doer-${Date.now()}@${sub}.test`, department: 'Ops',
    whatsappNumber: '9999999999', roles: ['Doer'], password: 'TestPass123!',
  }, adminToken);
  const doerId = r.data?.employee?._id || r.data?._id;
  check('setup: doer employee created', !!doerId, r);

  await j(BASE, 'PUT', `/superadmin/tenants/${tenantId}/ai-assistant`, { enabled: true, monthlyLimit: 10000 }, superToken);

  // The fake model stands in for a real model that honestly follows whatever
  // SYSTEM_PROMPT it is actually given - this is the mechanism that reproduces
  // (or doesn't) the bug, not a scripted shortcut around it.
  const OLD_RULE_3_MARKER = /get the user's explicit\s*["“]yes["”]/i;
  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ system, messages }) => {
    const text = (messages[0]?.content || '').toString();
    const m = text.match(/REGRESSION_CREATE_TASK:(\S+)/);
    if (m) {
      if (OLD_RULE_3_MARKER.test(system || '')) {
        // Honestly obeying the old (buggy) rule 3: ask in plain text, don't call the tool.
        return { toolUse: null, text: 'I\'ll create a task titled "Prep the Q3 report" for that employee, due 2026-11-01. Shall I go ahead?' };
      }
      // Fixed prompt: call the tool immediately, let the app own confirmation.
      return { toolUse: { name: 'create_task', input: { title: 'Prep the Q3 report', doerId: m[1], deadline: '2026-11-01' } }, text: '' };
    }
    // A bare "yes"/"no" with no memory of what was being confirmed - this is what the
    // real stateless endpoint actually receives on a follow-up message.
    return { toolUse: null, text: "I don't have enough context — what would you like me to create?" };
  };

  // --- A. The reported bug, reproduced/disproven directly ---
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: `REGRESSION_CREATE_TASK:${doerId}` }, adminToken);
  check('turn 1 calls the tool immediately and returns needsConfirmation + confirmId (not a plain-text question)',
    r.status === 200 && r.data.needsConfirmation === true && !!r.data.confirmId && /Prep the Q3 report/.test(r.data.summary || ''), r);
  const confirmId = r.data.confirmId;

  r = await j(BASE, 'GET', `/tasks/doer/${doerId}`, undefined, adminToken);
  const countBefore = Array.isArray(r.data) ? r.data.length : 0;

  // --- B. "Yes" -> runs exactly once ---
  r = await j(BASE, 'POST', '/ai-assistant/chat', { confirmId }, adminToken);
  check('confirming ("yes") actually runs the staged action', r.status === 200 && !!r.data.result, r);

  r = await j(BASE, 'GET', `/tasks/doer/${doerId}`, undefined, adminToken);
  let countAfter = Array.isArray(r.data) ? r.data.length : 0;
  check('exactly one task was created after confirming (count +1, not +0 or +2)', countAfter === countBefore + 1, { countBefore, countAfter });

  // Replaying the same confirmId must not run it again (exactly-once, not at-least-once).
  r = await j(BASE, 'POST', '/ai-assistant/chat', { confirmId }, adminToken);
  check('replaying the same confirmId after it was used is rejected, not re-run', r.status === 400, r);
  r = await j(BASE, 'GET', `/tasks/doer/${doerId}`, undefined, adminToken);
  check('task count unchanged after the rejected replay', (Array.isArray(r.data) ? r.data.length : 0) === countAfter, r);

  // --- C. A second staged action that the user says "no" to must change nothing ---
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: `REGRESSION_CREATE_TASK:${doerId}` }, adminToken);
  check('second request also stages correctly', r.status === 200 && r.data.needsConfirmation === true && !!r.data.confirmId, r);
  const confirmId2 = r.data.confirmId;

  // User says "no" in plain chat instead of confirming - no confirmId is sent, so
  // nothing should run, regardless of what the model replies to "no".
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'no, don\'t do that' }, adminToken);
  r = await j(BASE, 'GET', `/tasks/doer/${doerId}`, undefined, adminToken);
  check('saying "no" instead of confirming leaves the task count unchanged', (Array.isArray(r.data) ? r.data.length : 0) === countAfter, r);

  // --- D. Silence: the staged confirmId is simply never confirmed and expires ---
  // (same confirmId2 from step C - nobody ever POSTs it). Expiry is time-based
  // (CONFIRM_TTL_MS = 5 minutes) so we assert the cheaper, always-true half of
  // "silence changes nothing": the task was never created just by staging it.
  check('merely staging a second action (never confirming it) did not create anything by itself',
    (Array.isArray((await j(BASE, 'GET', `/tasks/doer/${doerId}`, undefined, adminToken)).data) ? (await j(BASE, 'GET', `/tasks/doer/${doerId}`, undefined, adminToken)).data.length : -1) === countAfter,
    { confirmId2 });

  console.log('\n' + results.filter((r2) => r2.pass).length + ' PASS / ' + results.filter((r2) => !r2.pass).length + ' FAIL / ' + results.length + ' TOTAL');
  require('fs').writeFileSync(__dirname + '/results-confirm-flow-regression.json', JSON.stringify(results, null, 2));
  process.exitCode = results.every((r2) => r2.pass) ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 500);
})().catch((e) => { console.error('CONFIRM_FLOW_REGRESSION_FAILED', e); process.exit(1); });
