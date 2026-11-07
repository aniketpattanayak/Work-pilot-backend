/**
 * Removes EXACTLY the records listed in a manifest file written by seed.js. Nothing else is touched.
 *
 *   node scripts/lrbc-demo/undo.js lrbc-demo-manifest-XXXX.json           shows what would be removed (no changes)
 *   node scripts/lrbc-demo/undo.js lrbc-demo-manifest-XXXX.json --run     removes it
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

const file = process.argv[2];
const RUN = process.argv.includes('--run');
if (!file || file.startsWith('--') || !fs.existsSync(file)) { console.log('Give the manifest file name, e.g.  node scripts/lrbc-demo/undo.js lrbc-demo-manifest-2026-11-08T10-00-00-000Z.json'); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const modelOf = { employees: 'Employee', delegationtasks: 'DelegationTask', checklisttasks: 'ChecklistTask', leavetypes: 'LeaveType', leaverequests: 'LeaveRequest', leaveadjustments: 'LeaveAdjustment', shifts: 'Shift', attendanceassignments: 'AttendanceAssignment', punches: 'Punch', regularizations: 'Regularization', supporttickets: 'Ticket', personaltasks: 'PersonalTask', plans: 'Plan', conversations: 'Conversation', messages: 'Message', flowinstances: 'FlowInstance', ordersubmissions: 'OrderSubmission' };

(async () => {
  if (!process.env.MONGO_URI) { console.log('MONGO_URI is not set. Run this inside the backend folder on the server.'); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const Tenant = require('../../models/Tenant');
  const tenant = await Tenant.findById(manifest.tenantId).lean();
  if (!tenant) { console.log('The company in this manifest was not found.'); process.exit(1); }
  const conn = tenant.superAdmin && tenant.superAdmin.customMongoUri ? await mongoose.createConnection(tenant.superAdmin.customMongoUri, { serverSelectionTimeoutMS: 8000 }).asPromise() : mongoose.connection;
  const tid = new mongoose.Types.ObjectId(manifest.tenantId);
  console.log(`Company: ${tenant.companyName}   ${RUN ? 'REMOVING' : 'CHECK ONLY (add --run to remove)'}`);
  // children first, employees last
  const order = ['messages', 'conversations', 'ordersubmissions', 'flowinstances', 'plans', 'personaltasks', 'supporttickets', 'regularizations', 'punches', 'leaveadjustments', 'leaverequests', 'checklisttasks', 'delegationtasks', 'attendanceassignments', 'shifts', 'leavetypes', 'employees'];
  for (const col of order) {
    const ids = (manifest.collections[col] || []).map((x) => new mongoose.Types.ObjectId(x)); if (!ids.length) continue;
    const base = require(`../../models/${modelOf[col]}`);
    const Model = conn.models[base.modelName] || conn.model(base.modelName, base.schema);
    if (Model.collection.name !== col) throw new Error(`Collection mismatch: ${Model.collection.name} vs ${col}`);
    const filter = { _id: { $in: ids }, tenantId: tid };
    const n = await Model.collection.countDocuments(filter);
    if (RUN) { const r = await Model.collection.deleteMany(filter); console.log(`  ${col}: removed ${r.deletedCount} of ${ids.length}`); } else console.log(`  ${col}: ${n} of ${ids.length} found`);
  }
  const la = manifest.tenantListsAdded || {};
  if (RUN && ((la.locations || []).length || (la.sectors || []).length)) { await Tenant.updateOne({ _id: tid }, { $pull: { locations: { $in: la.locations || [] }, sectors: { $in: la.sectors || [] } } }); console.log('  Settings lists: removed the names that were added'); }
  if (RUN) for (const f of manifest.files || []) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  console.log(RUN ? 'Done. Demo data removed.' : 'Nothing was changed.');
  process.exit(0);
})().catch((e) => { console.log('Failed:', e.message); process.exit(1); });
