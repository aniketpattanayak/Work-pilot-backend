// Builds a plain-text results summary and writes it to ../summary.md (repo root),
// for the workflow to post as a commit comment. Kept as its own file (not an inline
// `node -e "..."`) because backticks in the markdown code fences were being eaten by
// the shell when this was inline in a double-quoted `run:` block.
const fs = require('fs');
const path = require('path');

const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
const fence = '```';

let body = '## E2E live UI test results\n\n';
let failed = false;

try {
  const r = JSON.parse(fs.readFileSync('playwright-report/results.json', 'utf8'));
  const lines = [];
  const walk = (suite) => {
    (suite.suites || []).forEach(walk);
    (suite.specs || []).forEach((spec) => {
      spec.tests.forEach((t) => {
        const res = t.results[t.results.length - 1];
        const ok = res.status === 'passed';
        if (!ok) failed = true;
        const errMsg = res.error ? stripAnsi(res.error.message).split('\n')[0] : res.status;
        lines.push((ok ? '[PASS] ' : '[FAIL] ') + spec.title + (ok ? '' : ' - ' + errMsg));
      });
    });
  };
  walk(r);
  body += lines.join('\n') + '\n';
} catch (e) {
  failed = true;
  body += 'Could not read results.json: ' + e.message + '\n';
}

const logTail = (file, n) => {
  const p = path.join('..', file);
  if (!fs.existsSync(p)) return '(no ' + file + ')';
  const content = fs.readFileSync(p, 'utf8');
  if (!content.trim()) return '(' + file + ' is empty)';
  return stripAnsi(content).split('\n').slice(-n).join('\n');
};

body += '\nConnectivity diagnostics:\n' + fence + '\n' + logTail('diag.log', 60) + '\n' + fence + '\n';
body += '\nBackend log tail:\n' + fence + '\n' + logTail('backend.log', 40) + '\n' + fence + '\n';
body += '\nFrontend log tail:\n' + fence + '\n' + logTail('frontend.log', 20) + '\n' + fence + '\n';

fs.writeFileSync(path.join('..', 'summary.md'), body);
console.log(body);
