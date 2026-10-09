require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');
const Employee = require('../../models/Employee');

const tenantId = process.argv[2];

function mask(str) {
  if (!str) return '(not set)';
  if (str.length <= 10) return '*'.repeat(str.length);
  return str.slice(0, 8) + '...' + str.slice(-4);
}

(async () => {
  let sharedConn, customConn;
  try {
    sharedConn = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
    const SharedTenant = sharedConn.models.Tenant || sharedConn.model('Tenant', Tenant.schema);
    const tenant = await SharedTenant.findById(tenantId).lean();
    if (!tenant) throw new Error('Tenant not found');

    console.log(`Tenant: ${tenant.companyName}\n`);
    console.log('--- whatsappConfig (old-style, checked by task/checklist/ticket notifications) ---');
    console.log('  isActive:   ', tenant.whatsappConfig?.isActive ?? false);
    console.log('  apiKey:     ', mask(tenant.whatsappConfig?.apiKey));
    console.log('  instanceId: ', tenant.whatsappConfig?.instanceId || '(not set)');

    console.log('\n--- superAdmin.customWhatsappKey (checked by fmsNotifier.js only) ---');
    const cwk = tenant.superAdmin?.customWhatsappKey;
    console.log('  raw:        ', mask(cwk));
    if (cwk) {
      try {
        const parsed = JSON.parse(cwk);
        console.log('  provider:   ', parsed.provider || '(no provider field)');
      } catch {
        console.log('  provider:    could not parse as JSON — would be treated as a raw DoubleTick key, not Maytapi');
      }
    }

    console.log('\n--- Employee WhatsApp numbers (need at least one for a test send) ---');
    const sharedEmps = await (sharedConn.models.Employee || sharedConn.model('Employee', Employee.schema))
      .find({ tenantId }).select('name whatsappNumber').lean();
    sharedEmps.forEach(e => console.log(`  [shared DB]    ${e.name}: ${e.whatsappNumber || '(not set)'}`));

    const customUri = tenant.superAdmin?.customMongoUri;
    if (customUri) {
      customConn = await mongoose.createConnection(customUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
      const customEmps = await (customConn.models.Employee || customConn.model('Employee', Employee.schema))
        .find({ tenantId }).select('name whatsappNumber').lean();
      customEmps.forEach(e => console.log(`  [dedicated DB] ${e.name}: ${e.whatsappNumber || '(not set)'}`));
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    if (sharedConn) await sharedConn.close();
    if (customConn) await customConn.close();
  }
})();
