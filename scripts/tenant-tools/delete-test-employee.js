require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');
const Employee = require('../../models/Employee');

const tenantId = '6ab234b5dfaa60ec91448715';
const email = process.argv[2];
if (!email) { console.error('Usage: node delete-test-employee.js <email>'); process.exit(1); }

(async () => {
  const sharedConn = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
  const SharedTenant = sharedConn.models.Tenant || sharedConn.model('Tenant', Tenant.schema);
  const tenant = await SharedTenant.findById(tenantId).lean();
  const customUri = tenant.superAdmin?.customMongoUri;
  const customConn = await mongoose.createConnection(customUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
  const CustomEmployee = customConn.models.Employee || customConn.model('Employee', Employee.schema);

  const result = await CustomEmployee.deleteOne({ email, tenantId });
  console.log(result.deletedCount ? '✅ Test employee deleted.' : '⚠️ Nothing deleted — check the email.');

  await sharedConn.close();
  await customConn.close();
})();
