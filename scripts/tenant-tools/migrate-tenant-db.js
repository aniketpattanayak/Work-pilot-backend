require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');

const tenantId = process.argv[2];
const CONFIRM = process.argv.includes('--confirm');

if (!tenantId) {
  console.error('Usage: node scripts/tenant-tools/migrate-tenant-db.js <tenantId> [--confirm]');
  process.exit(1);
}

const TENANT_SCOPED = [
  'Employee', 'DelegationTask', 'ChecklistTask', 'FlowInstance', 'FlowTemplate',
  'Conversation', 'Message', 'OrderForm', 'OrderSubmission', 'Ticket',
  'FmsTemplate', 'FmsInstance', 'FmsSheetData',
];

function bindModels(conn) {
  const models = {};
  for (const name of [...TENANT_SCOPED, 'FmsHistory']) {
    const schema = require(`../../models/${name}`).schema;
    models[name] = conn.models[name] || conn.model(name, schema);
  }
  return models;
}

async function copyCollection(name, sourceModel, targetModel, filter) {
  const docs = await sourceModel.find(filter).lean();
  if (docs.length === 0) {
    console.log(`  ${name.padEnd(16)} 0 documents to migrate`);
    return;
  }
  const existingIds = new Set(
    (await targetModel.find({ _id: { $in: docs.map(d => d._id) } }).select('_id').lean())
      .map(d => d._id.toString())
  );
  const toInsert = docs.filter(d => !existingIds.has(d._id.toString()));
  console.log(`  ${name.padEnd(16)} ${docs.length} found, ${existingIds.size} already at destination, ${toInsert.length} to insert${CONFIRM ? '' : '  [DRY RUN — not writing]'}`);
  if (CONFIRM && toInsert.length > 0) {
    await targetModel.insertMany(toInsert, { ordered: false });
  }
}

(async () => {
  let sharedConn, targetConn;
  try {
    sharedConn = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
    const SharedTenant = sharedConn.models.Tenant || sharedConn.model('Tenant', Tenant.schema);
    const tenant = await SharedTenant.findById(tenantId).lean();
    if (!tenant) throw new Error(`No tenant found with id ${tenantId}`);

    const targetUri = tenant.superAdmin?.customMongoUri;
    if (!targetUri) throw new Error(`Tenant "${tenant.companyName}" has no customMongoUri set.`);

    console.log(`Tenant:  ${tenant.companyName} (${tenant.subdomain})`);
    console.log(`Mode:    ${CONFIRM ? '⚠️  LIVE — will write to the dedicated DB' : 'DRY RUN — no writes will happen'}\n`);

    targetConn = await mongoose.createConnection(targetUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    const sharedModels = bindModels(sharedConn);
    const targetModels = bindModels(targetConn);

    console.log('Migrating tenant-scoped collections (shared → dedicated, additive only):');
    const instanceIds = [], templateIds = [];
    for (const name of TENANT_SCOPED) {
      await copyCollection(name, sharedModels[name], targetModels[name], { tenantId });
      if (name === 'FmsInstance' || name === 'FmsTemplate') {
        const docs = await sharedModels[name].find({ tenantId }).select('_id').lean();
        (name === 'FmsInstance' ? instanceIds : templateIds).push(...docs.map(d => d._id));
      }
    }
    await copyCollection('FmsHistory', sharedModels.FmsHistory, targetModels.FmsHistory,
      { $or: [{ instanceId: { $in: instanceIds } }, { templateId: { $in: templateIds } }] });

    console.log('\nSOURCE DATA WAS NOT TOUCHED in the shared DB — this only copies, never deletes.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    if (sharedConn) await sharedConn.close();
    if (targetConn) await targetConn.close();
  }
})();
