// Regression tests for everything on release/security-fixes:
//   1. FMS history routes now require auth and tenant ownership
//   2. resetAdminPassword actually changes the real password
//   3. employee joiningDate is accepted and validated
//   4. the ported tenant-isolation/IDOR fixes in fmsController.js /
//      newFmsController.js (initializeFlow, executeStep, deleteFmsTemplate,
//      syncFmsOrders, getMyMissions, and a representative newFmsController
//      check) actually block cross-tenant access, not just same-tenant use.
//
// Deliberately plain HTTP checks against the real running backend (no Jest/
// mongodb-memory-server - this branch does not touch package.json or
// package-lock.json), same style as the rest of this repo's one-off scripts.
process.env.PORT = process.env.PORT || '5091';

const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 300));
}

async function j(base, method, p, body, token) {
  const headers = { Authorization: token ? `Bearer ${token}` : undefined };
  let sendBody;
  if (body !== undefined && method !== 'GET') { headers['Content-Type'] = 'application/json'; sendBody = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers, body: sendBody });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function makeTenant(BASE, superToken, label) {
  const sub = `zzz-secfix-${label}-${Date.now()}`;
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  const r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  return { sub, tenantId: r.data.tenantId, adminToken: r.data.token };
}

function templateBody(tenantId) {
  return {
    tenantId, flowName: 'Test Flow', googleSheetId: 'sheet1', scriptUrl: 'https://example.invalid/script', tabName: 'Sheet1',
    nodes: [{ nodeName: 'Step 1', emailColumn: 'a@test.com', stepIndex: 0 }],
  };
}

