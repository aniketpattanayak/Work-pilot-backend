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

const fs = require('fs');
const path = require('path');
const logPath = path.join(__dirname, 'setup-prod.log');
fs.writeFileSync(logPath, ''); // fresh log every run
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
};

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
  log('Super admin login OK');

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
  log('create-company:', createRes.status, createRes.ok, JSON.stringify(createData));

  if (!createRes.ok) {
    // Already exists from a previous run — look it up and resume it in case a previous
    // run's teardown paused it.
    const verifyRes = await fetch(`${API_BASE}/tenants/verify/${SUBDOMAIN}`);
    const verifyData = await json(verifyRes);
    tenantId = verifyData?.id;
    log('verify:', verifyRes.status, JSON.stringify(verifyData));
    if (!tenantId) {
      throw new Error(`[global-setup.prod] Could not create or find "${SUBDOMAIN}": ${createData.message || createData.raw}`);
    }
    const resumeRes = await fetch(`${API_BASE}/superadmin/tenants/${tenantId}/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superToken}` },
    });
    log('resume:', resumeRes.status);
  }
  log('tenantId:', tenantId);

  const modulesRes = await fetch(`${API_BASE}/tenants/access/modules/${tenantId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ modules: { attendance: true, leave: true } }),
  });
  const modulesBody = await modulesRes.text();
  log('set-modules:', modulesRes.status, modulesBody);
  if (!modulesRes.ok) {
    throw new Error(`[global-setup.prod] Enabling attendance/leave modules failed (${modulesRes.status}): ${modulesBody}`);
  }

  const loginRes = await fetch(`${API_BASE}/tasks/login-employee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, subdomain: SUBDOMAIN }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.text();
    log('tenant-admin-login FAILED:', loginRes.status, body);
    throw new Error(`[global-setup.prod] Tenant admin login failed (${loginRes.status}): ${body}`);
  }
  const { token: adminToken } = await json(loginRes);
  log('tenant admin login OK');

  const typesRes = await fetch(`${API_BASE}/tasks/leave/types`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const typesRaw = await typesRes.text();
  log('GET leave/types (before):', typesRes.status, typesRaw);
  if (!typesRes.ok) {
    throw new Error(`[global-setup.prod] Fetching existing leave types failed (${typesRes.status}): ${typesRaw}`);
  }
  let typesData; try { typesData = JSON.parse(typesRaw); } catch { typesData = {}; }
  const hasType = Array.isArray(typesData.types) && typesData.types.length > 0;
  if (!hasType) {
    const createTypeRes = await fetch(`${API_BASE}/tasks/leave/types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Casual Leave', paid: true, annualQuota: 12 }),
    });
    const createTypeBody = await createTypeRes.text();
    log('POST leave/types:', createTypeRes.status, createTypeBody);
    if (!createTypeRes.ok) {
      throw new Error(`[global-setup.prod] Creating "Casual Leave" leave type failed (${createTypeRes.status}): ${createTypeBody}`);
    }

    // Verify it actually shows up in a fresh GET — catches the case where the create call
    // reports success but the type doesn't land where the UI's own GET looks for it.
    const verifyTypesRes = await fetch(`${API_BASE}/tasks/leave/types`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const verifyTypesRaw = await verifyTypesRes.text();
    log('GET leave/types (after create):', verifyTypesRes.status, verifyTypesRaw);
    let verifyTypesData; try { verifyTypesData = JSON.parse(verifyTypesRaw); } catch { verifyTypesData = {}; }
    const nowHasType = Array.isArray(verifyTypesData.types) && verifyTypesData.types.length > 0;
    if (!nowHasType) {
      throw new Error(`[global-setup.prod] Created a leave type (${createTypeRes.status}) but a follow-up GET /tasks/leave/types still shows none. Raw create response: ${createTypeBody}. Raw follow-up GET: ${verifyTypesRaw}`);
    }
  }
  log('setup complete, tenantId=' + tenantId);
};
