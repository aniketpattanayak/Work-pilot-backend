// Phase 4: real-browser UI walk of the AI assistant floating panel
// (frontend repo's src/components/AiAssistantPanel.jsx, mounted in Dashboard.jsx).
const { chromium } = require('playwright');
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('/tmp/ai-ui-tenant.json', 'utf8'));
const OUT = __dirname + '/ui-screens';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, cond, note) { results.push({ name, pass: !!cond, note }); console.log(cond ? 'PASS' : 'FAIL', '-', name, note || ''); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });

  async function loginAs(page) {
    await page.goto(`http://${state.sub}.localhost:5173/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"], input[name="email"]', `admin@${state.sub}.test`).catch(() => {});
    await page.fill('input[type="password"], input[name="password"]', 'TestPass123!').catch(() => {});
    await page.click('button[type="submit"]').catch(() => {});
    await page.waitForTimeout(2000);
  }

  // --- Desktop ---
  let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page = await ctx.newPage();
  const errors1 = [];
  page.on('pageerror', (e) => errors1.push(e.message));
  await loginAs(page);
  check('Desktop: login reached the dashboard (no console errors from the new component breaking the page)', !page.url().includes('/login') && errors1.length === 0, { url: page.url(), errors: errors1 });

  const launcher = page.locator('button[aria-label="Open AI assistant"]');
  const launcherVisible = await launcher.isVisible().catch(() => false);
  check('Desktop: the AI assistant launcher button renders', launcherVisible, {});
  if (!launcherVisible) await page.screenshot({ path: `${OUT}/01-launcher-missing.png`, fullPage: true });

  if (launcherVisible) {
    await launcher.click();
    await page.waitForTimeout(500);
    const panelVisible = await page.locator('text=WorkPilot Assistant').isVisible().catch(() => false);
    check('Desktop: clicking the launcher opens the chat panel', panelVisible, {});
    await page.screenshot({ path: `${OUT}/02-panel-open.png` });

    // Send a message - no ANTHROPIC_API_KEY is configured in this sandbox, so the
    // backend is expected to degrade gracefully (503 AI_SERVICE_DOWN) rather than
    // crash or hang - exactly the scenario AI_ASSISTANT_REPORT.md documents. This
    // confirms the FRONTEND handles that real backend response correctly.
    const textbox = page.locator('textarea');
    await textbox.fill('Hello, can you list my tasks?');
    await page.locator('button[aria-label="Send"]').click();
    await page.waitForTimeout(2000);
    const degradedMsgShown = await page.locator('text=/isn\'t available|not available|trouble|try again/i').first().isVisible().catch(() => false);
    check('Desktop: sending a message with no model configured shows the graceful-degradation message in the UI, not a crash', degradedMsgShown, {});
    await page.screenshot({ path: `${OUT}/03-degraded-message.png` });

    // Mic button presence (Web Speech API availability depends on the headless
    // browser build; what matters is the UI never crashes either way).
    const micVisible = await page.locator('button[aria-label="Start voice input"], span[title="Voice input not supported in this browser"]').first().isVisible().catch(() => false);
    check('Desktop: a mic control (active or a visible "not supported" fallback) is always present, never missing entirely', micVisible, {});

    // Language selector
    const langSelectVisible = await page.locator('select[aria-label="Voice language"]').isVisible().catch(() => false);
    check('Desktop: English/Hindi language selector is present', langSelectVisible, {});

    await page.locator('button[aria-label="Close assistant"]').click().catch(() => {});
  }
  await ctx.close();

  // --- Phone width (390px) ---
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await ctx.newPage();
  await loginAs(page);
  const launcherPhone = page.locator('button[aria-label="Open AI assistant"]');
  const launcherPhoneVisible = await launcherPhone.isVisible().catch(() => false);
  check('Phone (390px): the AI assistant launcher is visible', launcherPhoneVisible, {});
  if (launcherPhoneVisible) {
    await launcherPhone.click();
    await page.waitForTimeout(500);
    const panelFillsScreen = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('div')].filter((d) => d.textContent?.includes('WorkPilot Assistant'));
      return panels.length > 0;
    });
    check('Phone (390px): the panel opens (full-screen takeover expected at this width per the component\'s responsive classes)', panelFillsScreen, {});
    await page.screenshot({ path: `${OUT}/04-phone-panel.png`, fullPage: true });
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 5);
    check('Phone (390px): no horizontal overflow with the panel open', noOverflow, {});
    if (!noOverflow) await page.screenshot({ path: `${OUT}/05-phone-overflow.png`, fullPage: true });
  }
  await ctx.close();

  // --- Dark mode ---
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  page = await ctx.newPage();
  await loginAs(page);
  const launcherDark = page.locator('button[aria-label="Open AI assistant"]');
  if (await launcherDark.isVisible().catch(() => false)) {
    await launcherDark.click();
    await page.waitForTimeout(500);
    const panelVisibleDark = await page.locator('text=WorkPilot Assistant').isVisible().catch(() => false);
    check('Dark mode: panel opens and renders without crashing', panelVisibleDark, {});
    await page.screenshot({ path: `${OUT}/06-dark-mode.png` });
  } else {
    check('Dark mode: launcher visible', false, 'launcher not found in dark mode context');
  }
  await ctx.close();

  await browser.close();
  const pass = results.filter((r) => r.pass).length;
  fs.writeFileSync(__dirname + '/ui-walk-results.json', JSON.stringify(results, null, 2));
  console.log(`\nAI ASSISTANT UI WALK: ${pass} pass / ${results.length - pass} fail / ${results.length} total`);
})().catch((e) => { console.error('AI_UI_WALK_FAILED', e); process.exit(1); });
