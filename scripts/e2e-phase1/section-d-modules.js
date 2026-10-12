// Phase 1 Section D: every attendance/leave/payroll on-off combination (8 total),
// checked at the API level - a switched-off module must be refused by the API, not
// just hidden in the UI.
const BASE = 'http://localhost:5099/api';
async function j(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: (body !== undefined && body !== null && method !== 'GET' && method !== 'DELETE') ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: cond ? undefined : detail }); console.log(cond ? 'PASS' : 'FAIL', '-', name, cond ? '' : JSON.stringify(detail).slice(0, 200)); }

const COMBOS = [];
for (let a = 0; a < 2; a++) for (let l = 0; l < 2; l++) for (let p = 0; p < 2; p++) COMBOS.push({ attendance: !!a, leave: !!l, payroll: !!p });

(async () => {
  let r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;

  let n = 0;
  for (const combo of COMBOS) {
    n++;
    const sub = `zzz-modcombo-${n}-${Date.now()}`;
    const fd = new FormData();
    fd.append('companyName', `ModCombo ${n}`); fd.append('subdomain', sub);
    fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
    await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
    r = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
    const adminToken = r.data.token, tenantId = r.data.tenantId;

    r = await j('PUT', `/tasks/access/modules/${tenantId}`, { modules: combo }, superToken);
    check(`combo ${JSON.stringify(combo)}: superadmin can set this combination`, r.status === 200, r);

    // For each module, if ON expect the view route to succeed (200), if OFF expect 403.
    const checks = [
      { mod: 'attendance', route: ['GET', '/tasks/attendance/today'] },
      { mod: 'leave', route: ['GET', '/tasks/leave/calendar?from=2026-09-01&to=2026-09-05'] },
      { mod: 'payroll', route: ['GET', '/tasks/payroll/salaries'] }, // Admin lacks payroll perms regardless, so this should ALWAYS be 403 even when on - tests that off doesn't somehow unlock it differently, and that on doesn't crash
    ];
    for (const c of checks) {
      const [method, path] = c.route;
      const call = await j(method, path, undefined, adminToken);
      if (c.mod === 'payroll') {
        // Admin never has payroll.* (sensitive module) - expect 403 either way, and specifically
        // never a 500/crash, regardless of whether the module switch is on or off.
        check(`combo ${JSON.stringify(combo)}: payroll route never crashes (always clean 403 for Admin, module=${combo.payroll})`, call.status === 403, call);
      } else {
        const expectOk = combo[c.mod];
        check(`combo ${JSON.stringify(combo)}: ${c.mod} view route is ${expectOk ? 'ALLOWED' : 'REFUSED (403)'} when ${c.mod}=${combo[c.mod]}`, expectOk ? call.status === 200 : call.status === 403, call);
      }
    }
  }

  const pass = results.filter((r) => r.pass).length, fail = results.filter((r) => !r.pass).length;
  console.log(`\nSECTION D DONE: ${pass} pass / ${fail} fail / ${results.length} total`);
  require('fs').writeFileSync(__dirname + '/results-section-d.json', JSON.stringify(results, null, 2));
})().catch((e) => { console.error('SECTION_D_FAILED', e); process.exit(1); });
