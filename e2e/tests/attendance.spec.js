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
  // punch" panel appears instead. Either is a real, verifiable outcome — assert one of them.
  const notice = page.getByRole('status');
  const reasonPanel = page.getByText('A manager needs to check this punch');
  await expect(notice.or(reasonPanel)).toBeVisible({ timeout: 8000 });

  if (await reasonPanel.isVisible()) {
    await page.getByLabel('Reason').fill('Playwright automated test punch');
    await page.getByRole('button', { name: /Punch with reason/i }).click();
    await expect(page.getByRole('status')).toBeVisible({ timeout: 8000 });
  }

  // The punch should now show up in "Today's punches".
  await expect(page.getByText(/^(In|Out) at \d{2}:\d{2}/)).toBeVisible({ timeout: 8000 });
});
