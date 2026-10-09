const fs = require('fs');
const path = require('path');

function patch(filePath, oldText, newText, label) {
  const full = path.resolve(filePath);
  const content = fs.readFileSync(full, 'utf8');
  const count = content.split(oldText).length - 1;
  if (count !== 1) {
    console.error(`❌ [${label}] Expected exactly 1 match, found ${count}. Aborting — no changes written.`);
    process.exit(1);
  }
  fs.writeFileSync(full, content.replace(oldText, newText), 'utf8');
  console.log(`✅ [${label}] Patched.`);
}

const file = path.join(__dirname, '../../controllers/tenantController.js');

patch(
  file,
  `const { notifyTenant } = require('../utils/notify');`,
  `const { notifyTenant } = require('../utils/notify');\nconst { getModels: getTenantModels } = require('../utils/getModels');`,
  'import getTenantModels'
);

const oldLogin = `exports.loginEmployee = async (req, res) => {
  try {
    const { Tenant, Employee, DelegationTask, ChecklistTask } = getModels(req);
    const { email, password, subdomain } = req.body;

    // 1. Find the Factory/Tenant by subdomain
    const tenant = await Tenant.findOne({ subdomain });
    if (!tenant) return res.status(404).json({ message: "Factory not found." });

    // 1b. Block login if subscription is paused
    if (tenant.subscription?.status === 'paused') {
      return res.status(403).json({
        code:     'SUBSCRIPTION_PAUSED',
        message:  'Your company subscription is currently paused.',
        reason:   tenant.subscription.reason || 'Contact your administrator.',
        pausedAt: tenant.subscription.pausedAt,
      });
    }

    // 2. Find the Employee within that specific Factory
    const employee = await Employee.findOne({ email, tenantId: tenant._id });
    if (!employee) return res.status(401).json({ message: "Invalid Credentials." });`;

const newLogin = `exports.loginEmployee = async (req, res) => {
  try {
    const { Tenant, DelegationTask, ChecklistTask } = getModels(req);
    const { email, password, subdomain } = req.body;

    // 1. Find the Factory/Tenant by subdomain
    const tenant = await Tenant.findOne({ subdomain });
    if (!tenant) return res.status(404).json({ message: "Factory not found." });

    // 1b. Block login if subscription is paused
    if (tenant.subscription?.status === 'paused') {
      return res.status(403).json({
        code:     'SUBSCRIPTION_PAUSED',
        message:  'Your company subscription is currently paused.',
        reason:   tenant.subscription.reason || 'Contact your administrator.',
        pausedAt: tenant.subscription.pausedAt,
      });
    }

    // 2. Find the Employee. Login runs BEFORE the auth/tenantDb middleware,
    // so req.db is never set here — a tenant with their own dedicated DB
    // (customMongoUri) must be looked up explicitly, or anyone added via
    // Add Employee AFTER the DB split (they're created straight into the
    // tenant's own DB now) can never log in even though their account is
    // real. Check the tenant's own DB first, then fall back to the shared
    // DB (covers the original bootstrap admin account, which still only
    // lives there).
    const customUri = tenant.superAdmin?.customMongoUri || null;
    let employee = null;
    try {
      const { Employee: TenantEmployee } = await getTenantModels(tenant._id.toString(), customUri);
      employee = await TenantEmployee.findOne({ email, tenantId: tenant._id });
    } catch (e) {
      console.error('[loginEmployee] Tenant DB employee lookup failed:', e.message);
    }
    if (!employee && customUri) {
      employee = await Employee.findOne({ email, tenantId: tenant._id });
    }
    if (!employee) return res.status(401).json({ message: "Invalid Credentials." });`;

patch(file, oldLogin, newLogin, 'loginEmployee tenant-DB lookup');
