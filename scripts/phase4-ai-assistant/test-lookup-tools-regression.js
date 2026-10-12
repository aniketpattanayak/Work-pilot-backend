// Regression test for item 1d/1e of the review follow-up: create_task and
// apply_leave need real MongoDB ids (doerId, leaveTypeId) the model can never
// know on its own. This proves, with the fake-model injection point:
//   - a name-based request resolves through the new find_colleague /
//     list_leave_types lookup tools and a multi-step tool loop, ending in a
//     correctly-staged write with the REAL id (not a guessed one);
//   - the confirmation summary shown to the user names the person/leave type,
//     never a raw id;
//   - when a name matches more than one colleague, the flow asks which one
//     instead of guessing;
//   - a tool call with a bad argument (schema-invalid) is rejected before it
//     ever reaches a real route.
process.env.PORT = process.env.PORT || '5094';

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

// Pulls the parsed JSON out of a tool_result's <untrusted_data> wrapper, the
// way a real model reading its own conversation history would see it.
function lastToolResultData(messages) {
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content)) {
    const block = last.content.find((b) => b.type === 'tool_result');
    if (block) {
      const m = /<untrusted_data[^>]*>\n([\s\S]*?)\n<\/untrusted_data>/.exec(block.content || '');
      if (m) { try { return JSON.parse(m[1]); } catch { return null; } }
    }
  }
  return null;
}
function firstUserText(messages) {
  const first = messages[0];
  return typeof first?.content === 'string' ? first.content : '';
}

