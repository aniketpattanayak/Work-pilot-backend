// Part 2 (AI-layer-v2) regression test: conversation memory + Mongo-backed
// pending confirmations.
//
// Proves:
//  - a session survives across two separate /chat calls (i.e. "across a page
//    refresh" - a new request with the same sessionId sees the earlier turn);
//  - GET/DELETE /sessions is scoped to the caller's own (tenantId, userId) -
//    a second employee cannot list, open, or delete someone else's session;
//  - the history actually sent to the model on a follow-up request includes
//    the earlier turn (the plumbing "him"/"that task" resolution depends on -
//    whether a REAL model then correctly resolves the pronoun is a model
//    capability, not something the fake-model harness can prove; this test
//    proves the context reaches the model, not that the model understands it);
//  - a staged write's pending-confirmation data is actually a document in
//    Mongo (not a process-local Map) - queried directly, independent of the
//    HTTP layer, as proof the single-process limitation is gone;
//  - confirmId is single-use (replay is rejected);
//  - regression guard for the resolveDisplayNames fix: find_colleague called
//    with a blank query (the controller's own internal "fetch everyone" use)
//    still returns the FULL roster, not zero matches - this is the exact bug
//    Part 1's resolver introduced and Part 1 fixed; this test exists so it
//    can never silently come back in a future change to resolve.js or tools.js.
process.env.PORT = process.env.PORT || '5095';

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
  await new Promise((r) => setTimeout(r, 2500));
  const BASE = `http://localhost:${process.env.PORT}/api`;

  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  const sub = 'zzz-session-' + Date.now();
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token;
  const tenantId = r.data.tenantId;
  check('setup: tenant created, admin can log in', r.status === 200 && !!adminToken, r);

  // A second employee, to prove session isolation between users.
  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'Other Person', email: `other-${Date.now()}@${sub}.test`, department: 'Ops',
    whatsappNumber: '9999999993', roles: ['Doer'], password: 'TestPass123!',
  }, adminToken);
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: r.data?.employee?.email, password: 'TestPass123!' });
  const otherToken = r.data.token;
  check('setup: second employee can log in', r.status === 200 && !!otherToken, r);

  await j(BASE, 'PUT', `/superadmin/tenants/${tenantId}/ai-assistant`, { enabled: true, monthlyLimit: 10000 }, superToken);

  // --- A. Session survives across two /chat calls (simulated refresh) -----
  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ messages }) => {
    const lastUserText = messages.filter((m) => typeof m.content === 'string').pop()?.content || '';
    if (/MEMORY_TURN_ONE/.test(lastUserText)) {
      return { toolUse: null, text: 'Noted: the project is called Falcon.' };
    }
    if (/MEMORY_TURN_TWO/.test(lastUserText)) {
      // Did the history from turn one actually arrive in this request's messages?
      const sawTurnOne = messages.some((m) => typeof m.content === 'string' && /MEMORY_TURN_ONE/.test(m.content));
      const sawAssistantReply = messages.some((m) => typeof m.content === 'string' && /Falcon/.test(m.content));
      return { toolUse: null, text: sawTurnOne && sawAssistantReply ? 'HISTORY_PRESENT' : 'HISTORY_MISSING' };
    }
    return { toolUse: null, text: 'unhandled' };
  };

  r = await j(BASE, 'POST', '/ai-assistant/sessions', {}, adminToken);
  const sessionId = r.data.sessionId;
  check('setup: a new session can be created and returns a sessionId', r.status === 200 && !!sessionId, r);

  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'MEMORY_TURN_ONE: remember this', sessionId }, adminToken);
  check('first turn in a new session succeeds and echoes the sessionId back', r.status === 200 && r.data.sessionId === sessionId, r.data);

  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'MEMORY_TURN_TWO: what did I just say', sessionId }, adminToken);
  check('second request with the SAME sessionId sees turn one\'s history in the messages sent to the model',
    r.data.reply === 'HISTORY_PRESENT', r.data);

  // A brand new session must NOT see that history (proves scoping, not a global leak).
  r = await j(BASE, 'POST', '/ai-assistant/sessions', {}, adminToken);
  const freshSessionId = r.data.sessionId;
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'MEMORY_TURN_TWO: what did I just say', sessionId: freshSessionId }, adminToken);
  check('a DIFFERENT session does not see the first session\'s history', r.data.reply === 'HISTORY_MISSING', r.data);

  // --- B. GET /sessions/:id actually persisted both turns' text -----------
  r = await j(BASE, 'GET', `/ai-assistant/sessions/${sessionId}`, undefined, adminToken);
  const storedTexts = (r.data.messages || []).map((m) => m.text).join(' | ');
  check('opening the session shows both stored user turns', /MEMORY_TURN_ONE/.test(storedTexts) && /MEMORY_TURN_TWO/.test(storedTexts), r.data);

  // --- C. Session isolation: another user cannot see/open/delete it -------
  r = await j(BASE, 'GET', '/ai-assistant/sessions', undefined, otherToken);
  const otherSeesIt = (r.data.sessions || []).some((s) => s.sessionId === sessionId);
  check('a different user\'s session list never includes this session', !otherSeesIt, r.data);

  r = await j(BASE, 'GET', `/ai-assistant/sessions/${sessionId}`, undefined, otherToken);
  check('a different user opening this sessionId directly gets 404, not the content', r.status === 404, r);

  r = await j(BASE, 'DELETE', `/ai-assistant/sessions/${sessionId}`, undefined, otherToken);
  check('a different user cannot delete this session', r.status === 404, r);

  r = await j(BASE, 'GET', `/ai-assistant/sessions/${sessionId}`, undefined, adminToken);
  check('...but the owner can still open it fine (not actually deleted)', r.status === 200, r);

  // --- D. Pending confirmation is a real Mongo document, not memory -------
  // (Part 3 finding: completing against a taskId that doesn't exist must be
  // reported honestly as a failure, not "Done." - see aiAssistantController's
  // confirm path, which now shows the route's own error text on a non-2xx
  // result. So this needs a REAL task to prove the single-use/Mongo claims.)
  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'Task Doer', email: `taskdoer-${Date.now()}@${sub}.test`, department: 'Ops',
    whatsappNumber: '9999999995', roles: ['Doer'], password: 'TestPass123!',
  }, adminToken);
  const taskDoerId = r.data?.employee?._id;
  const adminId = JSON.parse(Buffer.from(adminToken.split('.')[1], 'base64').toString()).id;
  r = await j(BASE, 'POST', '/tasks/create-task', {
    tenantId, assignerId: adminId, title: 'Pending confirm test task',
    doerId: taskDoerId, deadline: new Date(Date.now() + 86400000).toISOString(), priority: 'Medium',
  }, adminToken);
  const realTaskId = r.data?.task?._id;
  check('setup: a real task exists to complete', !!realTaskId, r.data);

  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ messages }) => {
    const lastUserText = messages.filter((m) => typeof m.content === 'string').pop()?.content || '';
    if (/STAGE_A_TASK/.test(lastUserText)) {
      return { toolUse: { id: 't1', name: 'complete_task', input: { taskId: realTaskId } }, text: '' };
    }
    return { toolUse: null, text: 'unhandled' };
  };
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'STAGE_A_TASK', sessionId }, adminToken);
  const confirmId = r.data.confirmId;
  check('a write is staged and returns a confirmId', r.status === 200 && r.data.needsConfirmation === true && !!confirmId, r.data);

  const AiChatSession = require('../../models/AiChatSession');
  const doc = await AiChatSession.findOne({ 'pendingAction.confirmId': confirmId });
  check('the pending action is a real document in MongoDB (queryable independent of the HTTP layer / any in-process Map)',
    !!doc && doc.pendingAction?.toolName === 'complete_task', doc?.pendingAction);

  // --- E. confirmId is single-use (replay rejected) ------------------------
  r = await j(BASE, 'POST', '/ai-assistant/chat', { confirmId, sessionId }, adminToken);
  check('confirming the staged action succeeds the first time', r.status === 200 && /Done\./.test(r.data.reply || ''), r.data);

  r = await j(BASE, 'POST', '/ai-assistant/chat', { confirmId, sessionId }, adminToken);
  check('replaying the SAME confirmId a second time is rejected (single-use)', r.status === 400, r);

  // --- F. Part 1 regression guard: resolveDisplayNames' blank-query use ---
  // (the exact bug: Part 1's resolver originally treated an empty query as
  // "match nothing", which broke the controller's internal "fetch the whole
  // roster to resolve an id to a name" use of this same tool)
  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'Blank Query Guard', email: `blankq-${Date.now()}@${sub}.test`, department: 'Ops',
    whatsappNumber: '9999999994', roles: ['Doer'], password: 'TestPass123!',
  }, adminToken);
  const { executeTool } = require('../../utils/aiAssistant/executor');
  const rosterResult = await executeTool('find_colleague', { query: '' }, adminToken, { id: 'n/a', tenantId });
  const names = (rosterResult?.data?.matches || []).map((m) => m.name);
  check('REGRESSION GUARD: find_colleague with a blank query returns the WHOLE roster, not zero matches',
    rosterResult?.data?.decision === 'list-all' && names.includes('Blank Query Guard') && rosterResult.data.matchCount >= 2,
    rosterResult?.data);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} PASS / ${total - passed} FAIL / ${total} TOTAL`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
