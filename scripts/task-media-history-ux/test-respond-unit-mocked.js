// Unit-level test of the REAL exports.respondToTask code, with the Mongoose
// models monkey-patched instead of hitting a database.
//
// Why this exists: this sandbox cannot run a real MongoDB (mongodb-memory-
// server's binary download, and MongoDB's own apt repo, are both blocked by
// this environment's network allowlist - confirmed via the agent proxy
// status endpoint). This is NOT a substitute for the full regression suite
// against a real database (scripts/task-media-history-ux/test-respond-
// multi-evidence-regression.js, scripts/fix-respond-tenant-isolation/test-
// respond-roles-regression.js, and the cross-tenant checks in scripts/
// release-security-fixes/) - those still need to run wherever a reachable
// Mongo exists, before this merge goes to production. This script instead
// directly calls the real, merged respondToTask with a fake DelegationTask/
// Employee/Tenant so the core logic (permission checks, multi-file push,
// remarks persistence) gets *some* automated coverage here and now.

const path = require('path');
const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 400));
}

// Mimics a chainable Mongoose query: supports any number of .populate(...)
// calls and is itself awaitable, resolving to `value`.
function mockQuery(value) {
  const q = {
    populate: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: (reject) => Promise.resolve(value).catch(reject),
  };
  return q;
}

function makeTask(overrides = {}) {
  return {
    _id: 'task1',
    tenantId: 'tenantA',
    assignerId: { _id: 'assigner1' },
    doerId: { _id: 'doer1', leaveStatus: {} },
    coordinatorId: null,
    helperDoers: [],
    forwardChain: [],
    coworkers: [],
    status: 'Accepted',
    deadline: new Date(Date.now() + 86400000),
    createdAt: new Date(),
    history: [],
    files: [],
    remarks: '',
    save: async function () { return this; },
    ...overrides,
  };
}

function makeReqRes({ taskId = 'task1', status, remarks, doerId, files = [], user }) {
  const req = {
    db: null, // forces getModels() to use the monkey-patched real model objects
    body: { taskId, status, remarks, doerId },
    files,
    user,
  };
  let statusCode = 200, jsonBody;
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  return { req, res, getResult: () => ({ status: statusCode, body: jsonBody }) };
}