(async () => {
  require('../../index.js');
  await new Promise((r) => setTimeout(r, 2500));
  const BASE = `http://localhost:${process.env.PORT}/api`;

  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  const sub = 'zzz-lookup-' + Date.now();
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token;
  const tenantId = r.data.tenantId;
  check('setup: tenant created, admin can log in', r.status === 200 && !!adminToken, r);

  // Two "Priya"s on purpose, to test the disambiguation requirement.
  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'Priya Sharma', email: `priya-sharma-${Date.now()}@${sub}.test`, department: 'Ops',
    whatsappNumber: '9999999991', roles: ['Doer'], password: 'TestPass123!',
  }, adminToken);
  const priyaSharmaId = r.data?.employee?._id || r.data?._id;
  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'Priya Verma', email: `priya-verma-${Date.now()}@${sub}.test`, department: 'Sales',
    whatsappNumber: '9999999992', roles: ['Doer'], password: 'TestPass123!',
  }, adminToken);
  const priyaVermaId = r.data?.employee?._id || r.data?._id;
  check('setup: two colleagues both named "Priya" created', !!priyaSharmaId && !!priyaVermaId, { priyaSharmaId, priyaVermaId });

  await j(BASE, 'PUT', `/superadmin/tenants/${tenantId}/ai-assistant`, { enabled: true, monthlyLimit: 10000 }, superToken);
  // Leave module is off for every new company until the platform owner enables it
  // (utils/permissions.js: a module switch overrides any role's permission).
  r = await j(BASE, 'PUT', `/tasks/access/modules/${tenantId}`, { modules: { leave: true } }, superToken);
  check('setup: leave module enabled for this tenant', r.status === 200, r);

  // --- A. Unambiguous name -> resolves via find_colleague, stages with the real id, shows the name ---
  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ messages }) => {
    const text = firstUserText(messages);
    if (/LOOKUP_CREATE_TASK_FOR_SHARMA/.test(text)) {
      const toolResult = lastToolResultData(messages);
      if (!toolResult) {
        // Turn 1: resolve the name first, exactly as the system prompt requires.
        return { toolUse: { id: 't1', name: 'find_colleague', input: { query: 'Sharma' } }, text: '' };
      }
      // Turn 2: got exactly one match back as DATA - use its id, never show it to the user.
      if (toolResult.matchCount === 1) {
        return { toolUse: { id: 't2', name: 'create_task', input: { title: 'Submit report', doerId: toolResult.matches[0].id, deadline: '2026-12-01' } }, text: '' };
      }
      return { toolUse: null, text: 'Something unexpected happened resolving that name.' };
    }
    return { toolUse: null, text: 'unhandled' };
  };

  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'LOOKUP_CREATE_TASK_FOR_SHARMA' }, adminToken);
  check('name-based create_task resolves through find_colleague and stages correctly',
    r.status === 200 && r.data.needsConfirmation === true && !!r.data.confirmId, r);
  check('confirmation summary shows the real colleague\'s NAME, not a raw id',
    /Priya Sharma/.test(r.data.summary || '') && !new RegExp(String(priyaSharmaId)).test(r.data.summary || ''), r.data);
  const confirmId = r.data.confirmId;

  r = await j(BASE, 'GET', `/tasks/doer/${priyaSharmaId}`, undefined, adminToken);
  const countBefore = Array.isArray(r.data) ? r.data.length : 0;
  r = await j(BASE, 'POST', '/ai-assistant/chat', { confirmId }, adminToken);
  check('confirming runs it against the resolved id', r.status === 200 && !!r.data.result, r);
  r = await j(BASE, 'GET', `/tasks/doer/${priyaSharmaId}`, undefined, adminToken);
  const countAfter = Array.isArray(r.data) ? r.data.length : 0;
  check('the task really was created for the correctly-resolved Priya Sharma (not the other Priya)', countAfter === countBefore + 1, { countBefore, countAfter });

  // --- B. Ambiguous name ("Priya") -> the loop must ask, never guess ---
  // Part 6 (UI): an ambiguous find_colleague result is now answered directly
  // by the controller with a structured `choices` array (one per candidate,
  // for the panel's choice-chip UI), short-circuiting BEFORE looping back
  // to the model - so the fake model's own "did you mean X or Y" text
  // branch below is now dead code for this specific case; it's kept only
  // as a guard (if it ever fires, the short-circuit broke).
  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ messages }) => {
    const text = firstUserText(messages);
    if (/LOOKUP_CREATE_TASK_FOR_PRIYA/.test(text)) {
      const toolResult = lastToolResultData(messages);
      if (!toolResult) {
        return { toolUse: { id: 't1', name: 'find_colleague', input: { query: 'Priya' } }, text: '' };
      }
      if (toolResult.matchCount > 1) {
        const names = toolResult.matches.map((m) => m.name).join(' or ');
        return { toolUse: null, text: `I found more than one match — did you mean ${names}?` };
      }
      return { toolUse: null, text: 'unexpected' };
    }
    return { toolUse: null, text: 'unhandled' };
  };
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'LOOKUP_CREATE_TASK_FOR_PRIYA' }, adminToken);
  check('an ambiguous name (2 matches) gets a disambiguating question back, not a staged action',
    r.status === 200 && !r.data.needsConfirmation && /which one did you mean/.test(r.data.reply || ''), r);
  check('...and carries structured `choices` (Part 6 chip UI) naming both candidates',
    Array.isArray(r.data.choices) && r.data.choices.some((c) => c.label === 'Priya Sharma') && r.data.choices.some((c) => c.label === 'Priya Verma'),
    r.data);

  // --- C. find_colleague itself never leaks a raw id to anything outside the DATA wrapper ---
  // (already covered by check A's "shows name not id" assertion against the confirmation summary)

  // --- D. Leave-type name resolves via list_leave_types the same way ---
  // Seed one real leave type first via the normal admin route (same route the UI uses).
  r = await j(BASE, 'POST', '/tasks/leave/types', { name: 'Sick Leave', daysPerYear: 12 }, adminToken);
  const leaveTypeId = r.data?.type?._id || r.data?._id;
  check('setup: a real "Sick Leave" leave type exists', !!leaveTypeId, r);

  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ messages }) => {
    const text = firstUserText(messages);
    if (/LOOKUP_APPLY_SICK_LEAVE/.test(text)) {
      const toolResult = lastToolResultData(messages);
      if (!toolResult) {
        return { toolUse: { id: 't1', name: 'list_leave_types', input: {} }, text: '' };
      }
      const sick = (Array.isArray(toolResult) ? toolResult : []).find((t) => /sick/i.test(t.name || ''));
      if (sick) {
        return { toolUse: { id: 't2', name: 'apply_leave', input: { leaveTypeId: sick.id, fromDate: '2026-12-10', toDate: '2026-12-11' } }, text: '' };
      }
      return { toolUse: null, text: 'no sick leave type found' };
    }
    return { toolUse: null, text: 'unhandled' };
  };
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'LOOKUP_APPLY_SICK_LEAVE' }, adminToken);
  check('leave-type name resolves through list_leave_types and stages apply_leave with the real id',
    r.status === 200 && r.data.needsConfirmation === true, r);
  check('the apply_leave confirmation summary names the leave type ("Sick Leave"), not a raw id',
    /Sick Leave/.test(r.data.summary || ''), r.data);

  // --- E. Server-side schema validation rejects a bad argument before it ever runs ---
  global.__AI_ASSISTANT_FAKE_MODEL__ = async () => ({
    // title is missing entirely (required) - a schema-invalid call the model should never
    // have made; the server must catch this itself, not just hope the model behaves.
    toolUse: { id: 'bad1', name: 'create_task', input: { doerId: priyaSharmaId, deadline: '2026-12-01' } },
    text: '',
  });
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'BAD_ARGS_MISSING_TITLE' }, adminToken);
  check('a tool call missing a required argument is rejected server-side, not staged',
    r.status === 200 && !r.data.needsConfirmation && /title/i.test(r.data.reply || ''), r);

  global.__AI_ASSISTANT_FAKE_MODEL__ = async () => ({
    // An extra, unschemed field - additionalProperties:false must reject it.
    toolUse: { id: 'bad2', name: 'create_task', input: { title: 'x', doerId: priyaSharmaId, deadline: '2026-12-01', runShellCommand: 'rm -rf /' } },
    text: '',
  });
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'BAD_ARGS_EXTRA_FIELD' }, adminToken);
  check('a tool call with an unexpected extra argument is rejected server-side, not staged',
    r.status === 200 && !r.data.needsConfirmation, r);

  console.log('\n' + results.filter((r2) => r2.pass).length + ' PASS / ' + results.filter((r2) => !r2.pass).length + ' FAIL / ' + results.length + ' TOTAL');
  require('fs').writeFileSync(__dirname + '/results-lookup-tools-regression.json', JSON.stringify(results, null, 2));
  process.exitCode = results.every((r2) => r2.pass) ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 500);
})().catch((e) => { console.error('LOOKUP_TOOLS_REGRESSION_FAILED', e); process.exit(1); });
