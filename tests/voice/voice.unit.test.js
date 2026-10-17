// Unit tests (no database, no network): phone/time rules, tone instructions, tool allow-lists, webhook auth.
// Run: node --test tests/voice/
const test = require('node:test');
const assert = require('node:assert');

process.env.VOICE_WEBHOOK_SECRET = 'unit-secret';
const { normalizePhone, clampToCallingHours, withinCallingHours, formatIst } = require('../../utils/voice/phone');
const prompts = require('../../utils/voice/prompts');
const { allowedTools, resolveCallbackAt } = require('../../utils/voice/voiceTools');

test('phone numbers are normalised to E.164 and junk is refused', () => {
  assert.strictEqual(normalizePhone('98765 43210'), '+919876543210');
  assert.strictEqual(normalizePhone('09876543210'), '+919876543210');
  assert.strictEqual(normalizePhone('+1 (415) 555-0100'), '+14155550100');
  assert.strictEqual(normalizePhone('12345'), '');
  assert.strictEqual(normalizePhone(''), '');
});

test('calls are only placed 9-19 IST; later times roll to 10:00 IST', () => {
  assert.ok(withinCallingHours(new Date('2026-10-19T06:00:00Z')));            // 11:30 IST
  assert.ok(!withinCallingHours(new Date('2026-10-17T16:30:00Z')));           // 22:00 IST
  assert.strictEqual(clampToCallingHours(new Date('2026-10-17T16:30:00Z')).toISOString(), '2026-10-18T04:30:00.000Z'); // next day 10:00 IST
  assert.strictEqual(clampToCallingHours(new Date('2026-10-18T02:00:00Z')).toISOString(), '2026-10-18T04:30:00.000Z'); // 07:30 IST -> 10:00 IST
  assert.match(formatIst(new Date('2026-10-17T16:23:00Z')), /Saturday, 17 October 2026, 9:53 PM IST/);
});

test('callback time: missing/past -> sensible default, always inside calling hours', () => {
  const now = new Date('2026-10-19T06:00:00Z');
  const finish = new Date('2026-10-19T12:00:00Z');
  const cb = resolveCallbackAt(undefined, finish, now);
  assert.ok(cb > now && withinCallingHours(cb));
  const given = resolveCallbackAt('2026-10-20T14:00:00+05:30', finish, now);
  assert.strictEqual(given.toISOString(), '2026-10-20T08:30:00.000Z');
  const early = resolveCallbackAt('2026-10-20T08:00:00+05:30', finish, now);
  assert.strictEqual(early.toISOString(), '2026-10-20T04:30:00.000Z'); // 08:00 IST is before calling hours -> 10:00 IST
  const night = resolveCallbackAt('2026-10-20T23:00:00+05:30', finish, now);
  assert.ok(withinCallingHours(night));
});

test('tone instructions carry the human-voice rules', () => {
  const doer = prompts.doerCheckinPrompt({ employee: { name: 'Ravi Kumar' }, tasks: [{ id: 't1', title: 'Send invoice', deadlineIst: 'x' }], nowIst: 'now' });
  for (const must of ['one or two short sentences', '...', 'Got it', 'Understood', 'Right', 'kind', 'ONE question at a time', 'No lists', 'automated voice assistant']) {
    assert.ok(doer.includes(must), `doer prompt should mention: ${must}`);
  }
  assert.ok(doer.includes('log_blocker') && doer.includes('complete_task'));
  assert.ok(!/as an AI language model/i.test(doer));
  const open = prompts.firstMessageForDoer({ name: 'Ravi Kumar' }, 'Send invoice', false);
  assert.ok(open.includes('...') && open.startsWith('Hi Ravi'));
  assert.ok(open.split(/(?<=[^.][.?!])\s+/).length <= 2, 'opening stays at two short sentences');
});

test('tools are limited by purpose and live roles', () => {
  assert.deepStrictEqual(allowedTools({ purpose: 'doer_checkin' }, { roles: ['Doer', 'Admin'] }), ['complete_task', 'log_blocker']);
  assert.deepStrictEqual(allowedTools({ purpose: 'assigner_create_task' }, { roles: ['Assigner'] }), ['find_employee', 'create_task']);
  assert.deepStrictEqual(allowedTools({ purpose: 'admin_inquiry' }, { roles: ['Admin'] }), ['find_employee', 'create_task', 'get_status_summary']);
  assert.deepStrictEqual(allowedTools({ purpose: 'assigner_create_task' }, { roles: ['Doer'] }), []);
});

test('webhook refuses requests without the shared secret', async () => {
  const { webhook } = require('../../controllers/voiceController');
  const call = async (headers) => { let out; await webhook({ headers, body: { message: { type: 'status-update' } } }, { status(c) { out = { c }; return this; }, json(b) { out.b = b; } }); return out.c; };
  assert.strictEqual(await call({}), 401);
  assert.strictEqual(await call({ 'x-vapi-secret': 'wrong' }), 401);
  delete process.env.VOICE_WEBHOOK_SECRET; // no secret configured = everything refused
  assert.strictEqual(await call({ 'x-vapi-secret': 'unit-secret' }), 401);
});
