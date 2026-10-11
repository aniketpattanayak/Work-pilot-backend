const { test, expect } = require('@playwright/test');

const EMAIL = process.env.E2E_EMAIL || 'qa-admin@workpilot-test.com';
const PASSWORD = process.env.E2E_PASSWORD || 'TestPass123!';

async function login(page) {
  await page.goto('/');
  await page.getByPlaceholder('name@factory.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /Authorize Terminal/i }).click();
  await page.waitForURL('**/dashboard', { timeout: 10_000 });
}

// Verified against LeavePage.jsx: the "My leave" tab shows an "Apply for leave" form with
// aria-labelled fields (Leave type, From date, To date, Day part, Reason, Buddy) and a
// submit button whose text is "Send for approval" (becomes "Sending..." while busy).
// NOTE: the "Apply for leave" form only renders if the logged-in user has the 'leave.apply'
// permission and the tenant has leave configured. If the test seed tenant's Admin user lacks
// that permission, the form won't exist — this test will fail clearly at the first `expect`,
// rather than silently skip, so a real permission/setup gap gets surfaced.
test('apply for leave and see the request listed', async ({ page }) => {
  // Capture what the browser's own GET /tasks/leave/types actually returns, so a mismatch
  // with what the setup script sees (checked server-side already) is diagnosable from the
  // error message alone — a previous run proved the backend genuinely has a type while the
  // UI's dropdown stayed empty, source unknown. Attached before navigating, since
  // LeavePage.jsx fires this request immediately on mount.
  let typesApiDebug = '(no /leave/types request observed)';
  const allRequests = [];
  page.on('request', (r) => { allRequests.push(`${r.method()} ${r.url()}`); });
  page.on('requestfinished', async (r) => {
    if (r.url().includes('leave/types') || r.url().includes('leave%2Ftypes')) {
      try {
        const res = await r.response();
        const body = res ? await res.text() : '(no response object)';
        typesApiDebug = `${r.method()} ${r.url()} -> ${res ? res.status() : '?'} body=${body}`;
      } catch (e) { typesApiDebug = `leave/types requestfinished read failed: ${e.message}`; }
    }
  });
  page.on('requestfailed', (r) => {
    if (r.url().includes('leave/types')) {
      typesApiDebug = `${r.method()} ${r.url()} FAILED: ${r.failure()?.errorText}`;
    }
  });

  await login(page);
  await page.goto('/dashboard/leave');

  // The page header banner also says "Leave", so scope to the main content heading.
  await expect(page.getByRole('main').getByRole('heading', { name: 'Leave' })).toBeVisible();

  // LeavePage.jsx computes its tabs from usePermissions(), which only resolves after an async
  // GET /tasks/access/me — on first render tabs is empty and nothing below renders at all. Wait
  // for the "My leave" tab itself first, so we're not racing that permissions fetch.
  await expect(page.getByRole('button', { name: 'My leave' })).toBeVisible({ timeout: 15_000 });

  const leaveTypeSelect = page.getByLabel('Leave type');
  await expect(leaveTypeSelect).toBeVisible({ timeout: 10_000 });

  // Need at least one real leave type configured to pick from (option[1], since option[0] is "Choose...").
  const optionCount = await leaveTypeSelect.locator('option').count();
  if (optionCount < 2) {
    const requestDump = allRequests.filter((u) => u.includes('/tasks/') || u.includes('/api/')).join('\n');
    throw new Error(`No leave types are configured for this tenant — set up a leave type first (Leave > Setup) before this test can apply for one. Browser's own API call: ${typesApiDebug}\nAll /tasks or /api requests made so far:\n${requestDump || '(none)'}`);
  }
  await leaveTypeSelect.selectOption({ index: 1 });

  // Pick the next Monday–Friday date, not just "today" — a prior run proved the backend
  // correctly rejects a weekly-off/holiday date ("These dates are all weekly offs or
  // holidays, so no leave is needed."), and today can land on a weekend.
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setDate(d.getDate() + 1);
  const fromDate = d.toISOString().slice(0, 10);
  await page.getByLabel('From date').fill(fromDate);

  const reasonText = `Playwright automated test ${Date.now()}`;
  await page.getByLabel('Reason').fill(reasonText);

  // Capture the actual API response so a failure here is diagnosable from the error
  // message alone (no video/screenshot access in this environment).
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/leave/requests') && r.request().method() === 'POST'),
    page.getByRole('button', { name: /Send for approval/i }).click(),
  ]);
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`POST /leave/requests returned ${response.status()}: ${body}`);
  }

  // Success path shows a dialog.alert with "Sent" title and a message like
  // "Your request for N day(s) was sent for approval." — match on the stable substring.
  await expect(page.getByText(/was sent for approval\./i)).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'OK' }).click();

  // The new request should now appear under "My requests".
  await expect(page.getByText(reasonText)).toBeVisible({ timeout: 8000 });
});
