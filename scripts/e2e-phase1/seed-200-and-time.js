// Phase 1 Section F: seed 200 people + a month of attendance directly into the test DB
// (not via the API, one at a time, per the brief), then time a payroll run and the main
// list/dashboard routes through the real API, with mongoose query-count instrumentation.
const mongoose = require('/tmp/wpb/node_modules/mongoose');
const bcrypt = require('/tmp/wpb/node_modules/bcryptjs');
const BACKEND = '/tmp/wpb';
const BASE = 'http://localhost:5099/api';

async function j(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: (body !== undefined && body !== null && method !== 'GET' && method !== 'DELETE') ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

(async () => {
  const sub = 'zzz-scale200-' + Date.now();

  // 1. Create tenant + admin through the real API (so RBAC/tenant bootstrap stays realistic).
  let r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  const fd = new FormData();
  fd.append('companyName', 'Scale200 Co'); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  r = await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => ({})) }));
  r = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token, tenantId = r.data.tenantId;
  await j('PUT', `/tasks/access/modules/${tenantId}`, { modules: { attendance: true, leave: true, payroll: true } }, superToken);

  // 2. Connect mongoose directly to the same test DB (never production - MONGO_URI is read
  //    from the already-confirmed-local .env) and bulk-write 200 employees + salaries + a
  //    month of punches in batches, bypassing the HTTP API entirely.
  require(BACKEND + '/node_modules/dotenv').config({ path: BACKEND + '/.env' });
  await mongoose.connect(process.env.MONGO_URI);
  console.log('connected directly to', new URL(process.env.MONGO_URI).host, '/', new URL(process.env.MONGO_URI).pathname.slice(1));

  const Employee = require(BACKEND + '/models/Employee');
  const PayrollStructure = require(BACKEND + '/models/PayrollStructure');
  const Punch = require(BACKEND + '/models/Punch');

  const N = 200;
  const hash = await bcrypt.hash('TestPass123!', 4); // low cost factor - this is test seeding, not a real login path
  const empDocs = [];
  for (let i = 0; i < N; i++) {
    empDocs.push({
      tenantId, name: `Scale Person ${i}`, department: ['Engineering', 'Sales', 'Ops', 'Support'][i % 4],
      location: i % 2 === 0 ? 'HQ' : 'Branch', whatsappNumber: String(9800000000 + i),
      email: `scale${i}@${sub}.test`, password: hash, roles: ['Doer'],
      joiningDate: new Date('2026-01-01T00:00:00.000Z'),
    });
  }
  let t0 = Date.now();
  const inserted = await Employee.insertMany(empDocs, { ordered: false });
  console.log(`inserted ${inserted.length} employees in ${Date.now() - t0}ms`);

  const salaryDocs = inserted.map((e) => ({
    tenantId, employeeId: e._id, effectiveFrom: '2026-01-01', basic: 20000 + (Math.random() * 10000 | 0),
    items: [{ key: 'hra', amount: 8000 }, { key: 'special', amount: 3000 }],
    bank: { accountName: e.name, bankName: 'Test Bank', accountNumber: '000' + Math.floor(Math.random() * 1e9), ifsc: 'TEST0000001' },
  }));
  t0 = Date.now();
  await PayrollStructure.insertMany(salaryDocs, { ordered: false });
  console.log(`inserted ${salaryDocs.length} salary structures in ${Date.now() - t0}ms`);

  // 30 days of punches (present on weekdays) for September 2026 for all 200 people.
  const punchDocs = [];
  for (const e of inserted) {
    for (let d = 1; d <= 30; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`;
      const dow = new Date(date + 'T00:00:00.000Z').getUTCDay();
      if (dow === 0) continue; // Sunday off
      punchDocs.push({ tenantId, employeeId: e._id, date, type: 'in', at: new Date(date + 'T04:00:00.000Z') });
      punchDocs.push({ tenantId, employeeId: e._id, date, type: 'out', at: new Date(date + 'T13:00:00.000Z') });
    }
  }
  t0 = Date.now();
  await Punch.insertMany(punchDocs, { ordered: false });
  console.log(`inserted ${punchDocs.length} punches in ${Date.now() - t0}ms`);

  // 3. Turn on query-count instrumentation (mongoose debug hook), then time the real
  //    HTTP routes a company this size would actually hit hardest.
  let queryCount = 0;
  mongoose.set('debug', (coll, method) => { queryCount++; });

  async function timed(label, fn) {
    queryCount = 0;
    const start = Date.now();
    const result = await fn();
    const ms = Date.now() - start;
    console.log(`\n[${label}] ${ms}ms, ${queryCount} mongoose queries`, (result && result.status) ? `(HTTP ${result.status})` : '');
    return { label, ms, queries: queryCount, status: result && result.status };
  }

  // payroll.* is a sensitive module - Admin does not auto-get it. Grant a throwaway
  // HR-equivalent role at company scope, same as the rest of this session's testing.
  let rr = await j('POST', '/tasks/access/roles', { name: 'ScaleHR', description: '', permissions: [
    { key: 'payroll.viewSalary', scope: 'company' }, { key: 'payroll.configure', scope: 'company' }, { key: 'payroll.prepare', scope: 'company' },
  ] }, adminToken);
  const roleKey = rr.data.role.key;
  rr = await j('PUT', `/tenants/employees/${inserted[0]._id}`, { roles: ['Doer'] }, adminToken); // ensure a base role exists on the carrier account
  await j('PUT', '/tasks/access/assign', { employeeId: String(inserted[0]._id), roleKeys: [roleKey] }, adminToken);
  rr = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `scale0@${sub}.test`, password: 'TestPass123!' });
  const hrToken = rr.data.token;

  const results = [];
  results.push(await timed('GET employee list (200 people)', () => j('GET', `/tasks/employees/${tenantId}`, null, adminToken)));
  results.push(await timed('GET attendance sheet, Sept 2026 (200 people x 26 working days)', () => j('GET', '/tasks/attendance/sheet?month=2026-09', null, adminToken)));
  results.push(await timed('GET payroll salaries list (200 people)', () => j('GET', '/tasks/payroll/salaries', null, hrToken)));
  results.push(await timed('POST payroll run create (September 2026, 200 people)', () => j('POST', '/tasks/payroll/runs', { month: '2026-09' }, hrToken)));

  console.log('\n--- SUMMARY ---');
  results.forEach((r) => console.log(`${r.label}: ${r.ms}ms, ${r.queries} queries, HTTP ${r.status}`));

  require('fs').writeFileSync(__dirname + '/results-scale200.json', JSON.stringify(results, null, 2));
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('SCALE200_FAILED', e); process.exit(1); });
