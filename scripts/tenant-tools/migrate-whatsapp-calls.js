const fs = require('fs');
const path = require('path');
const CONFIRM = process.argv.includes('--confirm');
const ROOT = path.join(__dirname, '..', '..');

// Every real (non-dead) sendWhatsAppMessage/sendWhatsApp call site, verified
// by hand against the actual file content, with the correct tenant-context
// expression available in scope at that exact line.
const patches = [
  // ── taskController.js ──────────────────────────────────────────────
  { file: 'controllers/taskController.js', line: 7,
    find: "const sendWhatsAppMessage = require('../utils/whatsappNotify');",
    replace: "const { notifyTenant } = require('../utils/notify');" },
  { file: 'controllers/taskController.js', line: 490, tenant: 'tenant._id' },
  { file: 'controllers/taskController.js', line: 496, tenant: 'tenant._id' },
  { file: 'controllers/taskController.js', line: 503, tenant: 'tenant._id' },
  { file: 'controllers/taskController.js', line: 853, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 854, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 855, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 858, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1093, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1330, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1355, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1356, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1357, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1359, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1386, tenant: 'updatedTask.tenantId' },
  { file: 'controllers/taskController.js', line: 1387, tenant: 'updatedTask.tenantId' },
  { file: 'controllers/taskController.js', line: 1388, tenant: 'updatedTask.tenantId' },
  { file: 'controllers/taskController.js', line: 1390, tenant: 'updatedTask.tenantId' },
  { file: 'controllers/taskController.js', line: 1467, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1499, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1500, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1501, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1505, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1546, tenant: 'updatedTask.tenantId' },
  { file: 'controllers/taskController.js', line: 1547, tenant: 'updatedTask.tenantId' },
  { file: 'controllers/taskController.js', line: 1548, tenant: 'updatedTask.tenantId' },
  { file: 'controllers/taskController.js', line: 1552, tenant: 'updatedTask.tenantId' },
  { file: 'controllers/taskController.js', line: 1733, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1739, tenant: 'task.tenantId' },
  { file: 'controllers/taskController.js', line: 1884, tenant: 'taskData.tenantId' },
  { file: 'controllers/taskController.js', line: 1883,
    find: "const sendWhatsAppMessage = require('../utils/whatsappNotify');",
    replace: "const { notifyTenant } = require('../utils/notify');" },
  // NOTE: line 1154 (dispatchDailyBriefings) intentionally skipped — dead
  // code, never called by any route or scheduler (replaced by briefingEngine.js).

  // ── ticketController.js ────────────────────────────────────────────
  { file: 'controllers/ticketController.js', line: 3,
    find: "const sendWhatsAppMessage = require('../utils/whatsappNotify');",
    replace: "const { notifyTenant } = require('../utils/notify');" },
  { file: 'controllers/ticketController.js', line: 104, tenant: 'ticket.tenantId' },

  // ── tenantController.js ────────────────────────────────────────────
  { file: 'controllers/tenantController.js', line: 8,
    find: "const sendWhatsAppMessage = require('../utils/whatsappNotify');",
    replace: "const { notifyTenant } = require('../utils/notify');" },
  { file: 'controllers/tenantController.js', line: 145, tenant: 'task.tenantId' },
  { file: 'controllers/tenantController.js', line: 321, tenant: 'tenant._id' },
  { file: 'controllers/tenantController.js', line: 864, tenant: 'tenant._id' },

  // ── briefingEngine.js ───────────────────────────────────────────────
  { file: 'utils/briefingEngine.js', line: 25,
    find: "const sendWhatsAppMessage = require('./whatsappNotify');",
    replace: "const { notifyTenant } = require('./notify');" },
  { file: 'utils/briefingEngine.js', line: 102, tenant: 'tenant._id' },

  // ── taskRoutes.js ───────────────────────────────────────────────────
  { file: 'routes/taskRoutes.js', line: 150,
    find: "const sendWhatsApp = require('../utils/whatsappNotify');",
    replace: "const { notifyTenant } = require('../utils/notify');" },
  { file: 'routes/taskRoutes.js', line: 151, tenant: 'req.user.tenantId', altFn: 'sendWhatsApp' },

  // ── tenantRoutes.js ─────────────────────────────────────────────────
  { file: 'routes/tenantRoutes.js', line: 98,
    find: "const sendWhatsApp = require('../utils/whatsappNotify');",
    replace: "const { notifyTenant } = require('../utils/notify');" },
  { file: 'routes/tenantRoutes.js', line: 99, tenant: 'req.user.tenantId', altFn: 'sendWhatsApp' },
];

// ── PASS 1: verify every single line matches what we expect, before touching anything ──
const fileCache = {};
const problems = [];

for (const p of patches) {
  const fullPath = path.join(ROOT, p.file);
  if (!fileCache[p.file]) {
    fileCache[p.file] = fs.readFileSync(fullPath, 'utf8').split('\n');
  }
  const lines = fileCache[p.file];
  const actual = lines[p.line - 1];

  if (p.find) {
    if (!actual.includes(p.find)) {
      problems.push(`${p.file}:${p.line} — expected to find:\n    "${p.find}"\n  but line actually is:\n    "${actual}"`);
    }
  } else {
    const fnName = p.altFn || 'sendWhatsAppMessage';
    const needle = fnName + '(';
    if (!actual.includes(needle)) {
      problems.push(`${p.file}:${p.line} — expected "${needle}" on this line, but found:\n    "${actual}"`);
    }
  }
}

if (problems.length > 0) {
  console.error(`❌ ${problems.length} line(s) did not match what was expected. Nothing has been changed.\n`);
  problems.forEach(p => console.error(p + '\n'));
  process.exit(1);
}

console.log(`✅ All ${patches.length} expected lines verified — file content matches exactly what was checked earlier.\n`);

// ── PASS 2: apply (only if every check passed, and only if --confirm) ──
for (const p of patches) {
  const lines = fileCache[p.file];
  if (p.find) {
    lines[p.line - 1] = lines[p.line - 1].replace(p.find, p.replace);
  } else {
    const fnName = p.altFn || 'sendWhatsAppMessage';
    lines[p.line - 1] = lines[p.line - 1].replace(fnName + '(', `notifyTenant(${p.tenant}, `);
  }
}

if (!CONFIRM) {
  console.log('DRY RUN — no files written. Re-run with --confirm to apply.');
} else {
  const touchedFiles = [...new Set(patches.map(p => p.file))];
  for (const f of touchedFiles) {
    fs.writeFileSync(path.join(ROOT, f), fileCache[f].join('\n'));
    console.log(`✅ wrote ${f}`);
  }
}
