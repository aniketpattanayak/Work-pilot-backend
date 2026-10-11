// Production variant of global-setup.js. Creates (or reuses) a single, clearly-labelled
// test tenant on the REAL backend (PROD_API_BASE) — "zzz-playwright-test" — switches on
// Attendance + Leave for it, and seeds a leave type. Idempotent: safe to run repeatedly,
// never creates a second tenant. A fixed subdomain (rather than one unique per run) is
// required because Playwright's baseURL is static in playwright.config.prod.js.
const API_BASE = process.env.PROD_API_BASE; // e.g. https://api.lrbcloud.ai/api
const SUPERADMIN_USER = process.env.PROD_SUPERADMIN_USER;
const SUPERADMIN_PASS = process.env.PROD_SUPERADMIN_PASS;

const SUBDOMAIN = 'zzz-playwright-test';
const COMPANY_NAME = 'ZZZ AUTOMATED TEST - DO NOT USE';
const ADMIN_EMAIL = 'zzz-autotest@workpilot-test.invalid';
const ADMIN_PASSWORD = 'AutoTestProd!2026';

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

module.exports = async () => {
  if (!API_BASE || !SUPERADMIN_USER || !SUPERADMIN_PASS) {
    throw new Error('[global-setup.prod] PROD_API_BASE / PROD_SUPERADMIN_USER / PROD_SUPERADMIN_PASS must be set as repo secrets.');
  }

  const superRes = await fetch(`${API_BASE}/tenants/master-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: SUPERADMIN_USER, password: SUPERADMIN_PASS }),
  });
  if (!superRes.ok) {
    throw new Error(`[global-setup.prod] Super admin login failed (${superRes.status}). Check the PROD_SUPERADMIN_* secrets.`);
  }
  const { token: superToken } = await json(superRes);

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
    // Already exists from a previous run — look it up and resume it in case a previous
    // run's teardown paused it.
    const verifyRes = await fetch(`${API_BASE}/tenants/verify/${SUBDOMAIN}`);
    const verifyData = await json(verifyRes);
    tenantId = verifyData?.id;
    if (!tenantId) {
      throw new Error(`[global-setup.prod] Could not create or find "${SUBDOMAIN}": ${createData.message || createData.raw}`);
    }
    await fetch(`${API_BASE}/superadmin/tenants/${tenantId}/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superToken}` },
    });
  }

  await fetch(`${API_BASE}/tenants/access/modules/${tenantId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ modules: { attendance: true, leave: true } }),
  });

  const loginRes = await fetch(`${API_BASE}/tasks/login-employee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, subdomain: SUBDOMAIN }),
  });
  if (!loginRes.ok) throw new Error(`[global-setup.prod] Tenant admin login failed (${loginRes.status}).`);
  const { token: adminToken } = await json(loginRes);

  const typesRes = await fetch(`${API_BASE}/tasks/leave/types`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const typesData = await json(typesRes);
  const hasType = Array.isArray(typesData.types) && typesData.types.length > 0;
  if (!hasType) {
    await fetch(`${API_BASE}/tasks/leave/types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Casual Leave', paid: true, annualQuota: 12 }),
    });
  }
};