(async () => {
  require('../../index.js');
  await new Promise((r) => setTimeout(r, 2500));
  const BASE = `http://localhost:${process.env.PORT}/api`;

  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  const A = await makeTenant(BASE, superToken, 'a');
  const B = await makeTenant(BASE, superToken, 'b');
  check('setup: two separate tenants (A, B) created', !!A.tenantId && !!B.tenantId, { A: A.tenantId, B: B.tenantId });

  // === 1. FMS history auth fix (c15db7c) ===
  r = await j(BASE, 'POST', '/fms/create-template', templateBody(A.tenantId), A.adminToken);
  const templateA = r.data?.template;
  check('setup: tenant A has a real FMS template', !!templateA?._id, r);

  r = await j(BASE, 'POST', '/fms/start-flow', { templateId: templateA._id, orderIdentifier: 'ORD-1' }, A.adminToken);
  const instanceA = r.data?.instance;
  check('setup: tenant A has a real running FMS instance', !!instanceA?._id, r);

  r = await fetch(`${BASE}/fms/history/${instanceA._id}`); // no Authorization header at all
  check('1. getInstanceHistory rejects a request with no auth token at all', r.status === 401 || r.status === 403, r.status);

  r = await j(BASE, 'GET', `/fms/history/${instanceA._id}`, undefined, B.adminToken);
  check("1. getInstanceHistory denies tenant B's token for tenant A's instance (404, not a leak)", r.status === 404, r);

  r = await j(BASE, 'GET', `/fms/history/${instanceA._id}`, undefined, A.adminToken);
  check("1. getInstanceHistory still works for the owning tenant's own token", r.status === 200, r);

  r = await fetch(`${BASE}/fms/history/flow/${templateA._id}`);
  check('1. getFlowHistory rejects a request with no auth token at all', r.status === 401 || r.status === 403, r.status);
  r = await j(BASE, 'GET', `/fms/history/flow/${templateA._id}`, undefined, B.adminToken);
  check("1. getFlowHistory denies tenant B's token for tenant A's template (404, not a leak)", r.status === 404, r);

  // === 2. resetAdminPassword fix (168c913) ===
  r = await j(BASE, 'POST', `/superadmin/tenants/${A.tenantId}/reset-password`, { newPassword: 'BrandNewPass456!' }, superToken);
  check('2. resetAdminPassword call succeeds', r.status === 200, r);
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: A.sub, email: `admin@${A.sub}.test`, password: 'BrandNewPass456!' });
  check('2. the admin can log in with the NEW password after reset', r.status === 200 && !!r.data.token, r);
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: A.sub, email: `admin@${A.sub}.test`, password: 'TestPass123!' });
  check('2. the admin can NO LONGER log in with the OLD password after reset', r.status !== 200, r);

  // === 3. joiningDate validation (2362459) ===
  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId: A.tenantId, name: 'Future Joiner', email: `future-${Date.now()}@${A.sub}.test`, department: 'Ops',
    whatsappNumber: '7111111111', roles: ['Doer'], password: 'TestPass123!', joiningDate: '2099-01-01',
  }, A.adminToken);
  check('3. a joiningDate in the future is rejected', r.status === 400, r);

  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId: A.tenantId, name: 'Real Joiner', email: `real-${Date.now()}@${A.sub}.test`, department: 'Ops',
    whatsappNumber: '7111111112', roles: ['Doer'], password: 'TestPass123!', joiningDate: 'not-a-date',
  }, A.adminToken);
  check('3. a garbage joiningDate string is rejected', r.status === 400, r);

  r = await j(BASE, 'POST', '/tasks/add-employee', {
    tenantId: A.tenantId, name: 'Real Joiner', email: `real2-${Date.now()}@${A.sub}.test`, department: 'Ops',
    whatsappNumber: '7111111113', roles: ['Doer'], password: 'TestPass123!', joiningDate: '2024-03-15',
  }, A.adminToken);
  const newEmp = r.data?.employee || r.data;
  check('3. a valid past joiningDate is accepted and actually stored', r.status === 200 || r.status === 201, r);
  check('3. the stored joiningDate really is the one that was sent', newEmp && String(newEmp.joiningDate || '').slice(0, 10) === '2024-03-15', newEmp);

  // === 4. Ported tenant-isolation fixes ===
  // initializeFlow: a tenant cannot start a flow against ANOTHER tenant's template.
  r = await j(BASE, 'POST', '/fms/start-flow', { templateId: templateA._id, orderIdentifier: 'ORD-CROSS' }, B.adminToken);
  check("4a. initializeFlow: tenant B cannot start a flow against tenant A's template (404, not cross-tenant success)", r.status === 404, r);

  // executeStep: a tenant cannot execute a step on another tenant's instance.
  r = await j(BASE, 'PUT', `/fms/execute-step/${instanceA._id}`, { remarks: 'hijack attempt' }, B.adminToken);
  check("4b. executeStep: tenant B is forbidden from executing a step on tenant A's instance (403)", r.status === 403, r);

  // getMyMissions: must only return the caller's own tenant's instances.
  r = await j(BASE, 'POST', '/fms/create-template', templateBody(B.tenantId), B.adminToken);
  const templateB = r.data?.template;
  r = await j(BASE, 'POST', '/fms/start-flow', { templateId: templateB._id, orderIdentifier: 'ORD-B' }, B.adminToken);
  r = await j(BASE, 'GET', `/fms/my-missions/${encodeURIComponent(`admin@${B.sub}.test`)}`, undefined, B.adminToken);
  const missionTemplateIds = (Array.isArray(r.data?.missions) ? r.data.missions : (Array.isArray(r.data) ? r.data : []))
    .map((m) => String(m.templateId?._id || m.templateId || ''));
  check("4c. getMyMissions for tenant B never includes tenant A's instance/template", !missionTemplateIds.includes(String(templateA._id)), { missionTemplateIds, templateA: String(templateA._id) });

  // deleteFmsTemplate: tenant B cannot delete tenant A's template.
  r = await j(BASE, 'DELETE', `/fms/template/${templateA._id}`, undefined, B.adminToken);
  check("4d. deleteFmsTemplate: tenant B cannot delete tenant A's template (404)", r.status === 404, r);
  r = await j(BASE, 'GET', `/fms/templates/${A.tenantId}`, undefined, A.adminToken);
  const stillThere = (Array.isArray(r.data) ? r.data : []).some((t) => String(t._id) === String(templateA._id));
  check("4d. tenant A's template really does still exist after the denied cross-tenant delete attempt", stillThere, r.data);

  // syncFmsOrders: tenant B cannot trigger a sync against tenant A's template.
  r = await j(BASE, 'GET', `/fms/sync/${templateA._id}`, undefined, B.adminToken);
  check("4e. syncFmsOrders: tenant B cannot sync tenant A's template (404)", r.status === 404, r);

  // newFmsController representative check: getTemplateById across tenants (uses FlowTemplate, a
  // separate model/route family from the legacy FMS one above - create one for each tenant).
  const FlowTemplate = require('../../models/FlowTemplate');
  const flowTplA = await FlowTemplate.create({ tenantId: A.tenantId, name: 'Flow A', nodes: [], startNodeId: 'node_1' });
  r = await j(BASE, 'GET', `/fms2/templates/detail/${flowTplA._id}`, undefined, B.adminToken);
  check("4f. newFmsController.getTemplateById denies tenant B's token for tenant A's FlowTemplate (404)", r.status === 404, r);
  r = await j(BASE, 'GET', `/fms2/templates/detail/${flowTplA._id}`, undefined, A.adminToken);
  check('4f. ...but still works for the owning tenant', r.status === 200, r);

  console.log('\n' + results.filter((r2) => r2.pass).length + ' PASS / ' + results.filter((r2) => !r2.pass).length + ' FAIL / ' + results.length + ' TOTAL');
  require('fs').writeFileSync(__dirname + '/results.json', JSON.stringify(results, null, 2));
  process.exitCode = results.every((r2) => r2.pass) ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 500);
})().catch((e) => { console.error('SECURITY_FIXES_REGRESSION_FAILED', e); process.exit(1); });
