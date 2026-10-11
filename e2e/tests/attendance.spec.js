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

// Attendance punching needs real browser geolocation permission and, if face-check is
// enabled for this tenant, a live camera too — neither is safe to script blind, so this
// is a smoke test only: it confirms the real page loads and its real "Punch" control
// renders (verified against AttendancePage.jsx: aria-label="Punch"), rather than
// guessing at the full punch flow.
test('attendance page loads and shows the punch control', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/attendance');

  // The page header banner also says "Attendance", so scope to the main content heading.
  await expect(page.getByRole('main').getByRole('heading', { name: 'Attendance' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Punch' })).toBeVisible({ timeout: 8000 });
});
