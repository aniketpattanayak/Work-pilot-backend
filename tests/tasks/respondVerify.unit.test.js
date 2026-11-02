// Unit tests for POST/PUT /tasks/respond: early completion and "Verify keeps the task Completed". No database needed.
// Run: node --test tests/tasks/respondVerify.unit.test.js
const test = require('node:test');
const assert = require('node:assert');
const Tenant = require('../../models/Tenant');
const ctl = require('../../controllers/taskController');

const oid = (n) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const TENANT = oid(99), ASSIGNER = oid(1), DOER = oid(2), OTHER = oid(3);

const thenable = (value) => {
  const p = Promise.resolve(value);
  const o = { populate: () => o, select: () => o, lean: () => o, then: (a, b) => p.then(a, b), catch: (b) => p.catch(b) };
  return o;
};

function makeTask(over = {}) {
  const t = {
    _id: oid(50), tenantId: TENANT, title: 'T', status: 'Accepted',
    assignerId: { _id: ASSIGNER, name: 'Anita' }, doerId: { _id: DOER, name: 'Dev' }, coordinatorId: null,
    deadline: new Date(Date.now() + 3 * 86400000), createdAt: new Date(Date.now() - 86400000),
    history: [], files: [], forwardChain: [], coworkers: [], saves: 0,
    async save() { this.saves += 1; },
    ...over
  };
  return t;
}

async function respond(task, user, body) {
  const original = Tenant.findById;
  Tenant.findById = () => thenable(null);                       // no points / whatsapp settings
  const models = {
    DelegationTask: { findById: () => thenable(task) },
    Employee: { findById: () => thenable(null), find: () => thenable([]) },
    ChecklistTask: {}, FlowInstance: {}
  };
  const req = { body, user: { tenantId: TENANT, ...user }, db: { model: (n) => models[n] } };
  let code = 200, payload;
  const res = { status(c) { code = c; return res; }, json(p) { payload = p; return res; } };
  try { await ctl.respondToTask(req, res); } finally { Tenant.findById = original; }
  return { code, payload };
}

const assigner = { id: ASSIGNER, roles: ['Assigner'] };
const doer = { id: DOER, roles: ['Doer'] };

test('a delegation task can be completed before its deadline (not Admin, deadline 3 days away)', async () => {
  const t = makeTask();
  const r = await respond(t, doer, { taskId: t._id, status: 'Completed', doerId: DOER, remarks: 'done early' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.payload));
  assert.strictEqual(t.status, 'Completed');
  assert.ok(t.history.some((h) => h.action === 'Completed'), 'the real completion time is recorded in the history');
});

test('Verify keeps the task Completed and records one Verified entry', async () => {
  const t = makeTask({ status: 'Completed', history: [{ action: 'Completed', timestamp: new Date() }] });
  const r = await respond(t, assigner, { taskId: t._id, status: 'Verified', doerId: ASSIGNER, remarks: 'looks good' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.payload));
  assert.strictEqual(t.status, 'Completed', 'status must not change');
  const v = t.history.filter((h) => h.action === 'Verified');
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].remarks, 'looks good');
  assert.ok(!t.history.some((h) => h.action === 'Points Calculated'), 'no second points calculation');
  assert.strictEqual(t.saves, 1);
});

test('Verify without a note uses a default note; verifying twice does not add a second entry', async () => {
  const t = makeTask({ status: 'Completed', history: [{ action: 'Completed', timestamp: new Date() }] });
  await respond(t, assigner, { taskId: t._id, status: 'Verified', doerId: ASSIGNER });
  const again = await respond(t, assigner, { taskId: t._id, status: 'Verified', doerId: ASSIGNER });
  assert.strictEqual(again.code, 200);
  assert.match(again.payload.message, /already verified/i);
  const v = t.history.filter((h) => h.action === 'Verified');
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].remarks, 'Work verified.');
  assert.strictEqual(t.saves, 1);
});

test('sent back and completed again: it can be verified again', async () => {
  const t = makeTask({ status: 'Completed', history: [
    { action: 'Completed', timestamp: new Date() }, { action: 'Verified', timestamp: new Date() },
    { action: 'Sent Back', timestamp: new Date() }, { action: 'Completed', timestamp: new Date() }] });
  const r = await respond(t, assigner, { taskId: t._id, status: 'Verified', doerId: ASSIGNER });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(t.history.filter((h) => h.action === 'Verified').length, 2);
  assert.strictEqual(t.status, 'Completed');
});

test('only the assigner (or Admin) can verify; the doer cannot', async () => {
  const t = makeTask({ status: 'Completed', history: [{ action: 'Completed', timestamp: new Date() }] });
  const r = await respond(t, doer, { taskId: t._id, status: 'Verified', doerId: DOER });
  assert.strictEqual(r.code, 403);
  assert.ok(!t.history.some((h) => h.action === 'Verified'));
  const admin = await respond(t, { id: OTHER, roles: ['Admin'] }, { taskId: t._id, status: 'Verified', doerId: OTHER });
  assert.strictEqual(admin.code, 200);
});

test('a task that is not completed cannot be verified; an old task saved as Verified stays as it is', async () => {
  const open = makeTask({ status: 'Accepted' });
  const r = await respond(open, assigner, { taskId: open._id, status: 'Verified', doerId: ASSIGNER });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(open.status, 'Accepted');
  const legacy = makeTask({ status: 'Verified', history: [{ action: 'Completed', timestamp: new Date() }, { action: 'Verified', timestamp: new Date() }] });
  const l = await respond(legacy, assigner, { taskId: legacy._id, status: 'Verified', doerId: ASSIGNER });
  assert.strictEqual(l.code, 200);
  assert.strictEqual(legacy.status, 'Verified');
  assert.strictEqual(legacy.history.filter((h) => h.action === 'Verified').length, 1);
});

test('after Verify the assigner can still send the task back; it then shows as Sent Back', async () => {
  const t = makeTask({ status: 'Completed', history: [{ action: 'Completed', timestamp: new Date() }, { action: 'Verified', timestamp: new Date() }] });
  const r = await respond(t, assigner, { taskId: t._id, status: 'Accepted', doerId: ASSIGNER, remarks: 'please redo' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.payload));
  assert.strictEqual(t.status, 'Accepted');
  assert.strictEqual(t.history[t.history.length - 1].action, 'Sent Back');
});
