const { test, expect } = require('@playwright/test');

const EMAIL = 'qa-admin@workpilot-test.com';
const PASSWORD = 'TestPass123!';

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

  // Need at least one real leave type configured to pick from (option[1], since option[0] is "Choose...").
  const optionCount = await leaveTypeSelect.locator('option').count();
  if (optionCount < 2) {
    throw new Error('No leave types are configured for this tenant — set up a leave type first (Leave > Setup) before this test can apply for one.');
  }
  await leaveTypeSelect.selectOption({ index: 1 });

  const today = new Date();
  const fromDate = today.toISOString().slice(0, 10);
  await page.getByLabel('From date').fill(fromDate);

  const reasonText = `Playwright automated test ${Date.now()}`;
  await page.getByLabel('Reason').fill(reasonText);

  await page.getByRole('button', { name: /Send for approval/i }).click();

  // Success path shows a dialog.alert with "Sent" title and a message like
  // "Your request for N day(s) was sent for approval." — match on the stable substring.
  await expect(page.getByText(/was sent for approval\./i)).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'OK' }).click();

  // The new request should now appear under "My requests".
  await expect(page.getByText(reasonText)).toBeVisible({ timeout: 8000 });
});
