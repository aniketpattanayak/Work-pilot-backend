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

// Verified against AccessRolesPanel.jsx (mounted on the "Roles and access" tab of
// Settings): creates a named role, ticks one permission (Payroll's "See salary details",
// since Payroll is marked sensitive — never auto-granted to Admin — making this the one
// screen where Admin itself can't reach a module without explicitly building a role for
// it), saves, confirms the role appears in the list, then deletes it again so reruns
// against the shared test tenant stay idempotent.
test('create a role with a payroll permission, then delete it', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/settings');

  await expect(page.getByRole('tab', { name: 'Roles and access' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('tab', { name: 'Roles and access' }).click();
  await expect(page.getByRole('heading', { name: 'Roles & access' })).toBeVisible({ timeout: 10_000 });

  const roleName = `Playwright Role ${Date.now()}`;

  await page.getByRole('button', { name: 'New role' }).click();
  await page.getByLabel('Role name').fill(roleName);
  await page.getByLabel('Payroll: See salary details').check();

  const [saveResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/access/roles') && r.request().method() === 'POST'),
    page.getByRole('button', { name: /Save role/i }).click(),
  ]);
  if (!saveResponse.ok()) {
    const body = await saveResponse.text();
    throw new Error(`POST /access/roles returned ${saveResponse.status()}: ${body}`);
  }

  // The panel re-fetches and re-renders the role list after a successful save.
  const roleRow = page.getByText(roleName, { exact: true });
  await expect(roleRow).toBeVisible({ timeout: 8000 });

  // Clean up so the shared production test tenant doesn't accumulate roles across runs.
  // Scope the confirm click to the dialog — the row's own "Delete <name>" button is still
  // in the DOM behind it and also matches a loose "Delete" name.
  await page.getByRole('button', { name: `Delete ${roleName}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(roleRow).not.toBeVisible({ timeout: 8000 });
});
