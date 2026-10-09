require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');
const sendWhatsAppMessage = require('../../utils/whatsappNotify');

const tenantId = process.argv[2];
const toPhone  = process.argv[3];

if (!tenantId || !toPhone) {
  console.error('Usage: node scripts/tenant-tools/test-whatsapp-send.js <tenantId> <phoneNumber>');
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const tenant = await Tenant.findById(tenantId)
      .select('superAdmin.customWhatsappKey whatsappConfig companyName').lean();
    if (!tenant) throw new Error('Tenant not found');

    const tenantKey = tenant?.superAdmin?.customWhatsappKey || tenant?.whatsappConfig?.apiKey || null;

    console.log(`Tenant: ${tenant.companyName}`);
    console.log('Key source:', tenant?.superAdmin?.customWhatsappKey
      ? 'superAdmin.customWhatsappKey (Maytapi, per your check)'
      : (tenant?.whatsappConfig?.apiKey ? 'whatsappConfig.apiKey' : 'NONE — will fall back to the shared global DoubleTick key'));
    console.log(`Sending a real test WhatsApp message to +${toPhone} now...\n`);

    await sendWhatsAppMessage(toPhone, {
      templateName: 'api_otp_',
      variables: ['This is a WorkPilot WhatsApp integration test — please ignore.'],
    }, tenantKey);

    console.log('\n✅ Call completed without throwing. Look at the log line directly above —');
    console.log('   "[Maytapi] Message → ..." means ARV\'s own Maytapi account handled it.');
    console.log('   "[DoubleTick] ... → ..." would mean it went through the shared account instead.');
  } catch (err) {
    console.error('❌ Send failed:', err.message);
  } finally {
    await mongoose.disconnect();
  }
})();
