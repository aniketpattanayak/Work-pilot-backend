require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');
const Employee = require('../../models/Employee');

const email = process.argv[2];
if (!email) { console.error('Usage: node find-and-delete-test-employee.js <email>'); process.exit(1); }

(async () => {
  const sharedConn = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
  const SharedEmployee = sharedConn.models.Employee || sharedConn.model('Employee', Employee.schema);

  const inShared = await SharedEmployee.findOne({ email });
  if (inShared) {
    console.log('Found in SHARED DB — deleting from there.');
    await SharedEmployee.deleteOne({ email });
    console.log('✅ Deleted.');
  } else {
    const SharedTenant = sharedConn.models.Tenant || sharedConn.model('Tenant', Tenant.schema);
    const tenant = await SharedTenant.findById('6ab234b5dfaa60ec91448715').lean();
    const customConn = await mongoose.createConnection(tenant.superAdmin.customMongoUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    const CustomEmployee = customConn.models.Employee || customConn.model('Employee', Employee.schema);
    const inCustom = await CustomEmployee.findOne({ email });
    if (inCustom) {
      console.log('Found in DEDICATED DB — deleting from there.');
      await CustomEmployee.deleteOne({ email });
      console.log('✅ Deleted.');
    } else {
      console.log('⚠️ Not found in either database.');
    }
    await customConn.close();
  }
  await sharedConn.close();
})();
