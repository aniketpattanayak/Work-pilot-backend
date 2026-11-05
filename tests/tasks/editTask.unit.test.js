// Unit tests for PUT /tasks/:taskId (Edit Task): deadline-change settings and deadline time. No database needed.
// Run: node --test tests/tasks/editTask.unit.test.js
const test = require('node:test');
const assert = require('node:assert');
const ctl = require('../../controllers/taskController');

const oid = (n) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const TENANT = oid(99), ASSIGNER = oid(1), DOER = oid(2);
const thenable = (v) => { const p = Promise.resolve(v); const o = { populate: () => o, select: () => o, lean: () => o, then: (a, b) => p.then(a, b), catch: (b) => p.catch(b) }; return o; };

function makeTask(over = {}) {
  return { _id: oid(50), tenantId: TENANT, title: 'T', description: '', priority: 'Medium', status: 'Accepted',
    assignerId: ASSIGNER, doerId: DOER, deadline: new Date('2026-11-10T12:00:00.000Z'),
    isRevisionAllowed: true, maxExtensionDays: 3, history: [], files: [], coworkers: [], saves: 0,
    async save() { this.saves += 1; }, ...over };
}
async function edit(task, body, user = { id: ASSIGNER, roles: ['Assigner'], tenantId: TENANT }) {
  const models = { DelegationTask: { findById: () => thenable(task) }, Employee: { findById: () => thenable(null), find: () => thenable([]) } };
  const req = { params: { taskId: task._id }, body, user, db: { model: (n) => models[n] } };
  let code = 200, payload; const res = { status(c) { code = c; return res; }, json(p) { payload = p; return res; } };
  await ctl.updateTask(req, res); return { code, payload };
}

test('turning off "Allow deadline change" saves it and clears the extension days', async () => {
  const t = makeTask();
  const r = await edit(t, { isRevisionAllowed: false, maxExtensionDays: '5' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(t.isRevisionAllowed, false);
  assert.strictEqual(t.maxExtensionDays, 0);
  assert.strictEqual(t.saves, 1);
});
test('extension days are saved and capped at 90', async () => {
  const t = makeTask();
  await edit(t, { isRevisionAllowed: true, maxExtensionDays: '500' });
  assert.strictEqual(t.maxExtensionDays, 90);
});
test('same settings = no change, nothing saved', async () => {
  const t = makeTask();
  const r = await edit(t, { isRevisionAllowed: true, maxExtensionDays: '3' });
  assert.strictEqual(r.payload.message, 'No changes to save.');
  assert.strictEqual(t.saves, 0);
});
test('changing only the time of the same day updates the deadline', async () => {
  const t = makeTask();
  const r = await edit(t, { deadline: '2026-11-10T17:30', deadlineIso: '2026-11-10T14:00:00.000Z' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.payload));
  assert.strictEqual(t.deadline.toISOString(), '2026-11-10T14:00:00.000Z');
});
test('a person who is not the assigner or admin cannot edit', async () => {
  const t = makeTask();
  const r = await edit(t, { title: 'x' }, { id: oid(7), roles: ['Doer'], tenantId: TENANT });
  assert.strictEqual(r.code, 403);
});
