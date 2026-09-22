require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');

const tenantId = process.argv[2];
if (!tenantId) {
  console.error('Usage: node scripts/tenant-tools/verify-isolation.js <tenantId>');
  process.exit(1);
}

const TENANT_SCOPED = [
  'Employee', 'DelegationTask', 'ChecklistTask', 'FlowInstance', 'FlowTemplate',
  'Conversation', 'Message', 'OrderForm', 'OrderSubmission', 'Ticket',
  'FmsTemplate', 'FmsInstance', 'FmsSheetData',
];
const PLATFORM_OWNED = ['ActivityLog', 'Billing'];

function bindModels(conn) {
  const models = {};
  for (const name of [...TENANT_SCOPED, ...PLATFORM_OWNED, 'FmsHistory']) {
    const schema = require(`../../models/${name}`).schema;
    models[name] = conn.models[name] || conn.model(name, schema);
  }
  return models;
}

(async () => {
  let sharedConn, customConn;
  try {
    sharedConn = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
    const SharedTenant = sharedConn.models.Tenant || sharedConn.model('Tenant', Tenant.schema);
    const tenant = await SharedTenant.findById(tenantId).lean();

    if (!tenant) {
      console.error(`❌ No tenant found with id ${tenantId} in the shared DB.`);
      process.exit(1);
    }

    console.log(`Tenant: ${tenant.companyName} (${tenant.subdomain})`);
    const customUri = tenant.superAdmin?.customMongoUri;
    const sharedModels = bindModels(sharedConn);

    if (!customUri) {
      console.log('\nNo dedicated DB configured for this tenant.\n');
      for (const name of TENANT_SCOPED) {
        const count = await sharedModels[name].countDocuments({ tenantId });
        console.log(`  ${name.padEnd(16)} shared=${count}`);
      }
      return;
    }

    console.log('Dedicated DB is configured. Comparing shared vs. dedicated...\n');
    customConn = await mongoose.createConnection(customUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    const customModels = bindModels(customConn);

    let leakFound = false;
    const instanceIds = [];
    const templateIds = [];

    console.log('COLLECTION'.padEnd(16), 'SHARED'.padEnd(8), 'DEDICATED'.padEnd(10), 'VERDICT');
    console.log('-'.repeat(60));

    for (const name of TENANT_SCOPED) {
      const sharedCount = await sharedModels[name].countDocuments({ tenantId });
      const customCount = await customModels[name].countDocuments({ tenantId });

      if (name === 'FmsInstance') {
        (await customModels[name].find({ tenantId }).select('_id').lean()).forEach(d => instanceIds.push(d._id));
        (await sharedModels[name].find({ tenantId }).select('_id').lean()).forEach(d => instanceIds.push(d._id));
      }
      if (name === 'FmsTemplate') {
        (await customModels[name].find({ tenantId }).select('_id').lean()).forEach(d => templateIds.push(d._id));
        (await sharedModels[name].find({ tenantId }).select('_id').lean()).forEach(d => templateIds.push(d._id));
      }

      let verdict = '✅ ok';
      if (sharedCount > 0) { verdict = '⚠️  LEAK — still in shared DB'; leakFound = true; }
      else if (customCount === 0) { verdict = 'ℹ️  no data yet'; }

      console.log(name.padEnd(16), String(sharedCount).padEnd(8), String(customCount).padEnd(10), verdict);
    }

    const sharedHistCount = await sharedModels.FmsHistory.countDocuments({
      $or: [{ instanceId: { $in: instanceIds } }, { templateId: { $in: templateIds } }],
    });
    const customHistCount = await customModels.FmsHistory.countDocuments({
      $or: [{ instanceId: { $in: instanceIds } }, { templateId: { $in: templateIds } }],
    });
    let histVerdict = sharedHistCount > 0 ? '⚠️  LEAK — still in shared DB' : '✅ ok';
    if (sharedHistCount > 0) leakFound = true;
    console.log('FmsHistory'.padEnd(16), String(sharedHistCount).padEnd(8), String(customHistCount).padEnd(10), histVerdict + '  (linked via instance/template id)');

    console.log('-'.repeat(60));
    for (const name of PLATFORM_OWNED) {
      const c = await sharedModels[name].countDocuments({ tenantId });
      console.log(name.padEnd(16), String(c).padEnd(8), '  n/a'.padEnd(10), 'ℹ️  platform-owned, not migrated by design');
    }

    console.log('\n' + (leakFound
      ? '⚠️  RESULT: This tenant is NOT fully isolated. Some data is still readable/writable from the shared DB.'
      : '✅ RESULT: All tenant-scoped data is isolated to the dedicated DB.'));

    process.exit(leakFound ? 1 : 0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    if (sharedConn) await sharedConn.close();
    if (customConn) await customConn.close();
  }
})();
