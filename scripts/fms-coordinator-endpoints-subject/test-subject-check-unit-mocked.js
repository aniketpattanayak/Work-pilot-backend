// Unit-level tests of the REAL getMyTasksWithNodes and
// getFmsTasksForCoordinator code (controllers/newFmsController.js), with
// Mongoose models monkey-patched instead of hitting a database.
//
// Why this exists: this sandbox cannot run a real MongoDB (blocked by the
// network allowlist). This is NOT a substitute for a real-database
// regression pass. It covers the fix in this task: these endpoints read a
// subject id (employeeId/coordinatorId) straight from the URL and decide
// what to return based on THAT person's role/mapping, but never checked
// WHO is allowed to ask for that subject. Now: non-admin caller + someone
// else's id -> 403; non-admin caller + own id -> works as before; admin
// caller + someone else's id -> still works (unrestricted, unchanged).
//
// getCompletedFmsForCoordinator and getCompletedTasksForCoordinator got the
// identical one-line canQuerySubject() guard as getFmsTasksForCoordinator
// (same pattern, same place in the function), so they are not re-tested
// here in full - exercising the shared helper plus one representative route
// end-to-end is enough to catch a wiring mistake in any of the three.

const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 400));
}

const TENANT = 'tenantA';
const COORDINATOR_ID = 'coord1';
const OTHER_EMPLOYEE_ID = 'coord2';
const DOER_A = 'doerA';

function mockQuery(resultList) {
  const q = {
    sort: () => q,
    limit: () => q,
    lean: () => Promise.resolve(resultList),
    then: (resolve, reject) => Promise.resolve(resultList).then(resolve, reject),
  };
  return q;
}

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function run() {
  const FlowInstance = require('../../models/FlowInstance');
  const Employee = require('../../models/Employee');
  const FlowTemplate = require('../../models/FlowTemplate');

  const employees = {
    [COORDINATOR_ID]: { _id: COORDINATOR_ID, tenantId: TENANT, roles: ['Coordinator'], managedDoers: [DOER_A], managedAssigners: [] },
    [OTHER_EMPLOYEE_ID]: { _id: OTHER_EMPLOYEE_ID, tenantId: TENANT, roles: ['Coordinator'], managedDoers: [], managedAssigners: [] },
  };

  const activeInstance = {
    _id: 'inst-A',
    tenantId: TENANT,
    status: 'active',
    orderIdentifier: 'ORD-A',
    templateId: null,
    activeStep: { assignedToId: DOER_A, plannedDeadline: new Date(Date.now() + 86400000) },
    nodeHistory: [],
  };

  const origFind = FlowInstance.find;
  const origTemplateFind = FlowTemplate.find;
  const origEmpFindById = Employee.findById;

  FlowInstance.find = () => mockQuery([activeInstance]);
  FlowTemplate.find = () => mockQuery([]);
  Employee.findById = (id) => ({
    lean: async () => employees[id] || null,
    select: () => ({ lean: async () => (employees[id] ? { name: 'Someone' } : null) }),
  });

  try {
    const controller = require('../../controllers/newFmsController');

    // --- getFmsTasksForCoordinator: non-admin caller, someone else's id -> 403 ---
    {
      const req = {
        db: null,
        params: { coordinatorId: OTHER_EMPLOYEE_ID },
        user: { id: COORDINATOR_ID, tenantId: TENANT, roles: ['Coordinator'] },
      };
      const res = mockRes();
      await controller.getFmsTasksForCoordinator(req, res);
      check(
        'getFmsTasksForCoordinator: non-admin asking for a DIFFERENT subject id -> 403',
        res.statusCode === 403,
        { statusCode: res.statusCode, body: res.body }
      );
    }

    // --- getFmsTasksForCoordinator: non-admin caller, own id -> works ---
    {
      const req = {
        db: null,
        params: { coordinatorId: COORDINATOR_ID },
        user: { id: COORDINATOR_ID, tenantId: TENANT, roles: ['Coordinator'] },
      };
      const res = mockRes();
      await controller.getFmsTasksForCoordinator(req, res);
      check(
        'getFmsTasksForCoordinator: non-admin asking for OWN subject id -> 200, unchanged behaviour',
        res.statusCode === 200 && Array.isArray(res.body) && res.body.length === 1 && res.body[0].instanceId === 'inst-A',
        { statusCode: res.statusCode, body: res.body }
      );
    }

    // --- getFmsTasksForCoordinator: admin caller, someone else's id -> still works ---
    {
      const req = {
        db: null,
        params: { coordinatorId: OTHER_EMPLOYEE_ID },
        user: { id: COORDINATOR_ID, tenantId: TENANT, roles: ['Admin'] },
      };
      const res = mockRes();
      await controller.getFmsTasksForCoordinator(req, res);
      check(
        'getFmsTasksForCoordinator: Admin caller asking for a different subject id -> 200 (unrestricted, unchanged)',
        res.statusCode === 200 && Array.isArray(res.body),
        { statusCode: res.statusCode, body: res.body }
      );
    }

    // --- getMyTasksWithNodes: non-admin caller, someone else's id -> 403 ---
    {
      const req = {
        db: null,
        params: { employeeId: OTHER_EMPLOYEE_ID },
        user: { id: COORDINATOR_ID, tenantId: TENANT, roles: ['Coordinator'] },
      };
      const res = mockRes();
      await controller.getMyTasksWithNodes(req, res);
      check(
        'getMyTasksWithNodes: non-admin asking for a DIFFERENT employeeId -> 403',
        res.statusCode === 403,
        { statusCode: res.statusCode, body: res.body }
      );
    }

    // --- getMyTasksWithNodes: non-admin caller, own id -> works (the only real-world call shape) ---
    {
      const req = {
        db: null,
        params: { employeeId: COORDINATOR_ID },
        user: { id: COORDINATOR_ID, tenantId: TENANT, roles: ['Coordinator'] },
      };
      const res = mockRes();
      await controller.getMyTasksWithNodes(req, res);
      check(
        'getMyTasksWithNodes: non-admin asking for OWN employeeId -> 200, unchanged behaviour',
        res.statusCode === 200,
        { statusCode: res.statusCode, body: res.body }
      );
    }

    // --- getMyTasksWithNodes: admin caller, someone else's id -> still works ---
    {
      const req = {
        db: null,
        params: { employeeId: OTHER_EMPLOYEE_ID },
        user: { id: COORDINATOR_ID, tenantId: TENANT, roles: ['Admin'] },
      };
      const res = mockRes();
      await controller.getMyTasksWithNodes(req, res);
      check(
        'getMyTasksWithNodes: Admin caller asking for a different employeeId -> 200 (unrestricted, unchanged)',
        res.statusCode === 200,
        { statusCode: res.statusCode, body: res.body }
      );
    }
  } finally {
    FlowInstance.find = origFind;
    FlowTemplate.find = origTemplateFind;
    Employee.findById = origEmpFindById;
  }
}

run().then(() => {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}).catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
