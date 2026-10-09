const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const mongoose = require('mongoose');

const TENANT_ID = '6ab234b5dfaa60ec91448715'; // ARV

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const Tenant = require(path.join(__dirname, '../../models/Tenant'));
  const SharedEmployee = require(path.join(__dirname, '../../models/Employee'));

  const tenant = await Tenant.findById(TENANT_ID).lean();
  const conn = await mongoose.createConnection(tenant.superAdmin.customMongoUri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const DedicatedEmployee = conn.model('Employee', SharedEmployee.schema);

  const dedicated = await DedicatedEmployee.find({ tenantId: TENANT_ID }).select('name email').lean();

  console.log('ARV employees (from dedicated DB) and whether login can currently find them:\n');
  for (const e of dedicated) {
    const inShared = await SharedEmployee.findOne({ email: e.email, tenantId: TENANT_ID }).lean();
    console.log(`  ${e.email.padEnd(30)} (${e.name.padEnd(20)}) — in shared DB (what login checks): ${inShared ? 'YES → can log in' : 'NO → 401 Invalid Credentials'}`);
  }

  await conn.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
