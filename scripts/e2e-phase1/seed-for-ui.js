const BASE = 'http://localhost:5099/api';
const fs = require('fs');
async function j(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: (body !== undefined && body !== null && method !== 'GET' && method !== 'DELETE') ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
(async () => {
  const sub = 'zzz-ui-' + Date.now();
  let r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  const fd = new FormData();
  fd.append('companyName', 'UI Test Co'); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token, tenantId = r.data.tenantId;
  await j('PUT', `/tasks/access/modules/${tenantId}`, { modules: { attendance: true, leave: true, payroll: true } }, superToken);
  await j('PUT', '/tenants/update-settings', { tenantId, sectors: ['Engineering', 'Finance'], locations: ['HQ', 'Branch'] }, adminToken);

  r = await j('POST', '/tasks/access/roles', { name: 'HR', description: '', permissions: [
    { key: 'payroll.viewSalary', scope: 'company' }, { key: 'payroll.configure', scope: 'company' }, { key: 'payroll.prepare', scope: 'company' }, { key: 'payroll.export', scope: 'company' },
  ] }, adminToken);
  const hrRole = r.data.role.key;
  r = await j('POST', '/tasks/access/roles', { name: 'Finance', description: '', permissions: [
    { key: 'payroll.viewSalary', scope: 'company' }, { key: 'payroll.approve', scope: 'company' }, { key: 'payroll.release', scope: 'company' },
  ] }, adminToken);
  const finRole = r.data.role.key;

  r = await j('POST', '/tenants/add-employee', { tenantId, name: 'Hina HR', email: `hina@${sub}.test`, whatsappNumber: '9990001001', department: 'Engineering', password: 'TestPass123!', roles: ['Doer'], joiningDate: '2026-01-01' }, adminToken);
  const hrId = r.data.employee._id;
  await j('PUT', '/tasks/access/assign', { employeeId: hrId, roleKeys: [hrRole] }, adminToken);

  r = await j('POST', '/tenants/add-employee', { tenantId, name: 'Faisal Finance', email: `faisal@${sub}.test`, whatsappNumber: '9990001002', department: 'Finance', password: 'TestPass123!', roles: ['Doer'], joiningDate: '2026-01-01' }, adminToken);
  const finId = r.data.employee._id;
  await j('PUT', '/tasks/access/assign', { employeeId: finId, roleKeys: [finRole] }, adminToken);

  r = await j('POST', '/tenants/add-employee', { tenantId, name: 'Rahul Report', email: `rahul@${sub}.test`, whatsappNumber: '9990001003', department: 'Engineering', password: 'TestPass123!', roles: ['Doer'], joiningDate: '2026-01-01' }, adminToken);
  const rahulId = r.data.employee._id;

  // set a salary for Rahul so there's something to see
  r = await j('PUT', `/tasks/payroll/salaries/${rahulId}`, { effectiveFrom: '2026-01-01', basic: 25000, items: [{ key: 'hra', amount: 8000 }] }, await (async () => { const rr = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `hina@${sub}.test`, password: 'TestPass123!' }); return rr.data.token; })());

  fs.writeFileSync(__dirname + '/ui-seed-state.json', JSON.stringify({ sub, tenantId, adminEmail: `admin@${sub}.test`, hrEmail: `hina@${sub}.test`, finEmail: `faisal@${sub}.test`, rahulEmail: `rahul@${sub}.test`, rahulId }, null, 2));
  console.log('seeded', sub);
})().catch((e) => { console.error('SEED_UI_FAILED', e); process.exit(1); });
