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
  console.log('Tenant _id:', tenant._id.toString(), '| customMongoUri SET:', !!tenant.superAdmin?.customMongoUri);

  const emailRegex = new RegExp('^' + EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');

  console.log('\n--- Searching SHARED DB, case-insensitive, ANY tenant ---');
  const sharedMatches = await SharedEmployee.find({ email: emailRegex }).select('name email tenantId').lean();
  if (sharedMatches.length === 0) console.log('  none found');
  sharedMatches.forEach(e => console.log(`  ${e.email} | name: ${e.name} | tenantId: ${e.tenantId} | matches ARV tenant? ${String(e.tenantId) === String(tenant._id)}`));

  if (tenant.superAdmin?.customMongoUri) {
    console.log('\n--- Searching DEDICATED (ARV) DB, case-insensitive, ANY tenant ---');
    const conn = await mongoose.createConnection(tenant.superAdmin.customMongoUri, { serverSelectionTimeoutMS: 5000 }).asPromise();
    const DedicatedEmployee = conn.model('Employee', SharedEmployee.schema);
    const dedMatches = await DedicatedEmployee.find({ email: emailRegex }).select('name email tenantId').lean();
    if (dedMatches.length === 0) console.log('  none found');
    dedMatches.forEach(e => console.log(`  ${e.email} | name: ${e.name} | tenantId: ${e.tenantId} | matches ARV tenant? ${String(e.tenantId) === String(tenant._id)}`));

    console.log('\n--- ALL employees currently in ARV dedicated DB (sanity list) ---');
    const all = await DedicatedEmployee.find({}).select('name email tenantId createdAt').sort({ createdAt: -1 }).limit(30).lean();
    all.forEach(e => console.log(`  ${e.email}  | ${e.name}  | tenantId: ${e.tenantId}`));
    await conn.close();
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
