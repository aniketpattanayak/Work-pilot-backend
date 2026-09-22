require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');

function mask(str) {
  if (!str) return null;
  if (str.length <= 12) return '*'.repeat(str.length);
  return str.slice(0, 10) + '...' + str.slice(-4);
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to shared/platform DB.\n');

    const tenants = await Tenant.find({
      $or: [
        { 'superAdmin.customMongoUri': { $exists: true, $ne: '' } },
        { 'superAdmin.customWhatsappKey': { $exists: true, $ne: '' } },
      ],
    }).select('companyName subdomain superAdmin.customMongoUri superAdmin.customWhatsappKey superAdmin.status').lean();

    if (tenants.length === 0) {
      console.log('✅ No tenant currently has a custom DB or custom WhatsApp key set.');
      console.log('   Everything is on the shared database today — safe starting point.');
    } else {
      console.log(`⚠️  ${tenants.length} tenant(s) already have custom config set:\n`);
      tenants.forEach(t => {
        console.log(`— ${t.companyName} (${t.subdomain})  id=${t._id}`);
        console.log(`   customMongoUri:     ${t.superAdmin?.customMongoUri ? mask(t.superAdmin.customMongoUri) : '(not set)'}`);
        console.log(`   customWhatsappKey:  ${t.superAdmin?.customWhatsappKey ? mask(t.superAdmin.customWhatsappKey) : '(not set)'}`);
        console.log(`   status:             ${t.superAdmin?.status || 'active'}`);
        console.log('');
      });
      console.log('For each one listed above, run verify-isolation.js next — do not assume their data is actually isolated.');
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
})();
