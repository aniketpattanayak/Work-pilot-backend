// Integration tests: real Mongo (default mongodb://127.0.0.1:27017/wp_voice_test), real Express routes,
// real task controllers; only the telephony provider is faked.
// Run: node --test tests/voice/
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'voice-test-secret';
process.env.VOICE_WEBHOOK_SECRET = 'whsec_test';
process.env.VOICE_WEBHOOK_URL = 'https://api.example.test/api/voice/webhook';
const MONGO = process.env.VOICE_TEST_MONGO || 'mongodb://127.0.0.1:27017/wp_voice_test';

const Tenant = require('../../models/Tenant');
const Employee = require('../../models/Employee');
const DelegationTask = require('../../models/DelegationTask');
const VoiceCallLog = require('../../models/VoiceCallLog');
const vapi = require('../../utils/voice/vapiClient');
const { placeDoerCheckin, runDueCallbacks } = require('../../utils/voice/callService');

let server, base;
const calls = [];                                    // every outbound call the fake provider was asked to place
vapi.setClient({ createCall: async (c) => { calls.push(c); return { id: `call_${calls.length}`, status: 'queued' }; } });

const ENABLED = { enabled: null, off: null };       // tenants
let doer, assigner, admin, colleague, offDoer, offAssigner, superToken, adminToken, offAdminToken;
let taskA, taskB;