(async () => {
  const DelegationTask = require(path.join(__dirname, '../../models/DelegationTask'));
  const Employee = require(path.join(__dirname, '../../models/Employee'));
  const Tenant = require(path.join(__dirname, '../../models/Tenant'));
  const mongoose = require('mongoose');

  const fakeEmployee = { _id: 'x', totalPoints: 0, earnedBadges: [], save: async function () { return this; } };
  const fakeTenant = { pointSettings: { isActive: false } }; // skip the points/badge engine entirely for this test

  Employee.findById = async () => fakeEmployee;
  Employee.findByIdAndUpdate = async () => fakeEmployee;
  Tenant.findById = async () => fakeTenant;
  const realMongooseModel = mongoose.model.bind(mongoose);
  mongoose.model = (name, ...rest) => (name === 'Tenant' && rest.length === 0 ? Tenant : realMongooseModel(name, ...rest));

  const taskController = require(path.join(__dirname, '../../controllers/taskController'));

  function pngFile(name) {
    return { originalname: name, path: `/uploads/${name}`, location: undefined };
  }

  // --- TEST 1: the doer completes the task with 2 evidence files + remarks ---
  {
    const task = makeTask();
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      status: 'Completed', remarks: 'Finished both parts, see photos.', doerId: 'doer1',
      files: [pngFile('a.png'), pngFile('b.png')],
      user: { id: 'doer1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.respondToTask(req, res);
    const { status } = getResult();
    check('T1: doer (legit) completing with 2 files is allowed (not blocked by the new permission check)', status === 200 || status === undefined, { status, task });
    check('T1: BOTH evidence files were pushed onto task.files', task.files.length === 2, task.files);
    check('T1: remarks persisted for a Completed status change', task.remarks === 'Finished both parts, see photos.', task.remarks);
    check('T1: history entry recorded for the doer', task.history.some(h => h.action === 'Completed' && h.performedBy === 'doer1'), task.history);
  }

  // --- TEST 2: the assigner rejects/sends back (status 'Accepted') with remarks + 1 photo ---
  {
    const task = makeTask();
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      status: 'Accepted', remarks: 'Please redo step 2, the numbers are wrong.', doerId: 'assigner1',
      files: [pngFile('reject-note.png')],
      user: { id: 'assigner1', tenantId: 'tenantA', roles: ['Assigner'] },
    });
    await taskController.respondToTask(req, res);
    const { status } = getResult();
    check('T2: assigner (legit) rejecting with remarks+photo is allowed', status === 200 || status === undefined, { status, task });
    check('T2: rejection remarks are now persisted (previously silently dropped for this status)', task.remarks === 'Please redo step 2, the numbers are wrong.', task.remarks);
    check('T2: the reject photo was appended to task.files', task.files.length === 1, task.files);
  }

  // --- TEST 3: a user from a DIFFERENT TENANT is blocked outright ---
  {
    const task = makeTask();
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      status: 'Completed', remarks: 'trying to sneak in', doerId: 'attacker1',
      files: [],
      user: { id: 'attacker1', tenantId: 'tenantB_DIFFERENT', roles: ['Doer'] },
    });
    await taskController.respondToTask(req, res);
    const { status, body } = getResult();
    check('T3: a caller from a different tenant is blocked (404, not found) rather than allowed through', status === 404, { status, body });
    check('T3: the cross-tenant attempt did not modify the task at all', task.status === 'Accepted' && task.files.length === 0, task);
  }

  // --- TEST 4: a user in the SAME tenant but unrelated to the task (not doer/assigner/coordinator/helper/forward-chain) is blocked ---
  {
    const task = makeTask();
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      status: 'Completed', remarks: 'not my task', doerId: 'random-colleague',
      files: [],
      user: { id: 'random-colleague', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.respondToTask(req, res);
    const { status, body } = getResult();
    check('T4: an unrelated same-tenant employee is blocked (403)', status === 403, { status, body });
  }

  // --- TEST 5: the doer's BUDDY COVER (leaveStatus.buddyId) can complete the task ---
  // Same lookup getDoerTasks uses to show a buddy their colleague's tasks
  // while the colleague is on leave - they must also be able to act on them.
  {
    const task = makeTask({ doerId: { _id: 'doer1', leaveStatus: { onLeave: true, buddyId: 'buddy1' } } });
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      status: 'Completed', remarks: 'Covering for doer1 while they are on leave.', doerId: 'buddy1',
      files: [pngFile('cover.png')],
      user: { id: 'buddy1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.respondToTask(req, res);
    const { status } = getResult();
    check('T5: the doer\'s buddy cover (leaveStatus.buddyId) is allowed to complete the task', status === 200 || status === undefined, { status, task });
    check('T5: the buddy\'s file + remarks were recorded', task.files.length === 1 && task.remarks === 'Covering for doer1 while they are on leave.', task);
  }

  // --- TEST 6: someone who is NOT the buddy (same tenant) is still blocked ---
  {
    const task = makeTask({ doerId: { _id: 'doer1', leaveStatus: { onLeave: true, buddyId: 'buddy1' } } });
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      status: 'Completed', remarks: 'not actually the buddy', doerId: 'imposter1',
      files: [],
      user: { id: 'imposter1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.respondToTask(req, res);
    const { status, body } = getResult();
    check('T6: a non-buddy same-tenant employee is still blocked (403)', status === 403, { status, body });
  }

  // --- TEST 7: the buddy relationship does NOT cross tenants ---
  // Same buddyId value, but the caller's tenant differs from the task's -
  // must still be blocked by the tenant check before the buddy check ever runs.
  {
    const task = makeTask({ doerId: { _id: 'doer1', leaveStatus: { onLeave: true, buddyId: 'buddy1' } } });
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      status: 'Completed', remarks: 'cross-tenant buddy id reuse', doerId: 'buddy1',
      files: [],
      user: { id: 'buddy1', tenantId: 'tenantB_DIFFERENT', roles: ['Doer'] },
    });
    await taskController.respondToTask(req, res);
    const { status, body } = getResult();
    check('T7: a cross-tenant caller with a matching buddyId is still blocked (404)', status === 404, { status, body });
  }

  // --- TEST 8: a task.coworkers member is NOT allowed to respond ---
  // Confirmed finding: getDoerTasks never queries by coworkers, and neither
  // TaskCard.jsx nor DoerChecklist.jsx read task.coworkers anywhere, so the
  // frontend does not give a coworker any "Complete"/"Respond" action on a
  // task today. This permission check intentionally stays just as strict
  // for them as for any other unrelated same-tenant employee.
  {
    const task = makeTask({ coworkers: [{ _id: 'coworker1' }] });
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      status: 'Completed', remarks: 'coworker trying to respond', doerId: 'coworker1',
      files: [],
      user: { id: 'coworker1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.respondToTask(req, res);
    const { status, body } = getResult();
    check('T8: a task.coworkers member is blocked (403) - matches the frontend, which never lets them respond', status === 403, { status, body });
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) {
    console.log('FAILURES:', JSON.stringify(failed, null, 2));
    process.exitCode = 1;
  }
})().catch(e => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
