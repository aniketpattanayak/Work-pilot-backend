const { test, expect } = require('@playwright/test');

const EMAIL = process.env.E2E_EMAIL || 'qa-admin@workpilot-test.com';
const PASSWORD = process.env.E2E_PASSWORD || 'TestPass123!';

test('login with real credentials reaches the dashboard', async ({ page }) => {
  await page.goto('/');

  // Login.jsx: email input has no name/id, matched by placeholder
  await page.getByPlaceholder('name@factory.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /Authorize Terminal/i }).click();

  // handleLogin navigates to /dashboard on success
  await page.waitForURL('**/dashboard', { timeout: 10_000 });
  await expect(page).toHaveURL(/dashboard/);
});

test('wrong password shows an error, does not log in', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('name@factory.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill('definitely-wrong-password');

  // Login.jsx uses a native alert() on failure — capture it
  let alertMessage = null;
  page.once('dialog', async (dialog) => {
    alertMessage = dialog.message();
    await dialog.accept();
  });

  await page.getByRole('button', { name: /Authorize Terminal/i }).click();
  await page.waitForTimeout(1500);

  expect(alertMessage).toBeTruthy();
  await expect(page).not.toHaveURL(/dashboard/);
});
