const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const Tenant = require('./models/Tenant');

  // Find all paused companies and resume them
  const result = await Tenant.updateMany(
    { 'subscription.status': 'paused' },
    {
      $set: {
        'subscription.status': 'active',
        'subscription.pausedAt': null,
        'subscription.reason': ''
      }
    }
  );

  console.log('✅ Resumed', result.modifiedCount, 'company/companies');

  // Show current state of all companies
  const all = await Tenant.find().select('companyName subscription');
  all.forEach(c => {
    console.log(`  ${c.companyName}: ${c.subscription?.status || 'active (no field)'}`);
  });

  process.exit(0);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});