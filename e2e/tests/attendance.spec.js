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

// Verified against AttendancePage.jsx: punch() only asks for geolocation when the
// tenant has attendance sites configured, and only asks for a face scan when
// faceMode !== 'off' and the person has an approved face. A freshly created test
// tenant has neither, so punching in/out is a plain API call with no browser
// permissions needed — this exercises the real punch flow end to end.
test('punch in records a punch for today', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/attendance');

  await expect(page.getByRole('main').getByRole('heading', { name: 'Attendance' })).toBeVisible();

  const punchButton = page.getByRole('button', { name: 'Punch' });
  await expect(punchButton).toBeVisible({ timeout: 8000 });

  await punchButton.click();

  // send() shows a success notice with role="status" ("Punched in." / similar), or if the
  // backend asks for a reason (409 NEEDS_REASON) an inline "A manager needs to check this
  // punch" panel appears instead. Any other failure (e.g. a minimum-gap-between-punches
  // rule) surfaces as a role="dialog" alert instead — surface its message directly rather
  // than timing out blind.
  const notice = page.getByRole('status');
  const reasonPanel = page.getByText('A manager needs to check this punch');
  const errorDialog = page.getByRole('dialog');
  await expect(notice.or(reasonPanel).or(errorDialog)).toBeVisible({ timeout: 8000 });

  if (await errorDialog.isVisible()) {
    const message = await errorDialog.innerText();
    // A reused test tenant punched very recently (e.g. the previous CI run a minute ago)
    // legitimately gets rate-limited by the backend ("wait a minute before punching
    // again") — that's the app correctly enforcing a real rule, not a bug, so treat it as
    // an acceptable outcome here rather than failing the whole suite over test cadence.
    if (/wait a minute/i.test(message)) {
      await page.getByRole('button', { name: 'OK' }).click();
      test.skip(true, `Punch was rate-limited by a very recent previous run: ${message}`);
    }
    throw new Error(`Punch failed: ${message}`);
  }

  if (await reasonPanel.isVisible()) {
    await page.getByLabel('Reason').fill('Playwright automated test punch');
    await page.getByRole('button', { name: /Punch with reason/i }).click();
    await expect(page.getByRole('status')).toBeVisible({ timeout: 8000 });
  }

  // The punch should now show up in "Today's punches".
  await expect(page.getByText(/^(In|Out) at \d{2}:\d{2}/)).toBeVisible({ timeout: 8000 });
});
