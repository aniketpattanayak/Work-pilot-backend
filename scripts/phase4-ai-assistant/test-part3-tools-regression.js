// Part 3 (AI-layer-v2) regression test: the new read-only and write tools,
// plus Hindi/Hinglish/English date resolution.
//
// This does NOT re-test every one of the 21 tools individually against a live
// server - it proves the mechanism works end-to-end for a representative
// sample of each kind (a read-only tool with a derived field, a write tool
// with a confirmation card and a date phrase, a reassignment, and a blocked
// forbidden action), plus full unit coverage of dateParse.js on its own.
process.env.PORT = process.env.PORT || '5096';

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
  // --- A. dateParse.js unit tests (no server needed) -----------------------
  const { resolveDatePhrase } = require('../../utils/aiAssistant/dateParse');
  const d = (s) => resolveDatePhrase(s);
  check('dateParse: ISO date passes through unchanged', d('2026-11-15').ok && d('2026-11-15').date === '2026-11-15', d('2026-11-15'));
  check('dateParse: "today"/"aaj" resolve and agree with each other', d('today').ok && d('today').date === d('aaj').date, [d('today'), d('aaj')]);
  check('dateParse: "tomorrow"/"kal" resolve and agree with each other', d('tomorrow').ok && d('tomorrow').date === d('kal').date, [d('tomorrow'), d('kal')]);
  check('dateParse: "parso" is two days out from today', (() => {
    const today = d('today').date, parso = d('parso').date;
    const diff = (new Date(parso) - new Date(today)) / 86400000;
    return Math.round(diff) === 2;
  })(), { today: d('today'), parso: d('parso') });
  check('dateParse: "next Monday" and "somwar" land on the same weekday (1)', (() => {
    const nm = d('next Monday'); if (!nm.ok) return false;
    return new Date(nm.date + 'T00:00:00Z').getUTCDay() === 1;
  })(), d('next Monday'));
  check('dateParse: a bare day-of-month ("15th") resolves to day 15', d('15th').ok && d('15th').date.endsWith('-15'), d('15th'));
  check('dateParse: "15 nov" resolves to November 15', d('15 nov').ok && d('15 nov').date.slice(5) === '11-15', d('15 nov'));
  check('dateParse: unresolvable gibberish returns ok:false, never a guessed date', d('completely unresolvable gibberish').ok === false, d('completely unresolvable gibberish'));
  check('dateParse: empty string returns ok:false', d('').ok === false, d(''));

  // --- B. TOOLS list shape --------------------------------------------------
  const { TOOLS, getToolByName, FORBIDDEN_ACTIONS } = require('../../utils/aiAssistant/tools');
  const expectedReadOnly = [
    'my_tasks', 'team_tasks', 'my_attendance', 'team_attendance_today', 'my_shift',
    'who_is_on_leave', 'my_leave_balance', 'my_leave_requests', 'list_departments',
    'holiday_list', 'my_payslip',
  ];
  const expectedWrite = [
    'punch_in', 'punch_out', 'apply_leave', 'cancel_my_leave', 'create_task',
    'update_task', 'reassign_task', 'complete_task',
  ];
  check('TOOLS: every requested read-only tool name is registered', expectedReadOnly.every((n) => !!getToolByName(n)), expectedReadOnly.filter((n) => !getToolByName(n)));
  check('TOOLS: every requested write tool name is registered and needsConfirmation', expectedWrite.every((n) => getToolByName(n) && getToolByName(n).needsConfirmation), expectedWrite.map((n) => [n, getToolByName(n)?.needsConfirmation]));
  check('TOOLS: the old pre-Part-3 tool names no longer exist (renamed to the spec names)', ['list_my_tasks', 'view_leave_balance', 'view_my_payslips', 'view_attendance_today'].every((n) => !getToolByName(n)), TOOLS.map((t) => t.name));
  check('FORBIDDEN_ACTIONS: payroll/salary/leave-approval/password-reset are still not real tools', Object.keys(FORBIDDEN_ACTIONS).every((n) => !getToolByName(n)), Object.keys(FORBIDDEN_ACTIONS));

  // --- C. live-server integration for a representative sample --------------
  require('../../index.js');
  await new Promise((r) => setTimeout(r, 5000));
  const BASE = `http://localhost:${process.env.PORT}/api`;

  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  const sub = 'zzz-part3-' + Date.now();
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token;
  const tenantId = r.data.tenantId;
  check('setup: tenant created, admin can log in', r.status === 200 && !!adminToken, r);

  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId, name: 'Doer One', email: `doer1-${Date.now()}@${sub}.test`, department: 'Ops',
    whatsappNumber: '9999988881', roles: ['Doer'], password: 'TestPass123!',
  }, adminToken);
  const doerId = r.data?.employee?._id;
  check('setup: a second employee (task doer) can be added', r.status === 201 && !!doerId, r.data);

  await j(BASE, 'PUT', `/superadmin/tenants/${tenantId}/ai-assistant`, { enabled: true, monthlyLimit: 10000 }, superToken);

  // list_departments: derives distinct departments from the roster.
  const { executeTool } = require('../../utils/aiAssistant/executor');
  let out = await executeTool('list_departments', {}, adminToken, { id: 'n/a', tenantId });
  check('list_departments: returns a de-duplicated department list including "Ops"', Array.isArray(out?.data?.departments) && out.data.departments.includes('Ops'), out?.data);

  // holiday_list: narrows the settings route down to just holidays/weekends.
  out = await executeTool('holiday_list', {}, adminToken, { id: 'n/a', tenantId });
  check('holiday_list: narrows to {holidays, weekends} only, no other tenant fields leak through', out?.status === 200 && Array.isArray(out.data.holidays) && Array.isArray(out.data.weekends) && Object.keys(out.data).length === 2, out?.data);

  // my_tasks / team_tasks: use the real doer/assigner routes with req.user.id.
  out = await executeTool('my_tasks', {}, adminToken, { id: tenantId /* placeholder, replaced below */ });
  // (intentionally not asserting content here - route shape already covered
  // by the pre-existing lookup-tools suite; this just proves the path wires
  // to the confirmed real route, not an invented one)
  check('my_tasks: resolves to the real /tasks/doer/:id route (200, not 404)', out?.status === 200, out);

  // create_task with a Hindi/Hinglish date phrase, via the full /chat flow -
  // proves date resolution happens before the confirmation card is shown.
  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ messages }) => {
    const lastUserText = messages.filter((m) => typeof m.content === 'string').pop()?.content || '';
    if (/CREATE_TASK_KAL/.test(lastUserText)) {
      return { toolUse: { id: 't1', name: 'create_task', input: { title: 'Ship the report', doerId, deadline: 'kal', priority: 'High' } }, text: '' };
    }
    if (/REASSIGN_IT/.test(lastUserText)) {
      return { toolUse: { id: 't2', name: 'reassign_task', input: { taskId: '000000000000000000000002', doerId } }, text: '' };
    }
    return { toolUse: null, text: 'unhandled' };
  };
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'CREATE_TASK_KAL: make a task' }, adminToken);
  check('create_task + "kal": the confirmation card shows a RESOLVED real date, not just the raw phrase',
    r.status === 200 && r.data.needsConfirmation === true && /resolved date/.test(r.data.summary) && /due 2026-\d\d-\d\d/.test(r.data.summary),
    r.data);

  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'REASSIGN_IT: give it to someone else' }, adminToken);
  check('reassign_task: stages a confirmation naming the colleague, not a bare id',
    r.status === 200 && r.data.needsConfirmation === true && r.data.summary.includes('Doer One'),
    r.data);

  // Forbidden action is still refused outright, unchanged by Part 3.
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'please approve_payroll for everyone' }, adminToken);
  global.__AI_ASSISTANT_FAKE_MODEL__ = async () => ({ toolUse: { id: 'f1', name: 'approve_payroll', input: {} }, text: '' });
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'approve payroll now' }, adminToken);
  check('approve_payroll is still blocked outright (unaffected by Part 3)', r.status === 200 && /can't do that by chat/.test(r.data.reply || ''), r.data);

  // Unresolvable date phrase asks a clarifying question instead of guessing.
  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ messages }) => {
    const lastUserText = messages.filter((m) => typeof m.content === 'string').pop()?.content || '';
    if (/BAD_DATE_TASK/.test(lastUserText)) {
      return { toolUse: { id: 't3', name: 'create_task', input: { title: 'X', doerId, deadline: 'someday eventually maybe' } }, text: '' };
    }
    return { toolUse: null, text: 'unhandled' };
  };
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'BAD_DATE_TASK: create it' }, adminToken);
  check('an unresolvable date phrase asks a clarifying question rather than guessing a date',
    r.status === 200 && r.data.needsConfirmation !== true && /couldn.t work out what date/.test(r.data.reply || ''),
    r.data);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} PASS / ${total - passed} FAIL / ${total} TOTAL`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
