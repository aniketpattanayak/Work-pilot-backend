// Setup for testing the REAL "ARV Companies" tenant (arv.lrbcloud.ai) — NOT a throwaway
// test tenant. This only touches what's needed to make Aniket's existing "Developer" role
// actually take effect (switching on Attendance/Leave/Payroll, which only a superadmin can
// do) and seeds one leave type if none exists yet, since the apply-leave flow can't be
// exercised without one. It never creates, deletes, or resumes/pauses the tenant itself,
// and never touches any employee other than the one ARV_ADMIN_EMAIL points at.
const fs = require('fs');
const path = require('path');
const logPath = path.join(__dirname, 'setup-arv.log');
fs.writeFileSync(logPath, '');
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
};

const API_BASE = process.env.PROD_API_BASE;
const SUPERADMIN_USER = process.env.PROD_SUPERADMIN_USER;
const SUPERADMIN_PASS = process.env.PROD_SUPERADMIN_PASS;
const ARV_EMAIL = process.env.ARV_ADMIN_EMAIL;
const ARV_PASSWORD = process.env.ARV_ADMIN_PASSWORD;
const SUBDOMAIN = 'arv';

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

module.exports = async () => {
  if (!API_BASE || !SUPERADMIN_USER || !SUPERADMIN_PASS) {
    throw new Error('[global-setup.arv] PROD_API_BASE / PROD_SUPERADMIN_USER / PROD_SUPERADMIN_PASS must be set as repo secrets.');
  }
  if (!ARV_EMAIL || !ARV_PASSWORD) {
    throw new Error('[global-setup.arv] ARV_ADMIN_EMAIL / ARV_ADMIN_PASSWORD must be set as repo secrets.');
  }

  const superRes = await fetch(`${API_BASE}/tenants/master-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: SUPERADMIN_USER, password: SUPERADMIN_PASS }),
  });
  if (!superRes.ok) throw new Error(`[global-setup.arv] Super admin login failed (${superRes.status}).`);
  const { token: superToken } = await json(superRes);
  log('Super admin login OK');

  const verifyRes = await fetch(`${API_BASE}/tenants/verify/${SUBDOMAIN}`);
  const verifyRaw = await verifyRes.text();
  log('verify arv:', verifyRes.status, verifyRaw);
  if (!verifyRes.ok) throw new Error(`[global-setup.arv] Could not find tenant "${SUBDOMAIN}": ${verifyRaw}`);
  const verifyData = JSON.parse(verifyRaw);
  const tenantId = verifyData.id;
  log('ARV tenantId:', tenantId, 'companyName:', verifyData.companyName);

  const modulesRes = await fetch(`${API_BASE}/tenants/access/modules/${tenantId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ modules: { attendance: true, leave: true, payroll: true } }),
  });
  const modulesBody = await modulesRes.text();
  log('set-modules:', modulesRes.status, modulesBody);
  if (!modulesRes.ok) throw new Error(`[global-setup.arv] Enabling modules failed (${modulesRes.status}): ${modulesBody}`);

  const loginRes = await fetch(`${API_BASE}/tasks/login-employee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ARV_EMAIL, password: ARV_PASSWORD, subdomain: SUBDOMAIN }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.text();
    throw new Error(`[global-setup.arv] Aniket's login failed (${loginRes.status}): ${body}`);
  }
  const { token: adminToken } = await json(loginRes);
  log('Aniket login OK');

  const typesRes = await fetch(`${API_BASE}/tasks/leave/types`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const typesRaw = await typesRes.text();
  log('GET leave/types:', typesRes.status, typesRaw);
  if (!typesRes.ok) throw new Error(`[global-setup.arv] Fetching leave types failed (${typesRes.status}): ${typesRaw}`);
  const typesData = JSON.parse(typesRaw);
  const hasType = Array.isArray(typesData.types) && typesData.types.length > 0;
  if (!hasType) {
    const createTypeRes = await fetch(`${API_BASE}/tasks/leave/types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Casual Leave', paid: true, annualQuota: 12 }),
    });
    const createTypeBody = await createTypeRes.text();
    log('POST leave/types:', createTypeRes.status, createTypeBody);
    if (!createTypeRes.ok) throw new Error(`[global-setup.arv] Creating a leave type failed (${createTypeRes.status}): ${createTypeBody}`);
  }
  log('setup complete');
};
