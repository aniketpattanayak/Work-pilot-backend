// @ts-check
// Points the SAME test specs at the real lrbcloud.ai production site, using the
// "zzz-playwright-test" tenant that global-setup.prod.js creates/reuses. Only ever run
// via workflow_dispatch (see .github/workflows/e2e-prod.yml) — never on a push.
const { defineConfig, devices } = require('@playwright/test');

const PROD_SUBDOMAIN = 'zzz-playwright-test';
const PROD_DOMAIN = process.env.PROD_FRONTEND_DOMAIN || 'lrbcloud.ai';

module.exports = defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup.prod.js'),
  timeout: 30_000,
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'playwright-report/results.json' }]],
  use: {
    baseURL: `https://${PROD_SUBDOMAIN}.${PROD_DOMAIN}`,
    headless: true,
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
