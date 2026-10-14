// Unit-level tests for the "task followers" feature (feature/task-followers), with
// Mongoose models monkey-patched instead of hitting a database.
//
// Why this exists: as with every earlier branch in this project, this sandbox cannot
// run a real MongoDB (mongodb-memory-server's binary download and MongoDB's own apt
// repo are both blocked by this environment's network allowlist). These tests call the
// REAL controller exports directly with fake DelegationTask/Employee models, so the
// core logic gets automated coverage now. A full regression pass against a real
// database is still needed before this ships to production - same caveat as the prior
// rounds in scripts/task-media-history-ux and scripts/fix-respond-tenant-isolation.

const path = require('path');
const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 400));
}

function mockQuery(value) {
  const q = {
    populate: () => q,
    select: () => q,
    sort: () => q,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: (reject) => Promise.resolve(value).catch(reject),
  };
  return q;
}

function makeTask(overrides = {}) {
  return {
    _id: 'task1',
    tenantId: 'tenantA',
    title: 'Followed task',
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

function makeReqRes({ params = {}, body = {}, user, files = [] } = {}) {
  const req = { db: null, params, body, user, files };
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

  const realMongooseModel = mongoose.model.bind(mongoose);
  mongoose.model = (name, ...rest) => (name === 'Tenant' && rest.length === 0 ? Tenant : realMongooseModel(name, ...rest));
  mongoose.Types.ObjectId.isValid = () => true; // these tests use string ids like 'task1', not real ObjectIds

  const taskController = require(path.join(__dirname, '../../controllers/taskController'));
  const { validateFollowers, MAX_FOLLOWERS } = require(path.join(__dirname, '../../utils/followerValidation'));

  // ───────────────────────────── validateFollowers ─────────────────────────────

  // T1: tenant mismatch is rejected
  {
    Employee.find = () => mockQuery([{ _id: 'emp1' }]); // emp1 is in tenantA; emp2 (other tenant) is not returned
    const { followers, errors } = await validateFollowers({
      rawFollowers: ['emp1', 'emp2-other-tenant'],
      doerId: 'doer1', assignerId: 'assigner1', tenantId: 'tenantA', Employee,
    });
    check('T1: cross-tenant follower id is dropped, same-tenant one kept', followers.length === 1 && followers[0] === 'emp1', { followers, errors });
    check('T1: an error is recorded for the dropped id', errors.some(e => e.includes('emp2-other-tenant')), errors);
  }

  // T2: doer cannot be added as a follower
  {
    Employee.find = () => mockQuery([{ _id: 'doer1' }, { _id: 'emp1' }]);
    const { followers, errors } = await validateFollowers({
      rawFollowers: ['doer1', 'emp1'], doerId: 'doer1', assignerId: 'assigner1', tenantId: 'tenantA', Employee,
    });
    check('T2: the doer is excluded from followers', !followers.includes('doer1') && followers.includes('emp1'), { followers, errors });
  }

  // T3: assigner cannot be added as a follower
  {
    Employee.find = () => mockQuery([{ _id: 'assigner1' }, { _id: 'emp1' }]);
    const { followers } = await validateFollowers({
      rawFollowers: ['assigner1', 'emp1'], doerId: 'doer1', assignerId: 'assigner1', tenantId: 'tenantA', Employee,
    });
    check('T3: the assigner is excluded from followers', !followers.includes('assigner1') && followers.includes('emp1'), followers);
  }

  // T4: duplicates collapsed
  {
    Employee.find = () => mockQuery([{ _id: 'emp1' }]);
    const { followers } = await validateFollowers({
      rawFollowers: ['emp1', 'emp1', 'emp1'], doerId: 'doer1', assignerId: 'assigner1', tenantId: 'tenantA', Employee,
    });
    check('T4: duplicate ids collapse to one', followers.length === 1, followers);
  }

  // T5: max count enforced
  {
    const many = Array.from({ length: 25 }, (_, i) => `emp${i}`);
    Employee.find = () => mockQuery(many.map(id => ({ _id: id })));
    const { followers, errors } = await validateFollowers({
      rawFollowers: many, doerId: 'doer1', assignerId: 'assigner1', tenantId: 'tenantA', Employee,
    });
    check(`T5: follower list capped at ${MAX_FOLLOWERS}`, followers.length === MAX_FOLLOWERS, followers.length);
    check('T5: a cap-exceeded error is recorded', errors.some(e => e.toLowerCase().includes('at most')), errors);
  }

  // ───────────────────────────── GET /tasks/following/:employeeId ─────────────────────────────

  // T6: an employee fetching their OWN following list works
  {
    Employee.findById = () => mockQuery({ _id: 'c1', tenantId: 'tenantA' });
    DelegationTask.find = () => mockQuery([makeTask({ coworkers: [{ _id: 'c1', name: 'Carol' }] })]);
    const { req, res, getResult } = makeReqRes({
      params: { employeeId: 'c1' }, user: { id: 'c1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.getFollowingTasks(req, res);
    const { status, body } = getResult();
    check('T6: own-id request succeeds (200)', status === 200, { status, body });
    check('T6: response includes the follower list and no action-implying status change', Array.isArray(body) && body[0].isFollowing === true, body);
  }

  // T7: an Admin fetching SOMEONE ELSE'S following list works
  {
    Employee.findById = () => mockQuery({ _id: 'c1', tenantId: 'tenantA' });
    DelegationTask.find = () => mockQuery([makeTask({ coworkers: [{ _id: 'c1', name: 'Carol' }] })]);
    const { req, res, getResult } = makeReqRes({
      params: { employeeId: 'c1' }, user: { id: 'admin1', tenantId: 'tenantA', roles: ['Admin'] },
    });
    await taskController.getFollowingTasks(req, res);
    const { status } = getResult();
    check('T7: Admin-for-someone-else succeeds (200)', status === 200, status);
  }

  // T8: a non-admin fetching SOMEONE ELSE'S following list is blocked
  {
    const { req, res, getResult } = makeReqRes({
      params: { employeeId: 'c1' }, user: { id: 'bob1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.getFollowingTasks(req, res);
    const { status } = getResult();
    check('T8: non-admin requesting someone else\'s following list is 403', status === 403, status);
  }

  // T9: tenant mismatch is blocked even for a self-request (shouldn't happen via JWT, but defence in depth)
  {
    Employee.findById = () => mockQuery({ _id: 'c1', tenantId: 'tenantB_DIFFERENT' });
    const { req, res, getResult } = makeReqRes({
      params: { employeeId: 'c1' }, user: { id: 'c1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.getFollowingTasks(req, res);
    const { status } = getResult();
    check('T9: tenant mismatch between caller token and employee record is 403', status === 403, status);
  }

  // ───────────────────────────── 403s: follower acting on a task ─────────────────────────────

  // T10: respondToTask already blocks a follower (regression - documented in the controller's own comment)
  {
    const task = makeTask({ coworkers: [{ _id: 'c1' }] });
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      body: { taskId: 'task1', status: 'Completed', remarks: 'follower trying to respond', doerId: 'c1' },
      user: { id: 'c1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.respondToTask(req, res);
    const { status } = getResult();
    check('T10: respondToTask - follower is 403', status === 403, status);
  }

  // T11: handleRevision blocks a follower from 'Request'ing/approving a revision
  {
    DelegationTask.findById = () => mockQuery(makeTask({ coworkers: [{ _id: 'c1' }] }));
    const { req, res, getResult } = makeReqRes({
      body: { taskId: 'task1', action: 'Request', newDeadline: new Date(), remarks: 'nope' },
      user: { id: 'c1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.handleRevision(req, res);
    const { status } = getResult();
    check('T11: handleRevision - follower is 403', status === 403, status);
  }

  // T12: assignOnward blocks a follower (they are not task.doerId)
  {
    const task = makeTask({ coworkers: [{ _id: 'c1' }], doerId: 'doer1' });
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      body: { taskId: 'task1', newDoerId: 'someone-else' },
      user: { id: 'c1', tenantId: 'tenantA', roles: ['Assigner'] },
    });
    await taskController.assignOnward(req, res);
    const { status } = getResult();
    check('T12: assignOnward - follower is 403', status === 403, status);
  }

  // T13: updateTask blocks a follower who is not assigner/admin
  {
    const task = makeTask({ coworkers: [{ _id: 'c1' }], assignerId: 'assigner1' });
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      params: { taskId: 'task1' },
      body: { title: 'hacked title' },
      user: { id: 'c1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.updateTask(req, res);
    const { status } = getResult();
    check('T13: updateTask - follower is 403', status === 403, status);
  }

  // T14: deleteTask blocks a follower who is not assigner/admin
  {
    const task = makeTask({ coworkers: [{ _id: 'c1' }], assignerId: 'assigner1' });
    DelegationTask.findById = () => mockQuery(task);
    DelegationTask.findByIdAndDelete = async () => task;
    const { req, res, getResult } = makeReqRes({
      params: { taskId: 'task1' },
      user: { id: 'c1', tenantId: 'tenantA', roles: ['Doer'] },
    });
    await taskController.deleteTask(req, res);
    const { status } = getResult();
    check('T14: deleteTask - follower is 403', status === 403, status);
  }

  // T15: getTaskById returns the followers list to everyone who can already see the task
  {
    const task = makeTask({ coworkers: [{ _id: 'c1', name: 'Carol' }], assignerId: { _id: 'assigner1', name: 'Alice' }, doerId: { _id: 'doer1', name: 'Bob' } });
    DelegationTask.findById = () => mockQuery(task);
    const { req, res, getResult } = makeReqRes({
      params: { taskId: 'task1' },
      user: { id: 'assigner1', tenantId: 'tenantA', roles: ['Assigner'] },
    });
    await taskController.getTaskById(req, res);
    const { status, body } = getResult();
    check('T15: getTaskById includes a followers array with the follower\'s name', status === 200 && Array.isArray(body.followers) && body.followers[0].name === 'Carol', body);
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
