const fs = require('fs');
const path = require('path');

function buildFlexRegex(oldStr) {
  return oldStr.split(/\s+/).filter(Boolean)
    .map(tok => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
}
function applyPatch(content, oldStr, newStr, label) {
  const src = buildFlexRegex(oldStr);
  const matches = content.match(new RegExp(src, 'g'));
  if (!matches || matches.length !== 1) {
    console.error('❌ [' + label + '] Expected exactly 1 match, found ' + (matches ? matches.length : 0) + '. Aborting — no changes written.');
    process.exit(1);
  }
  return content.replace(new RegExp(src), () => newStr);
}

const taskFile = path.join(__dirname, 'controllers', 'taskController.js');
const tenantFile = path.join(__dirname, 'controllers', 'tenantController.js');
let task = fs.readFileSync(taskFile, 'utf8');
let tenant = fs.readFileSync(tenantFile, 'utf8');

// T1 + T2: the company record (Tenant) always lives in the SHARED database.
// Dedicated databases (e.g. ARV) have an empty "tenants" collection, so looking it up there returned null.
task = applyPatch(task,
  "Tenant: safeModel(db, 'Tenant', require('../models/Tenant')),",
  "Tenant: require('../models/Tenant'), // company record always lives in the shared DB",
  'taskController: Tenant -> shared');
tenant = applyPatch(tenant,
  "Tenant: safeModel(db, 'Tenant', require('../models/Tenant')),",
  "Tenant: require('../models/Tenant'), // company record always lives in the shared DB",
  'tenantController: Tenant -> shared');

// T3: an Admin sees every delegation task in the company, others see only the tasks they assigned
task = applyPatch(task,
  "const tasks = await DelegationTask.find({ assignerId: assignerId })",
  [
    "const isAdminUser = Array.isArray(req.user?.roles) && req.user.roles.includes('Admin') && req.user?.tenantId;",
    "    const assignerFilter = isAdminUser ? { tenantId: req.user.tenantId } : { assignerId: assignerId };",
    "    const tasks = await DelegationTask.find(assignerFilter)"
  ].join('\n'),
  'getAssignerTasks: admin sees all');

fs.writeFileSync(taskFile, task);
fs.writeFileSync(tenantFile, tenant);
console.log('✅ 3 patches applied (taskController.js, tenantController.js)');
