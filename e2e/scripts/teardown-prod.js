// Pauses the zzz-playwright-test tenant after a production run, win or lose. There's no
// delete-tenant endpoint in this backend, so "pause" (subscription.status = paused,
// redirects to /suspended, excluded from normal dashboards) is the closest thing to
// cleanup available without a code change. global-setup.prod.js resumes it again at the
// start of the next run.
const API_BASE = process.env.PROD_API_BASE;
const SUPERADMIN_USER = process.env.PROD_SUPERADMIN_USER;
const SUPERADMIN_PASS = process.env.PROD_SUPERADMIN_PASS;
const SUBDOMAIN = 'zzz-playwright-test';

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

(async () => {
  if (!API_BASE || !SUPERADMIN_USER || !SUPERADMIN_PASS) {
    console.warn('[teardown-prod] Missing PROD_* secrets, skipping pause.');
    return;
  }
  try {
    const superRes = await fetch(`${API_BASE}/tenants/master-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: SUPERADMIN_USER, password: SUPERADMIN_PASS }),
    });
    if (!superRes.ok) { console.warn('[teardown-prod] Super admin login failed, cannot pause test tenant.'); return; }
    const { token } = await json(superRes);

    const verifyRes = await fetch(`${API_BASE}/tenants/verify/${SUBDOMAIN}`);
    const verifyData = await json(verifyRes);
    const tenantId = verifyData?.id;
    if (!tenantId) { console.warn('[teardown-prod] Could not find test tenant to pause.'); return; }

    const pauseRes = await fetch(`${API_BASE}/superadmin/tenants/${tenantId}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: 'Paused automatically between Playwright test runs' }),
    });
    console.log(pauseRes.ok ? '[teardown-prod] Test tenant paused.' : '[teardown-prod] Pause call failed: ' + pauseRes.status);
  } catch (e) {
    console.warn('[teardown-prod] Error during teardown:', e.message);
  }
})();
