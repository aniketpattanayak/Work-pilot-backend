const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const mongoose = require('mongoose');

const SUBDOMAIN = 'arv';
const EMAIL = 'tech@colorplas.in';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const Tenant = require(path.join(__dirname, '../../models/Tenant'));
  const SharedEmployee = require(path.join(__dirname, '../../models/Employee'));

  const tenant = await Tenant.findOne({ subdomain: SUBDOMAIN }).lean();
  if (!tenant) {
    console.log('❌ No tenant found with subdomain:', SUBDOMAIN);
    process.exit(1);
  }
  console.log('Tenant:', tenant.companyName, '| _id:', tenant._id.toString());
  console.log('subscription.status:', tenant.subscription?.status || '(none)');
  const customUri = tenant.superAdmin?.customMongoUri || null;
  console.log('customMongoUri:', customUri ? 'SET' : 'NOT SET');

  const inShared = await SharedEmployee.findOne({ email: EMAIL, tenantId: tenant._id }).lean();
  console.log('\nIn SHARED DB:', inShared ? `FOUND (id ${inShared._id})` : 'NOT FOUND');

  if (customUri) {
    const conn = await mongoose.createConnection(customUri, { serverSelectionTimeoutMS: 5000 }).asPromise();
    const DedicatedEmployee = conn.model('Employee', SharedEmployee.schema);
    const inDedicated = await DedicatedEmployee.findOne({ email: EMAIL, tenantId: tenant._id }).lean();
    console.log('In DEDICATED DB:', inDedicated ? `FOUND (id ${inDedicated._id})` : 'NOT FOUND');
    await conn.close();
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
