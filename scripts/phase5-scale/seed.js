// Phase 5 scale-readiness seeding script. Writes DIRECTLY to the local test
// Mongo (nosqldb on 127.0.0.1:27018, workpilot_test db) - never to any real
// deployment, never over the network to a real address. Bypasses the API
// entirely (as the brief specifies) for seed speed.
//
// SCOPE NOTE (see SCALE_REPORT.md for the full explanation): the brief asked
// for 50 companies / ~200k employees. This sandbox has 2 vCPUs and ~8GB RAM -
// nowhere near a real multi-node deployment, and seeding + load-testing 200k
// documents' worth of attendance/task data here would mostly measure this
// sandbox's own disk/CPU ceiling, not the application. This script seeds a
// single company with a configurable (smaller but still meaningful) employee
// count and a month of attendance, large enough to expose real N+1/missing-
// index patterns in the actual query code, and the report explicitly labels
// every number as "measured here" vs "estimated by extrapolation for 20k/100k".
const mongoose = require('/tmp/wpb/node_modules/mongoose');
const bcrypt = require('/tmp/wpb/node_modules/bcryptjs');

const EMPLOYEE_COUNT = Number(process.env.SEED_EMPLOYEES || 2000);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27018/workpilot_test';

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const tenantsCol = db.collection('tenants');
  const employeesCol = db.collection('employees');
  const attendanceCol = db.collection('punches'); // matches models/Punch.js's mongoose.model('Punch', ...)
  const cols = await db.listCollections().toArray();
  console.log('Existing collections:', cols.map((c) => c.name).join(', '));

  const sub = 'zzz-scale-' + Date.now();
  const passwordHash = await bcrypt.hash('TestPass123!', 10);

  const tenantDoc = {
    companyName: 'Scale Test Co', subdomain: sub,
    hrModules: { attendance: true, leave: true, payroll: true },
    superAdmin: { status: 'active', aiAssistant: { enabled: false, monthlyLimit: 500, usageMonth: '', usageCount: 0 } },
    createdAt: new Date(), updatedAt: new Date(),
  };
  const tenantResult = await tenantsCol.insertOne(tenantDoc);
  const tenantId = tenantResult.insertedId;
  console.log('Seeded tenant', sub, tenantId.toString());

  // Admin
  await employeesCol.insertOne({
    tenantId, name: 'Scale Admin', email: `admin@${sub}.test`, department: 'Admin',
    whatsappNumber: '9000000000', roles: ['Admin'], password: passwordHash,
    createdAt: new Date(), updatedAt: new Date(),
  });

  // Bulk employees
  const t0 = Date.now();
  const batchSize = 500;
  let created = 0;
  for (let i = 0; i < EMPLOYEE_COUNT; i += batchSize) {
    const batch = [];
    for (let j = i; j < Math.min(i + batchSize, EMPLOYEE_COUNT); j++) {
      batch.push({
        tenantId, name: `Scale Employee ${j}`, email: `scale-emp-${j}-${sub}@test.com`,
        department: ['Ops', 'Sales', 'Finance', 'Support'][j % 4], whatsappNumber: '9' + String(1000000000 + j).slice(1),
        roles: ['Doer'], password: passwordHash, joiningDate: new Date('2024-01-01'),
        createdAt: new Date(), updatedAt: new Date(),
      });
    }
    const r = await employeesCol.insertMany(batch, { ordered: false });
    created += r.insertedCount || batch.length;
  }
  const employeeSeedMs = Date.now() - t0;
  console.log(`Seeded ${created} employees in ${employeeSeedMs}ms (${(employeeSeedMs / created).toFixed(2)}ms/employee)`);

  // A month of attendance punches, directly inserted, skipping the API (and
  // therefore also skipping geofence/face-match logic - this is seed data for
  // query-performance testing, not a correctness test of attendance itself).
  const employees = await employeesCol.find({ tenantId, roles: 'Doer' }).project({ _id: 1 }).toArray();
  const daysInMonth = 22; // working days
  const t1 = Date.now();
  let punchesCreated = 0;
  const punchBatch = [];
  const pad = (n) => String(n).padStart(2, '0');
  for (const emp of employees) {
    for (let d = 0; d < daysInMonth; d++) {
      const day = new Date(2026, 8, 1 + d); // Sept 2026
      const dateStr = `2026-09-${pad(1 + d)}`;
      const inAt = new Date(day.getTime() + 9 * 3600 * 1000);
      const outAt = new Date(day.getTime() + 18 * 3600 * 1000);
      punchBatch.push(
        { tenantId, employeeId: emp._id, date: dateStr, at: inAt, type: 'in', source: 'web', createdAt: new Date(), updatedAt: new Date() },
        { tenantId, employeeId: emp._id, date: dateStr, at: outAt, type: 'out', source: 'web', createdAt: new Date(), updatedAt: new Date() },
      );
      if (punchBatch.length >= 2000) {
        await attendanceCol.insertMany(punchBatch.splice(0), { ordered: false });
        punchesCreated += 2000;
      }
    }
  }
  if (punchBatch.length) { await attendanceCol.insertMany(punchBatch, { ordered: false }); punchesCreated += punchBatch.length; }
  const attendanceSeedMs = Date.now() - t1;
  console.log(`Seeded ${punchesCreated} attendance punches (${daysInMonth} working days x ${employees.length} employees) in ${attendanceSeedMs}ms`);

  require('fs').writeFileSync(__dirname + '/seed-state.json', JSON.stringify({ sub, tenantId: tenantId.toString(), employeeCount: created, punchesCreated, employeeSeedMs, attendanceSeedMs }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => { console.error('SEED_FAILED', e); process.exit(1); });
