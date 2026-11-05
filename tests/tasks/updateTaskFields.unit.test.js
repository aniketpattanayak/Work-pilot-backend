// Unit tests for the Edit Task form: deadline time, "allow deadline change" settings, attachments. No database needed.
// Run: node --test tests/tasks/updateTaskFields.unit.test.js
const test = require('node:test');
const assert = require('node:assert');
const Tenant = require('../../models/Tenant');
const ctl = require('../../controllers/taskController');

const oid = (n) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const TENANT = oid(99), ASSIGNER = oid(1), DOER = oid(2), OTHER = oid(3);
const thenable = (value) => { const p = Promise.resolve(value); const o = { populate: () => o, select: () => o, lean: () => o, then: (a, b) => p.then(a, b), catch: (b) => p.catch(b) }; return o; };

function makeTask(over = {}) {
  return {
    _id: oid(50), tenantId: TENANT, title: 'T', description: 'd', status: 'Accepted', priority: 'Medium',
    assignerId: ASSIGNER, doerId: DOER, deadline: new Date('2026-11-10T18:29:00.000Z'), // 10 Nov, 11:59 PM IST
    isRevisionAllowed: true, maxExtensionDays: 3, coworkers: [], files: [], history: [], dateChanges: [], saves: 0,
    async save() { this.saves += 1; }, ...over
  };
}
async function call(fn, task, user, body, params = {}, files) {
  const original = Tenant.findById;
  Tenant.findById = () => thenable({ _id: TENANT, settings: {} });
  const models = { DelegationTask: { findById: () => thenable(task) }, Employee: { findById: () => thenable(null), find: () => thenable([]) } };
  const req = { params: { taskId: task._id, ...params }, body, files, user: { tenantId: TENANT, ...user }, db: { model: (n) => models[n] } };
  let code = 200, payload; const res = { status(c) { code = c; return res; }, json(p) { payload = p; return res; } };
  try { await ctl[fn](req, res); } finally { Tenant.findById = original; }
  return { code, payload };
}
const assigner = { id: ASSIGNER, roles: ['Assigner'] };

test('only the time of the deadline changes: saved, no reason needed', async () => {
  const t = makeTask();
  const r = await call('updateTask', t, assigner, { deadlineAt: '2026-11-10T12:30:00.000Z' }); // 6:00 PM IST, same day
  assert.strictEqual(r.code, 200, JSON.stringify(r.payload));
  assert.strictEqual(t.deadline.toISOString(), '2026-11-10T12:30:00.000Z');
  assert.ok(t.history.some((h) => /deadline time/.test(h.remarks)));
});

test('same deadline sent again changes nothing', async () => {
  const t = makeTask();
  const r = await call('updateTask', t, assigner, { deadlineAt: t.deadline.toISOString() });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(t.saves, 0);
});

test('an invalid deadline is rejected', async () => {
  const t = makeTask();
  const r = await call('updateTask', t, assigner, { deadlineAt: 'not-a-date' });
  assert.strictEqual(r.code, 400);
});

test('allow-deadline-change settings are saved', async () => {
  const t = makeTask();
  let r = await call('updateTask', t, assigner, { isRevisionAllowed: 'true', maxExtensionDays: '7' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.payload));
  assert.strictEqual(t.maxExtensionDays, 7);
  r = await call('updateTask', t, assigner, { isRevisionAllowed: 'false', maxExtensionDays: '0' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(t.isRevisionAllowed, false);
  assert.strictEqual(t.maxExtensionDays, 0);
});

test('deadline change allowed but extension days missing is rejected', async () => {
  const t = makeTask();
  const r = await call('updateTask', t, assigner, { isRevisionAllowed: true, maxExtensionDays: '' });
  assert.strictEqual(r.code, 400);
});

test('files are added by the assigner, not by someone else', async () => {
  const t = makeTask();
  const f = [{ originalname: 'a.pdf', location: 'https://x/a.pdf' }];
  let r = await call('addTaskFiles', t, { id: OTHER, roles: ['Doer'] }, {}, {}, f);
  assert.strictEqual(r.code, 403);
  r = await call('addTaskFiles', t, assigner, {}, {}, f);
  assert.strictEqual(r.code, 200, JSON.stringify(r.payload));
  assert.strictEqual(t.files.length, 1);
  r = await call('addTaskFiles', t, assigner, {}, {}, []);
  assert.strictEqual(r.code, 400);
});
