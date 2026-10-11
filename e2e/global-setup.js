// Runs automatically before every test run (locally or in CI). Fully self-contained:
// creates the test tenant from scratch against a fresh database, switches on the
// Attendance + Leave modules, and creates a default leave type. Nothing manual.
const API_BASE = process.env.E2E_API_BASE || 'http://localhost:5001/api';
const SUBDOMAIN = 'wp-qa-test';
const COMPANY_NAME = 'WorkPilot QA';
const ADMIN_EMAIL = 'qa-admin@workpilot-test.com';
const ADMIN_PASSWORD = 'TestPass123!';
const SUPERADMIN_USER = process.env.SUPERADMIN_USER || 'admin_lalit';
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASS || 'Lalit@WorkPilot2026';

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

module.exports = async () => {
  // 1. Super admin login.
  const superRes = await fetch(`${API_BASE}/tenants/master-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: SUPERADMIN_USER, password: SUPERADMIN_PASS }),
  });
  if (!superRes.ok) {
    throw new Error(`[global-setup] Super admin login failed (${superRes.status}) — is the backend up on ${API_BASE}?`);
  }
  const { token: superToken } = await json(superRes);

  // 2. Create the test tenant if it doesn't already exist (ignore "already exists" errors).
  const form = new FormData();
  form.append('companyName', COMPANY_NAME);
  form.append('subdomain', SUBDOMAIN);
  form.append('ownerEmail', ADMIN_EMAIL);
  form.append('adminPassword', ADMIN_PASSWORD);
  const createRes = await fetch(`${API_BASE}/tenants/create-company`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${superToken}` },
    body: form,
  });
  const createData = await json(createRes);
  let tenantId = createData?.tenant?._id;

  if (!createRes.ok) {
    // Tenant likely already exists from a previous run — look it up instead.
    const verifyRes = await fetch(`${API_BASE}/tenants/verify/${SUBDOMAIN}`);
    const verifyData = await json(verifyRes);
    tenantId = verifyData?.id || verifyData?.tenant?._id;
    if (!tenantId) {
      throw new Error(`[global-setup] Could not create or find the "${SUBDOMAIN}" tenant: ${createData.message || createData.raw}`);
    }
  }

  // 3. Switch on Attendance + Leave modules (idempotent).
  await fetch(`${API_BASE}/tenants/access/modules/${tenantId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ modules: { attendance: true, leave: true } }),
  });

  // 4. Log in as the tenant admin, then make sure at least one leave type exists.
  const loginRes = await fetch(`${API_BASE}/tasks/login-employee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, subdomain: SUBDOMAIN }),
  });
  if (!loginRes.ok) {
    throw new Error(`[global-setup] Tenant admin login failed (${loginRes.status}) after tenant setup.`);
  }
  const { token: adminToken } = await json(loginRes);

  const typesRes = await fetch(`${API_BASE}/tasks/leave/types`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const typesData = await json(typesRes);
  const hasType = Array.isArray(typesData.types) && typesData.types.length > 0;

  if (!hasType) {
    const typeRes = await fetch(`${API_BASE}/tasks/leave/types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Casual Leave', paid: true, annualQuota: 12 }),
    });
    if (!typeRes.ok) {
      const err = await json(typeRes);
      console.warn('[global-setup] Could not create default leave type:', err.message || err.raw);
    }
  }
};
