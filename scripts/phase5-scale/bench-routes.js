// Phase 5 scale expansion: load-test several real routes against the
// 20,000-employee tenant seeded by seed.js (10x the original 2,000-employee
// run). Uses autocannon against the real running backend (localhost:5099).
// Measured, not estimated - every number below comes from this run.
const autocannon = require('/tmp/wpb/node_modules/autocannon');
const axiosMod = require('/tmp/wpb/node_modules/axios');
const axios = axiosMod.default || axiosMod;
const state = require('./seed-state.json');

const BASE = process.env.BASE_URL || 'http://localhost:5099/api';
const CONN = Number(process.env.BENCH_CONN || 20);
const DUR = Number(process.env.BENCH_DUR || 10);

async function login() {
  const r = await axios.post(`${BASE}/tasks/login-employee`, {
    email: `admin@${state.sub}.test`,
    password: 'TestPass123!',
    subdomain: state.sub,
  });
  return r.data.token;
}

async function run(name, path) {
  return new Promise((resolve, reject) => {
    const token = global.__TOKEN__;
    const instance = autocannon(
      {
        url: `${BASE}${path}`,
        connections: CONN,
        duration: DUR,
        headers: { Authorization: `Bearer ${token}` },
      },
      (err, result) => (err ? reject(err) : resolve({ name, path, result }))
    );
    autocannon.track(instance, { renderProgressBar: false });
  });
}

(async () => {
  const token = await login();
  global.__TOKEN__ = token;
  console.log('Logged in, tenantId =', state.tenantId, 'employees =', state.employeeCount);

  const routes = [
    { name: 'employee-list (20k-employee tenant)', path: `/tasks/employees/${state.tenantId}` },
    { name: 'auth/me (profile, same token repeated)', path: `/tasks/auth/me` },
    { name: 'leave/config (small, tenant-scoped doc read)', path: `/tasks/leave/config` },
    { name: 'leave/balance (own balance, indexed by employeeId)', path: `/tasks/leave/balance` },
  ];

  const summary = [];
  for (const r of routes) {
    console.log(`\n=== ${r.name} : ${r.path} ===`);
    const { result } = await run(r.name, r.path);
    const row = {
      name: r.name,
      path: r.path,
      reqPerSec: result.requests.average,
      latencyP50: result.latency.p50,
      latencyP99: result.latency.p99,
      errors: result.errors,
      timeouts: result.timeouts,
      non2xx: result['2xx'] !== undefined ? (result.non2xx || 0) : undefined,
    };
    summary.push(row);
    console.log(JSON.stringify(row, null, 2));
  }

  require('fs').writeFileSync(__dirname + '/bench-results-single.json', JSON.stringify(summary, null, 2));
  console.log('\nWrote bench-results-single.json');
})().catch((e) => { console.error('BENCH_FAILED', e.response?.data || e.message); process.exit(1); });
