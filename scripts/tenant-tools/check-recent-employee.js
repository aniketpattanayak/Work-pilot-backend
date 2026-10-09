require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');
const Employee = require('../../models/Employee');

const tenantId = process.argv[2];
if (!tenantId) {
  console.error('Usage: node scripts/tenant-tools/check-recent-employee.js <tenantId>');
  process.exit(1);
}

(async () => {
  let sharedConn, customConn;
  try {
    sharedConn = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
    const SharedTenant = sharedConn.models.Tenant || sharedConn.model('Tenant', Tenant.schema);
    const tenant = await SharedTenant.findById(tenantId).lean();
    if (!tenant) throw new Error('Tenant not found');

    console.log(`Tenant: ${tenant.companyName}`);
    console.log('whatsappConfig.isActive:', tenant.whatsappConfig?.isActive ?? false);
    console.log('Has custom WhatsApp key: ', !!(tenant.superAdmin?.customWhatsappKey || tenant.whatsappConfig?.apiKey));
    console.log('');

    async function printRecent(label, conn) {
      const EmployeeModel = conn.models.Employee || conn.model('Employee', Employee.schema);
      const recent = await EmployeeModel.find({ tenantId }).sort({ createdAt: -1 }).limit(5)
        .select('name email whatsappNumber createdAt').lean();
      console.log(`--- ${label}: 5 most recently created employees ---`);
      if (recent.length === 0) console.log('  (none)');
      recent.forEach(e => console.log(`  ${e.createdAt?.toISOString?.() || e.createdAt}  ${e.name}  whatsappNumber="${e.whatsappNumber || '(EMPTY)'}"`));
      console.log('');
    }

    await printRecent('Shared DB', sharedConn);

    const customUri = tenant.superAdmin?.customMongoUri;
    if (customUri) {
      customConn = await mongoose.createConnection(customUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
      await printRecent('Dedicated DB', customConn);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    if (sharedConn) await sharedConn.close();
    if (customConn) await customConn.close();
  }
})();
