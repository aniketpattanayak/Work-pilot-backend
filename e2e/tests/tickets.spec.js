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

// Verified against RaiseTicket.jsx: form is a popup opened via "Raise New Ticket",
// fields are Subject (placeholder "Short title of the problem"), Description
// (placeholder "Tell us what went wrong, and where…"), Priority + Category selects,
// submit button text is "Send ticket" (shows "Sending…" while busy), success is a
// dialog.alert "Your ticket has been sent to support."
test('raise a support ticket and see it in My Tickets', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/raise-ticket');

  await page.getByRole('button', { name: /Raise New Ticket/i }).click();

  const uniqueTitle = `Playwright test ticket ${Date.now()}`;
  await page.getByPlaceholder('Short title of the problem').fill(uniqueTitle);
  await page.getByPlaceholder(/Tell us what went wrong/i).fill('Automated end-to-end test: the office printer on the 2nd floor is jammed.');

  // Priority select has a real default ("Medium"); Category defaults to "Technical".
  // Leave defaults as-is — only required fields are Subject + Description per handleSubmit.

  await page.getByRole('button', { name: /Send ticket/i }).click();

  // dialog.alert renders a custom <DialogHost /> popup (verified in components/Dialog.jsx),
  // not a native alert. Its confirm button text is exactly "OK".
  await expect(page.getByText('Your ticket has been sent to support.')).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'OK' }).click();

  // The new ticket should now show up in the "My Tickets" table.
  await expect(page.getByText(uniqueTitle)).toBeVisible({ timeout: 8000 });
});
