const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const Tenant = require(path.join(__dirname, '../../models/Tenant'));

  const t = await Tenant.findById('696e442133aebb9d9b88742a').lean();
  if (!t) {
    console.log('❌ No tenant found with that _id at all.');
    process.exit(1);
  }
  console.log('companyName:', t.companyName);
  console.log('subdomain:', t.subdomain);
  console.log('subscription.status:', t.subscription?.status || '(none)');
  console.log('customMongoUri SET:', !!t.superAdmin?.customMongoUri);
  console.log('createdAt:', t.createdAt);

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
