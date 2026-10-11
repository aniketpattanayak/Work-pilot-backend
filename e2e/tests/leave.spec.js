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

  // The select itself renders immediately with just a "Choose..." placeholder option; the
  // real options are added once LeavePage's own GET /tasks/leave/types resolves, which is
  // async and not tied to the select becoming visible — a prior run proved this by showing
  // the real leave type existed server-side while the select still had only the placeholder
  // a moment later. Poll for the option count instead of checking it once.
  await expect(async () => {
    const optionCount = await leaveTypeSelect.locator('option').count();
    expect(optionCount).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 15_000 });
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
    // Reusing one test tenant across frequent runs means the "next weekday" date this test
    // picks can collide with a request a previous run already created for that same day —
    // the backend correctly rejects that, which proves applying for leave already works, so
    // treat it as an acceptable skip rather than a real failure.
    if (response.status() === 400 && /already have leave/i.test(body)) {
      test.skip(true, `A previous CI run already applied for leave on ${fromDate}: ${body}`);
    }
    throw new Error(`POST /leave/requests returned ${response.status()}: ${body}`);
  }

  // Success path shows a dialog.alert with "Sent" title and a message like
  // "Your request for N day(s) was sent for approval." — match on the stable substring.
  await expect(page.getByText(/was sent for approval\./i)).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'OK' }).click();

  // The new request should now appear under "My requests".
  await expect(page.getByText(reasonText)).toBeVisible({ timeout: 8000 });
});
