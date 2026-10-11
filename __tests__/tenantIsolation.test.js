// Regression tests for the tenant-isolation / IDOR fixes made in
// commit "Fix tenant-isolation and IDOR security bugs in FMS controllers"
// (branch fix/tenant-isolation-security). These hit a real in-memory MongoDB
// through the actual Express routes + middleware, not mocks, so a
// regression that reopens the leak will make these fail for real.
const request = require('supertest');
const mongoose = require('mongoose');
const { buildApp, tokenFor } = require('./testApp');

const FmsTemplate = require('../models/FmsTemplate');
const FmsInstance = require('../models/FmsInstance');
const FlowTemplate = require('../models/FlowTemplate');
const FlowInstance = require('../models/FlowInstance');

const app = buildApp();

const tenantA = new mongoose.Types.ObjectId();
const tenantB = new mongoose.Types.ObjectId();

const userA = { id: new mongoose.Types.ObjectId().toString(), tenantId: tenantA.toString(), roles: ['Admin'] };
const userB = { id: new mongoose.Types.ObjectId().toString(), tenantId: tenantB.toString(), roles: ['Admin'] };

function makeFmsTemplate(tenantId, overrides = {}) {
  return FmsTemplate.create({
    tenantId,
    flowName: 'Order Fulfilment',
    googleSheetId: 'sheet-123',
    scriptUrl: 'https://script.example/exec',
    tabName: 'Sheet1',
    nodes: [
      { nodeName: 'Confirm', stepIndex: 0, emailColumn: 'confirm@example.com' },
      { nodeName: 'Pack', stepIndex: 1, emailColumn: 'pack@example.com' },
    ],
    ...overrides,
  });
}

function makeFmsInstance(tenantId, templateId, overrides = {}) {
  return FmsInstance.create({
    tenantId,
    templateId,
    orderIdentifier: overrides.orderIdentifier || `ORD-${Math.random().toString(36).slice(2, 8)}`,
    currentStepIndex: 0,
    steps: [
      { nodeName: 'Confirm', stepIndex: 0, assignedTo: 'confirm@example.com', status: 'Pending' },
      { nodeName: 'Pack', stepIndex: 1, assignedTo: 'pack@example.com', status: 'Pending' },
    ],
    ...overrides,
  });
}

function makeFlowTemplate(tenantId, overrides = {}) {
  return FlowTemplate.create({
    tenantId,
    name: 'O2D Flow',
    startNodeId: 'n1',
    nodes: [
      { id: 'n1', name: 'Start', type: 'start', nextNodeId: 'n2' },
      { id: 'n2', name: 'RM Check', type: 'action', assignedTo: { type: 'employee', value: 'emp1' } },
    ],
    ...overrides,
  });
}

function makeFlowInstance(tenantId, templateId, overrides = {}) {
  return FlowInstance.create({
    tenantId,
    templateId,
    templateName: 'O2D Flow',
    orderIdentifier: overrides.orderIdentifier || `FLW-${Math.random().toString(36).slice(2, 8)}`,
    status: 'active',
    activeStep: { nodeId: 'n2', nodeName: 'RM Check', assignedToId: 'emp1' },
    ...overrides,
  });
}

describe('fmsController.getMyMissions — tenant isolation', () => {
  test('a user from tenant A only ever gets tenant A missions back, never tenant B', async () => {
    const templateA = await makeFmsTemplate(tenantA);
    const templateB = await makeFmsTemplate(tenantB);

    // Both tenants happen to use the SAME assignee email for step 0 — this is
    // exactly the scenario the original unfiltered FmsInstance.find() would leak.
    await makeFmsInstance(tenantA, templateA._id, { orderIdentifier: 'A-ORDER-1' });
    await makeFmsInstance(tenantB, templateB._id, { orderIdentifier: 'B-ORDER-1' });

    const res = await request(app)
      .get('/api/fms/my-missions/confirm@example.com')
      .set('Authorization', `Bearer ${tokenFor(userA)}`);

    expect(res.status).toBe(200);
    const orderIds = res.body.map((m) => m.orderIdentifier);
    expect(orderIds).toContain('A-ORDER-1');
    expect(orderIds).not.toContain('B-ORDER-1');
  });

  test('tenant B user never sees tenant A missions, even with the same assignee email', async () => {
    const templateA = await makeFmsTemplate(tenantA);
    const templateB = await makeFmsTemplate(tenantB);

    await makeFmsInstance(tenantA, templateA._id, { orderIdentifier: 'A-ORDER-2' });
    await makeFmsInstance(tenantB, templateB._id, { orderIdentifier: 'B-ORDER-2' });

    const res = await request(app)
      .get('/api/fms/my-missions/confirm@example.com')
      .set('Authorization', `Bearer ${tokenFor(userB)}`);

    expect(res.status).toBe(200);
    const orderIds = res.body.map((m) => m.orderIdentifier);
    expect(orderIds).toContain('B-ORDER-2');
    expect(orderIds).not.toContain('A-ORDER-2');
  });

  test('with no tenant filter the leak would reproduce (sanity check against the raw model)', async () => {
    // This test documents the pre-fix bug directly against the model: an
    // unfiltered find() returns both tenants' instances. It exists so the
    // regression above is clearly tied to a real, reproducible leak.
    const templateA = await makeFmsTemplate(tenantA);
    const templateB = await makeFmsTemplate(tenantB);
    await makeFmsInstance(tenantA, templateA._id, { orderIdentifier: 'LEAK-A' });
    await makeFmsInstance(tenantB, templateB._id, { orderIdentifier: 'LEAK-B' });

    const allInstances = await FmsInstance.find();
    const ids = allInstances.map((i) => i.orderIdentifier);
    expect(ids).toEqual(expect.arrayContaining(['LEAK-A', 'LEAK-B']));
  });
});

