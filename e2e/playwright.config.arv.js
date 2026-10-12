// @ts-check
// Tests the REAL "ARV Companies" tenant (arv.lrbcloud.ai), logged in as Aniket's real
// account, to confirm his "Developer" role (all 18 permissions) actually works now that
// the modules are switched on. This is production data — never run this against any
// tenant other than ARV, and never add any step here that touches another employee.
const { defineConfig, devices } = require('@playwright/test');

const DOMAIN = process.env.PROD_FRONTEND_DOMAIN || 'lrbcloud.ai';

module.exports = defineConfig({
  testDir: './tests-arv',
  globalSetup: require.resolve('./global-setup.arv.js'),
  timeout: 30_000,
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'playwright-report/results.json' }]],
  use: {
    baseURL: `https://arv.${DOMAIN}`,
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
