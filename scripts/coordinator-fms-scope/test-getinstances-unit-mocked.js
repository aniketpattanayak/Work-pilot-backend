// Unit-level test of the REAL exports.getInstances code (controllers/
// newFmsController.js), with the Mongoose models monkey-patched instead of
// hitting a database.
//
// Why this exists: this sandbox cannot run a real MongoDB (mongodb-memory-
// server's binary download, and MongoDB's own apt repo, are both blocked by
// this environment's network allowlist). This is NOT a substitute for a
// real-database regression pass - it instead calls the real, merged
// getInstances with fake Employee/FlowInstance models so the core scoping
// logic (the fix for this task) gets automated coverage here and now.
//
// Scenario modeled (matches the manual test plan in the PR report): a test
// company with three employees - Coordinator (mapped to Doer A only, via
// managedDoers), Doer A, Doer B (not mapped to the coordinator at all) - and
// two FlowInstances, one assigned to A and one assigned to B. A non-Admin,
// non-viewer coordinator calling GET /fms2/instances/:tenantId must see only
// the instance involving A; an Admin or viewer-only caller must see both.

const path = require('path');
const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 400));
}

const TENANT = 'tenantA';
const COORDINATOR_ID = 'coord1';
const DOER_A = 'doerA';
const DOER_B = 'doerB';

const instanceForA = {
  _id: 'inst-A',
  tenantId: TENANT,
  status: 'active',
  orderIdentifier: 'ORD-A',
  activeStep: { assignedToId: DOER_A, plannedDeadline: new Date(Date.now() + 86400000) },
  nodeHistory: [],
};

const instanceForB = {
  _id: 'inst-B',
  tenantId: TENANT,
  status: 'active',
  orderIdentifier: 'ORD-B',
  activeStep: { assignedToId: DOER_B, plannedDeadline: new Date(Date.now() + 86400000) },
  nodeHistory: [],
};

const ALL_INSTANCES = [instanceForA, instanceForB];

// --- mock a chainable, awaitable Mongoose query ---
function mockQuery(resultList) {
  const q = {
    sort: () => q,
    skip: () => q,
    limit: () => q,
    lean: () => Promise.resolve(resultList),
    then: (resolve, reject) => Promise.resolve(resultList).then(resolve, reject),
    catch: (reject) => Promise.resolve(resultList).catch(reject),
  };
  return q;
}

function applyFilter(filter, instances) {
  return instances.filter((inst) => {
    if (filter.tenantId && inst.tenantId !== filter.tenantId) return false;
    if (filter.status && filter.status !== 'all' && inst.status !== filter.status) return false;
    if (filter.$or) {
      return filter.$or.some((clause) => {
        return Object.entries(clause).some(([path, cond]) => {
          const val = path.split('.').reduce((o, k) => (o ? o[k] : undefined), inst);
          if (cond && cond.$in) return cond.$in.map(String).includes(String(val));
          return val === cond;
        });
      });
    }
    return true;
  });
}

async function run() {
  const FlowInstance = require('../../models/FlowInstance');
  const Employee = require('../../models/Employee');

  const employees = {
    [COORDINATOR_ID]: { _id: COORDINATOR_ID, tenantId: TENANT, roles: ['Coordinator'], managedDoers: [DOER_A], managedAssigners: [] },
  };

  const origFind = FlowInstance.find;
  const origCount = FlowInstance.countDocuments;
  const origEmpFindById = Employee.findById;

  FlowInstance.find = (filter) => mockQuery(applyFilter(filter, ALL_INSTANCES));
  FlowInstance.countDocuments = async (filter) => applyFilter(filter, ALL_INSTANCES).length;
  Employee.findById = (id) => ({ lean: async () => employees[id] || null });

  try {
    const controller = require('../../controllers/newFmsController');

    // --- Case 1: restricted coordinator mapped to Doer A only ---
    {
      let jsonBody;
      const req = {
        db: null,
        params: { tenantId: TENANT },
        query: {},
        user: { id: COORDINATOR_ID, tenantId: TENANT, roles: ['Coordinator'] },
      };
      const res = { json: (b) => { jsonBody = b; }, status: () => res };
      await controller.getInstances(req, res);
      const ids = (jsonBody.instances || []).map((i) => i._id);
      check(
        'Coordinator mapped to A only sees only instance A',
        ids.length === 1 && ids[0] === 'inst-A',
        ids
      );
    }

    // --- Case 2: Admin sees everything ---
    {
      let jsonBody;
      const req = {
        db: null,
        params: { tenantId: TENANT },
        query: {},
        user: { id: COORDINATOR_ID, tenantId: TENANT, roles: ['Admin'] },
      };
      const res = { json: (b) => { jsonBody = b; }, status: () => res };
      await controller.getInstances(req, res);
      const ids = (jsonBody.instances || []).map((i) => i._id).sort();
      check(
        'Admin caller sees both instances (unrestricted, unchanged)',
        ids.length === 2 && ids[0] === 'inst-A' && ids[1] === 'inst-B',
        ids
      );
    }

    // --- Case 3: viewer-only sees everything ---
    {
      let jsonBody;
      const req = {
        db: null,
        params: { tenantId: TENANT },
        query: {},
        user: { id: COORDINATOR_ID, tenantId: TENANT, roles: ['Viewer'] },
      };
      const res = { json: (b) => { jsonBody = b; }, status: () => res };
      await controller.getInstances(req, res);
      const ids = (jsonBody.instances || []).map((i) => i._id).sort();
      check(
        'Viewer-only caller sees both instances (unrestricted, unchanged)',
        ids.length === 2,
        ids
      );
    }

    // --- Case 4: empty mapping -> empty list, not an error ---
    {
      employees['coordEmpty'] = { _id: 'coordEmpty', tenantId: TENANT, roles: ['Coordinator'], managedDoers: [], managedAssigners: [] };
      let jsonBody;
      const req = {
        db: null,
        params: { tenantId: TENANT },
        query: {},
        user: { id: 'coordEmpty', tenantId: TENANT, roles: ['Coordinator'] },
      };
      const res = { json: (b) => { jsonBody = b; }, status: () => res };
      await controller.getInstances(req, res);
      check(
        'Coordinator with empty mapping gets empty list (mirrors delegation behaviour)',
        Array.isArray(jsonBody.instances) && jsonBody.instances.length === 0 && jsonBody.pagination.total === 0,
        jsonBody
      );
    }
  } finally {
    FlowInstance.find = origFind;
    FlowInstance.countDocuments = origCount;
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
