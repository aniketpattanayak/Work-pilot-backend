require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');
const Employee = require('../../models/Employee');

const tenantId = process.argv[2];

(async () => {
  let sharedConn, customConn;
  try {
    sharedConn = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
    const SharedTenant = sharedConn.models.Tenant || sharedConn.model('Tenant', Tenant.schema);
    const SharedEmployee = sharedConn.models.Employee || sharedConn.model('Employee', Employee.schema);

    const tenant = await SharedTenant.findById(tenantId).lean();
    const sharedEmps = await SharedEmployee.find({ tenantId }).select('name email roles createdAt').lean();

    console.log('--- Shared DB employees ---');
    sharedEmps.forEach(e => console.log(`  id=${e._id}  email=${e.email}  name=${e.name}  roles=${e.roles}  createdAt=${e.createdAt}`));

    const customUri = tenant.superAdmin?.customMongoUri;
    if (customUri) {
      customConn = await mongoose.createConnection(customUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
      const CustomEmployee = customConn.models.Employee || customConn.model('Employee', Employee.schema);
      const customEmps = await CustomEmployee.find({ tenantId }).select('name email roles createdAt').lean();

      console.log('\n--- Dedicated DB employees ---');
      customEmps.forEach(e => console.log(`  id=${e._id}  email=${e.email}  name=${e.name}  roles=${e.roles}  createdAt=${e.createdAt}`));

      const sharedIds = new Set(sharedEmps.map(e => e._id.toString()));
      const overlap = customEmps.filter(e => sharedIds.has(e._id.toString()));
      console.log(overlap.length
        ? `\n⚠️  ${overlap.length} record(s) with the SAME _id exist in BOTH databases — true duplicate(s).`
        : `\n✅ No overlapping _id — these are distinct employee records, not duplicates.`);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    if (sharedConn) await sharedConn.close();
    if (customConn) await customConn.close();
  }
})();