const hook = (message, secret = 'whsec_test') => fetch(`${base}/api/voice/webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-vapi-secret': secret } : {}) }, body: JSON.stringify({ message }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const api = (method, path, token, body) => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const toolCall = (call, name, args, id = `tc_${Math.random().toString(36).slice(2)}`) =>
  hook({ type: 'tool-calls', call, toolCallList: [{ id, type: 'function', function: { name, arguments: args } }] }).then((r) => r.body.results[0].result);
const inDays = (d, h = 14) => { const x = new Date(Date.now() + d * 86400000); x.setUTCHours(h - 5, 30 - 0, 0, 0); return x; }; // h:00 IST
const iso = (d) => d.toISOString();

test.before(async () => {
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 4000 });
  await mongoose.connection.dropDatabase();
  await Promise.all([Tenant.init(), Employee.init(), DelegationTask.init(), VoiceCallLog.init()]);

  const mk = (n) => Tenant.create({ companyName: `Co ${n}`, subdomain: `co-${n}`, adminEmail: `${n}@co.test`, password: 'x' });
  const tOn = await mk('on'), tOff = await mk('off');
  ENABLED.enabled = tOn; ENABLED.off = tOff;
  const emp = (t, name, roles, phone, extra = {}) => Employee.create({ tenantId: t._id, name, roles, whatsappNumber: '9000000000', email: `${name.replace(/\W/g, '').toLowerCase()}@${t.subdomain}.test`, password: 'x', ...extra });
  doer = await emp(tOn, 'Ravi Kumar', ['Doer'], null, { voiceBetaUser: true, voicePhone: '+919811111111', voicePhoneVerified: true });
  assigner = await emp(tOn, 'Anita Rao', ['Assigner'], null, { voiceBetaUser: true, voicePhone: '+919822222222', voicePhoneVerified: true });
  admin = await emp(tOn, 'Boss Man', ['Admin'], null, { voiceBetaUser: true, voicePhone: '+919833333333', voicePhoneVerified: true });
  colleague = await emp(tOn, 'Meera Shah', ['Doer'], null, {});                                        // not a beta user
  await emp(tOn, 'Unverified Uma', ['Assigner'], null, { voiceBetaUser: true, voicePhone: '+919844444444', voicePhoneVerified: false });
  offDoer = await emp(tOff, 'Off Doer', ['Doer'], null, { voiceBetaUser: true, voicePhone: '+919855555555', voicePhoneVerified: true });
  offAssigner = await emp(tOff, 'Off Assigner', ['Assigner', 'Admin'], null, { voiceBetaUser: true, voicePhone: '+919866666666', voicePhoneVerified: true });

  // The module is OFF by default for everyone, even when the schema is read fresh:
  assert.strictEqual((await Tenant.findById(tOn._id)).superAdmin.voiceModuleEnabled, false);
  assert.strictEqual((await Employee.findById(colleague._id)).voiceBetaUser, false);
  await Tenant.updateOne({ _id: tOn._id }, { $set: { 'superAdmin.voiceModuleEnabled': true } });

  const mkTask = (t, who, by, title, due) => DelegationTask.create({ tenantId: t._id, title, description: 'd', assignerId: by._id, doerId: who._id, deadline: due, status: 'Accepted', history: [{ action: 'Task Created', performedBy: by._id }] });
  taskA = await mkTask(tOn, doer, assigner, 'Send the invoice to ABC Traders', new Date(Date.now() - 86400000));
  taskB = await mkTask(tOn, doer, assigner, 'Update stock register', inDays(2));
  await mkTask(tOff, offDoer, offAssigner, 'Off tenant task', inDays(1));

  const app = express();
  app.use(express.json());
  app.use('/api/voice', require('../../routes/voiceRoutes'));
  app.use('/api/superadmin', require('../../routes/superAdminRoutes'));
  server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  superToken = jwt.sign({ id: 'MASTER_ID', roles: ['Admin'], isSuperAdmin: true }, process.env.JWT_SECRET);
  adminToken = jwt.sign({ id: String(admin._id), roles: ['Admin'], tenantId: String(tOn._id) }, process.env.JWT_SECRET);
  offAdminToken = jwt.sign({ id: String(offAssigner._id), roles: ['Admin'], tenantId: String(tOff._id) }, process.env.JWT_SECRET);
});

test.after(async () => { server && server.close(); await mongoose.disconnect(); });

// ───────────────────────────────────────────────────────────────────────────────
test('(a) OUTBOUND: agent calls the doer, finished task -> completed; unfinished -> blocker + new time + scheduled callback', async () => {
  const placed = await placeDoerCheckin({ tenantId: ENABLED.enabled._id, employeeId: doer._id, force: true });
  assert.ok(placed.placed, `call should be placed (${placed.reason})`);
  const out = calls.at(-1);
  assert.strictEqual(out.customerNumber, '+919811111111');
  const sys = out.assistant.model.messages[0].content;
  assert.ok(sys.includes('Send the invoice to ABC Traders') && sys.includes('Update stock register'));
  assert.ok(sys.includes('OVERDUE'));
  assert.deepStrictEqual(out.assistant.model.tools.map((t) => t.function.name).sort(), ['complete_task', 'log_blocker']);
  assert.ok(out.assistant.firstMessage.startsWith('Hi Ravi'));
  assert.ok(out.assistant.backchannelingEnabled === true);

  const log = await VoiceCallLog.findById(placed.log._id);
  assert.strictEqual(log.direction, 'outbound'); assert.strictEqual(log.purpose, 'doer_checkin'); assert.strictEqual(log.status, 'ringing');
  const call = { id: log.providerCallId, metadata: { voiceLogId: String(log._id) } };

  // Task A: "it's finished" -> real respondToTask runs (status + history)
  const r1 = await toolCall(call, 'complete_task', { taskId: String(taskA._id) });
  assert.match(r1, /marked completed/i);
  const doneA = await DelegationTask.findById(taskA._id);
  assert.strictEqual(doneA.status, 'Completed');
  assert.strictEqual(doneA.history.at(-1).action, 'Completed');
  assert.strictEqual(String(doneA.history.at(-1).performedBy), String(doer._id));

  // Task B: "not finished" -> reason + new expected time + callback
  const finish = inDays(2, 16), cbAt = inDays(2, 17);
  const r2 = await toolCall(call, 'log_blocker', { taskId: String(taskB._id), reason: 'Waiting for the supplier to send the counts', expectedFinishAt: iso(finish), callbackAt: iso(cbAt) });
  assert.match(r2, /follow-up call is scheduled/i);
  const stillOpen = await DelegationTask.findById(taskB._id);
  assert.strictEqual(stillOpen.status, 'Accepted', 'an unfinished task must not change status');
  assert.strictEqual(String(stillOpen.deadline), String(taskB.deadline), 'the task deadline itself is not touched');

  let after = await VoiceCallLog.findById(log._id);
  assert.strictEqual(after.blockerReason, 'Waiting for the supplier to send the counts');
  assert.strictEqual(after.expectedFinishAt.toISOString(), finish.toISOString());
  assert.strictEqual(after.callbackStatus, 'pending');
  assert.strictEqual(after.callbackAt.toISOString(), cbAt.toISOString());
  assert.strictEqual(after.taskOutcomes.length, 2);

  // a task that is not part of this call can't be touched, and nonsense times are refused
  const other = await DelegationTask.create({ tenantId: ENABLED.enabled._id, title: 'Not on call', assignerId: assigner._id, doerId: colleague._id, deadline: inDays(1), status: 'Accepted' });
  assert.match(await toolCall(call, 'complete_task', { taskId: String(other._id) }), /not part of this call/i);
  assert.strictEqual((await DelegationTask.findById(other._id)).status, 'Accepted');
  assert.match(await toolCall(call, 'log_blocker', { taskId: String(taskB._id), reason: 'x', expectedFinishAt: 'whenever' }), /does not look right/i);

  // provider sends the end-of-call report: recording + transcript are stored
  const eoc = await hook({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call', startedAt: new Date(Date.now() - 90000).toISOString(), endedAt: new Date().toISOString(), artifact: { recordingUrl: 'https://rec.example/c1.mp3', transcript: 'AI: Hi Ravi... User: The invoice is done.' }, analysis: { summary: 'Invoice done, stock register delayed.' } });
  assert.strictEqual(eoc.status, 200);
  after = await VoiceCallLog.findById(log._id);
  assert.strictEqual(after.recordingUrl, 'https://rec.example/c1.mp3');
  assert.match(after.transcript, /invoice is done/);
  assert.strictEqual(after.status, 'completed');
  assert.ok(after.durationSec >= 80);

  // The scheduled callback fires at its time and rings again about ONLY the unfinished task
  const before = calls.length;
  const res = await runDueCallbacks(new Date(cbAt.getTime() + 60000));
  assert.strictEqual(res.filter((x) => x.outcome === 'placed').length, 1);
  assert.strictEqual(calls.length, before + 1);
  const cbSys = calls.at(-1).assistant.model.messages[0].content;
  assert.ok(cbSys.includes('Update stock register') && !cbSys.includes('Send the invoice'));
  assert.ok(cbSys.includes('FOLLOW-UP') && cbSys.includes('Waiting for the supplier'));
  const cbLog = await VoiceCallLog.findOne({ callbackOfCallId: log._id });
  assert.ok(cbLog);
  assert.strictEqual((await VoiceCallLog.findById(log._id)).callbackStatus, 'placed');
  // ...and a second tick does not ring a third time
  assert.strictEqual((await runDueCallbacks(new Date(cbAt.getTime() + 120000))).length, 0);
});

test('(b) INBOUND: authorised assigner phones in and creates a task by voice', async () => {
  const call = { id: 'in_call_1', customer: { number: '098 2222 2222'.replace(/ /g, '').replace(/^0/, '+91') } };
  const ar = await hook({ type: 'assistant-request', call });
  assert.ok(ar.body.assistant, `assistant expected, got ${JSON.stringify(ar.body)}`);
  const names = ar.body.assistant.model.tools.map((t) => t.function.name);
  assert.deepStrictEqual(names.sort(), ['create_task', 'find_employee']);
  assert.ok(ar.body.assistant.model.messages[0].content.includes('Shall I go ahead'));
  const log = await VoiceCallLog.findOne({ providerCallId: 'in_call_1' });
  assert.strictEqual(log.direction, 'inbound'); assert.strictEqual(log.purpose, 'assigner_create_task');
  const live = { id: 'in_call_1', metadata: { voiceLogId: String(log._id) } };

  // look the colleague up, then try to create WITHOUT the caller's yes -> refused, nothing created
  const found = JSON.parse(await toolCall(live, 'find_employee', { name: 'meera' }));
  assert.strictEqual(found[0].name, 'Meera Shah');
  const args = { title: 'Prepare the GST file', description: 'Month end', assigneeId: found[0].employeeId, deadline: iso(inDays(3, 18)), priority: 'High' };
  const countBefore = await DelegationTask.countDocuments({ title: 'Prepare the GST file' });
  assert.match(await toolCall(live, 'create_task', { ...args, confirmed: false }), /Not confirmed/i);
  assert.strictEqual(await DelegationTask.countDocuments({ title: 'Prepare the GST file' }), countBefore);
  // a deadline in the past is refused
  assert.match(await toolCall(live, 'create_task', { ...args, deadline: iso(new Date(Date.now() - 3600000)), confirmed: true }), /not in the future/i);
  // someone outside the company can't be assigned
  assert.match(await toolCall(live, 'create_task', { ...args, assigneeId: String(offDoer._id), confirmed: true }), /could not find that person/i);

  // confirmed -> the real createTask controller runs
  const same = 'tc_create_1';
  const ok = await toolCall(live, 'create_task', { ...args, confirmed: true }, same);
  assert.match(ok, /Task created and assigned to Meera Shah/);
  const t = await DelegationTask.findOne({ title: 'Prepare the GST file' });
  assert.ok(t);
  assert.strictEqual(String(t.assignerId), String(assigner._id));
  assert.strictEqual(String(t.doerId), String(colleague._id));
  assert.strictEqual(String(t.tenantId), String(ENABLED.enabled._id));
  assert.strictEqual(t.priority, 'High'); assert.strictEqual(t.status, 'Accepted');
  assert.strictEqual(t.history[0].action, 'Task Created');
  assert.strictEqual(t.deadline.toISOString(), args.deadline);
  // provider retry of the same tool call, or the model repeating itself: no duplicate
  assert.match(await toolCall(live, 'create_task', { ...args, confirmed: true }, same), /already created/i);
  assert.match(await toolCall(live, 'create_task', { ...args, confirmed: true }), /already created/i);
  assert.strictEqual(await DelegationTask.countDocuments({ title: 'Prepare the GST file' }), 1);
  assert.deepStrictEqual((await VoiceCallLog.findById(log._id)).createdTaskIds.map(String), [String(t._id)]);

  // an assigner cannot use the admin-only summary tool
  assert.match(await toolCall(live, 'get_status_summary', {}), /not able to do that/i);
});

test('(b2) INBOUND: admin gets a status summary (overdue, blockers, team)', async () => {
  const ar = await hook({ type: 'assistant-request', call: { id: 'in_call_admin', customer: { number: '+919833333333' } } });
  assert.ok(ar.body.assistant);
  assert.ok(ar.body.assistant.model.tools.some((t) => t.function.name === 'get_status_summary'));
  const log = await VoiceCallLog.findOne({ providerCallId: 'in_call_admin' });
  assert.strictEqual(log.purpose, 'admin_inquiry');
  const sum = JSON.parse(await toolCall({ id: 'in_call_admin', metadata: { voiceLogId: String(log._id) } }, 'get_status_summary', { scope: 'overall' }));
  assert.ok(sum.pendingCount >= 1);
  assert.ok(sum.recentBlockers.some((b) => /supplier/.test(b.blocker) && b.person === 'Ravi Kumar'));
  assert.ok(sum.completedLast24h >= 1 && sum.completedBy.includes('Ravi Kumar'));
  assert.ok(!JSON.stringify(sum).includes('Off tenant task'), 'other companies are never included');
});

test('(c) FEATURE GATE: non-beta tenants / people are refused at every layer', async () => {
  const tasksBefore = await DelegationTask.countDocuments();
  const logsBefore = await VoiceCallLog.countDocuments();
  const callsBefore = calls.length;

  // inbound from a beta-flagged user whose COMPANY is not switched on -> refused, no assistant, no records
  const r1 = await hook({ type: 'assistant-request', call: { id: 'off_1', customer: { number: '+919866666666' } } });
  assert.ok(r1.body.error && !r1.body.assistant);
  // inbound from an enabled company but not a beta user / unverified phone / unknown number
  for (const n of ['+919800000000', '+919844444444', '+919000000001']) {
    const r = await hook({ type: 'assistant-request', call: { id: `x_${n}`, customer: { number: n } } });
    assert.ok(r.body.error, `${n} must be refused`);
  }
  // a beta doer (not an assigner/admin) may not use the inbound line
  assert.ok((await hook({ type: 'assistant-request', call: { id: 'doer_in', customer: { number: '+919811111111' } } })).body.error);

  // outbound is refused for the disabled company, for non-beta people, and during quiet hours
  assert.strictEqual((await placeDoerCheckin({ tenantId: ENABLED.off._id, employeeId: offDoer._id, force: true })).reason, 'MODULE_OFF');
  assert.strictEqual((await placeDoerCheckin({ tenantId: ENABLED.enabled._id, employeeId: colleague._id, force: true })).reason, 'NOT_BETA');
  assert.strictEqual((await placeDoerCheckin({ tenantId: ENABLED.enabled._id, employeeId: doer._id, now: new Date('2026-10-17T18:00:00Z') })).reason, 'OUTSIDE_CALLING_HOURS');

  // tool calls on a call whose company is switched off mid-call do nothing
  const live = await VoiceCallLog.create({ tenantId: ENABLED.off._id, employeeId: offAssigner._id, employeeName: 'x', phone: '+919866666666', direction: 'inbound', purpose: 'assigner_create_task', roles: ['Assigner'], providerCallId: 'off_live' });
  assert.match(await toolCall({ id: 'off_live', metadata: { voiceLogId: String(live._id) } }, 'create_task', { title: 'Sneaky', assigneeId: String(offDoer._id), deadline: iso(inDays(2)), confirmed: true }), /not available/i);

  // webhook without / with a wrong secret
  assert.strictEqual((await hook({ type: 'status-update' }, null)).status, 401);
  assert.strictEqual((await hook({ type: 'status-update' }, 'nope')).status, 401);

  // admin endpoints: company must be enabled, caller must be admin
  assert.strictEqual((await api('GET', '/api/voice/logs', offAdminToken)).status, 403);
  assert.strictEqual((await api('POST', '/api/voice/outbound/checkin', offAdminToken, { employeeId: String(offDoer._id) })).status, 403);
  assert.strictEqual((await api('GET', '/api/voice/logs', adminToken)).status, 200);
  const doerToken = jwt.sign({ id: String(doer._id), roles: ['Doer'], tenantId: String(ENABLED.enabled._id) }, process.env.JWT_SECRET);
  assert.strictEqual((await api('GET', '/api/voice/logs', doerToken)).status, 403);

  // Only the Superadmin can switch things on
  for (const [m, p, b] of [
    ['PUT', `/api/superadmin/tenants/${ENABLED.off._id}/voice`, { enabled: true }],
    ['PUT', `/api/superadmin/tenants/${ENABLED.off._id}/voice/users/${offDoer._id}`, { voiceBetaUser: true }],
    ['GET', `/api/superadmin/tenants/${ENABLED.off._id}/voice`, null],
  ]) assert.strictEqual((await api(m, p, adminToken, b)).status, 403, `${m} ${p} must be superadmin only`);
  assert.strictEqual((await Tenant.findById(ENABLED.off._id)).superAdmin.voiceModuleEnabled, false);

  // nothing in the existing data changed and nothing was called
  assert.strictEqual(await DelegationTask.countDocuments(), tasksBefore);
  assert.strictEqual(calls.length, callsBefore);
  assert.strictEqual(await VoiceCallLog.countDocuments(), logsBefore + 1 /* the 'off_live' fixture */ + 0);
});

test('(c2) Superadmin turns a company on, designates a beta user, and off again (cancels callbacks)', async () => {
  const tid = ENABLED.off._id;
  // person flags are refused while the company is off
  assert.strictEqual((await api('PUT', `/api/superadmin/tenants/${tid}/voice/users/${offDoer._id}`, superToken, { voiceBetaUser: true })).status, 409);
  assert.strictEqual((await api('PUT', `/api/superadmin/tenants/${tid}/voice`, superToken, { enabled: 'yes' })).status, 400);
  assert.strictEqual((await api('PUT', `/api/superadmin/tenants/${tid}/voice`, superToken, { enabled: true })).status, 200);
  assert.strictEqual((await Tenant.findById(tid)).superAdmin.voiceModuleEnabled, true);

  const plain = await Employee.create({ tenantId: tid, name: 'Plain Pat', roles: ['Doer'], whatsappNumber: '9', email: 'pat@off.test', password: 'x' });
  const put = (b) => api('PUT', `/api/superadmin/tenants/${tid}/voice/users/${plain._id}`, superToken, b);
  assert.strictEqual((await put({ voiceBetaUser: true })).status, 400, 'beta needs a verified phone');
  assert.strictEqual((await put({ voicePhone: 'abc' })).status, 400);
  assert.strictEqual((await put({ voicePhone: '98 7654 3210', voicePhoneVerified: true, voiceBetaUser: true })).status, 200);
  const saved = await Employee.findById(plain._id);
  assert.strictEqual(saved.voicePhone, '+919876543210'); assert.ok(saved.voiceBetaUser && saved.voicePhoneVerified);
  // changing the number drops the verification and the beta access that depended on it... until re-verified
  assert.strictEqual((await put({ voicePhone: '9123456789' })).status, 200);
  assert.strictEqual((await Employee.findById(plain._id)).voicePhoneVerified, false);
  // the same number can't be shared by two beta users
  assert.strictEqual((await api('PUT', `/api/superadmin/tenants/${tid}/voice/users/${offDoer._id}`, superToken, { voicePhone: '+919855555555', voicePhoneVerified: true, voiceBetaUser: true })).status, 200);
  const clash = await api('PUT', `/api/superadmin/tenants/${tid}/voice/users/${plain._id}`, superToken, { voicePhone: '+919855555555', voicePhoneVerified: true, voiceBetaUser: true });
  assert.strictEqual(clash.status, 409);

  // now the previously refused number works (company on + verified beta)
  assert.ok((await hook({ type: 'assistant-request', call: { id: 'now_on', customer: { number: '+919866666666' } } })).body.assistant);

  // switching it off again: inbound refused immediately and waiting callbacks cancelled
  const pending = await VoiceCallLog.create({ tenantId: tid, employeeId: offDoer._id, direction: 'outbound', purpose: 'doer_checkin', callbackStatus: 'pending', callbackAt: new Date(Date.now() + 3600000) });
  assert.strictEqual((await api('PUT', `/api/superadmin/tenants/${tid}/voice`, superToken, { enabled: false })).status, 200);
  assert.ok((await hook({ type: 'assistant-request', call: { id: 'now_off', customer: { number: '+919866666666' } } })).body.error);
  assert.strictEqual((await VoiceCallLog.findById(pending._id)).callbackStatus, 'cancelled');
});

test('no-answer on an outbound check-in schedules a bounded retry', async () => {
  // fresh doer so the "called recently" guard doesn't apply
  const d2 = await Employee.create({ tenantId: ENABLED.enabled._id, name: 'Nina Noanswer', roles: ['Doer'], whatsappNumber: '9', email: 'nina@on.test', password: 'x', voiceBetaUser: true, voicePhone: '+919877777777', voicePhoneVerified: true });
  await DelegationTask.create({ tenantId: ENABLED.enabled._id, title: 'Nina task', assignerId: assigner._id, doerId: d2._id, deadline: inDays(1), status: 'Accepted' });
  const p = await placeDoerCheckin({ tenantId: ENABLED.enabled._id, employeeId: d2._id, force: true });
  assert.ok(p.placed);
  await hook({ type: 'end-of-call-report', call: { id: p.log.providerCallId, metadata: { voiceLogId: String(p.log._id) } }, endedReason: 'customer-did-not-answer', artifact: {} });
  const l = await VoiceCallLog.findById(p.log._id);
  assert.strictEqual(l.status, 'no-answer'); assert.strictEqual(l.callbackStatus, 'pending'); assert.ok(l.callbackAt > new Date());
});