describe('newFmsController.getTemplateById — IDOR fix', () => {
  test('tenant B cannot fetch tenant A\'s template by ID (403, not the data)', async () => {
    const templateA = await makeFlowTemplate(tenantA, { name: 'Tenant A Secret Flow' });

    const res = await request(app)
      .get(`/api/fms2/templates/detail/${templateA._id}`)
      .set('Authorization', `Bearer ${tokenFor(userB)}`);

    expect([403, 404]).toContain(res.status);
    expect(res.body.name).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Tenant A Secret Flow');
  });

  test('tenant A can fetch its own template by ID', async () => {
    const templateA = await makeFlowTemplate(tenantA, { name: 'Tenant A Own Flow' });

    const res = await request(app)
      .get(`/api/fms2/templates/detail/${templateA._id}`)
      .set('Authorization', `Bearer ${tokenFor(userA)}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Tenant A Own Flow');
  });

  test('a superAdmin may still fetch any tenant\'s template', async () => {
    const templateA = await makeFlowTemplate(tenantA, { name: 'Tenant A Flow For SA' });
    const superAdmin = { id: new mongoose.Types.ObjectId().toString(), isSuperAdmin: true };

    const res = await request(app)
      .get(`/api/fms2/templates/detail/${templateA._id}`)
      .set('Authorization', `Bearer ${tokenFor(superAdmin)}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Tenant A Flow For SA');
  });
});

describe('newFmsController.getInstanceDetail — IDOR fix', () => {
  test('tenant B cannot fetch tenant A\'s instance detail (403, not the data)', async () => {
    const templateA = await makeFlowTemplate(tenantA);
    const instanceA = await makeFlowInstance(tenantA, templateA._id, { orderIdentifier: 'SECRET-ORDER-A' });

    const res = await request(app)
      .get(`/api/fms2/instance/${instanceA._id}`)
      .set('Authorization', `Bearer ${tokenFor(userB)}`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-ORDER-A');
  });

  test('tenant A can fetch its own instance detail', async () => {
    const templateA = await makeFlowTemplate(tenantA);
    const instanceA = await makeFlowInstance(tenantA, templateA._id, { orderIdentifier: 'OWN-ORDER-A' });

    const res = await request(app)
      .get(`/api/fms2/instance/${instanceA._id}`)
      .set('Authorization', `Bearer ${tokenFor(userA)}`);

    expect(res.status).toBe(200);
    expect(res.body.instance.orderIdentifier).toBe('OWN-ORDER-A');
  });
});

describe('newFmsController.cancelInstance — IDOR fix', () => {
  test('tenant B cannot cancel tenant A\'s instance', async () => {
    const templateA = await makeFlowTemplate(tenantA);
    const instanceA = await makeFlowInstance(tenantA, templateA._id, { orderIdentifier: 'DO-NOT-CANCEL' });

    const res = await request(app)
      .delete(`/api/fms2/instance/${instanceA._id}`)
      .set('Authorization', `Bearer ${tokenFor(userB)}`);

    expect(res.status).toBe(403);

    const stillActive = await FlowInstance.findById(instanceA._id);
    expect(stillActive.status).toBe('active');
  });

  test('tenant A can cancel its own instance', async () => {
    const templateA = await makeFlowTemplate(tenantA);
    const instanceA = await makeFlowInstance(tenantA, templateA._id, { orderIdentifier: 'CANCEL-ME' });

    const res = await request(app)
      .delete(`/api/fms2/instance/${instanceA._id}`)
      .set('Authorization', `Bearer ${tokenFor(userA)}`);

    expect(res.status).toBe(200);
    const cancelled = await FlowInstance.findById(instanceA._id);
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('fmsController (old FMS) executeStep — tenant ownership check', () => {
  test('tenant B cannot execute a step on tenant A\'s instance (403, no mutation)', async () => {
    const templateA = await makeFmsTemplate(tenantA);
    const instanceA = await makeFmsInstance(tenantA, templateA._id, { orderIdentifier: 'OLD-FMS-A' });

    const res = await request(app)
      .put(`/api/fms/execute-step/${instanceA._id}`)
      .set('Authorization', `Bearer ${tokenFor(userB)}`)
      .send({ remarks: 'trying to interfere' });

    expect(res.status).toBe(403);

    const unchanged = await FmsInstance.findById(instanceA._id);
    expect(unchanged.steps[0].status).toBe('Pending');
  });
});

describe('fmsController.deleteFmsTemplate — tenant scoping fix', () => {
  test('tenant B cannot delete tenant A\'s template', async () => {
    const templateA = await makeFmsTemplate(tenantA);

    const res = await request(app)
      .delete(`/api/fms/template/${templateA._id}`)
      .set('Authorization', `Bearer ${tokenFor(userB)}`);

    expect(res.status).toBe(404);

    const stillThere = await FmsTemplate.findById(templateA._id);
    expect(stillThere).not.toBeNull();
  });

  test('tenant A can delete its own template', async () => {
    const templateA = await makeFmsTemplate(tenantA);

    const res = await request(app)
      .delete(`/api/fms/template/${templateA._id}`)
      .set('Authorization', `Bearer ${tokenFor(userA)}`);

    expect(res.status).toBe(200);
    const gone = await FmsTemplate.findById(templateA._id);
    expect(gone).toBeNull();
  });
});
