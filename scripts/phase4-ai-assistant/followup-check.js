require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
process.env.PORT = '5096';
(async () => {
  require('../../index.js');
  await new Promise((r) => setTimeout(r, 2500));
  const BASE = `http://localhost:5096/api`;
  async function j(method, p, body, token) {
    const headers = { Authorization: token ? `Bearer ${token}` : undefined };
    let sendBody;
    if (body !== undefined && method !== 'GET') { headers['Content-Type'] = 'application/json'; sendBody = JSON.stringify(body); }
    const res = await fetch(BASE + p, { method, headers, body: sendBody });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  let r = await j('POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  const sub = 'zzz-ai-followup-' + Date.now();
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j('POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token; const tenantId = r.data.tenantId;
  r = await j('POST', '/tasks/add-employee', { tenantId, name: 'Plain Doer', email: `doer-${Date.now()}@${sub}.test`, department: 'Ops', whatsappNumber: '9999999999', roles: ['Doer'], password: 'TestPass123!' }, adminToken);
  const doerEmail = r.data?.employee?.email || r.data?.email;
  await j('PUT', `/superadmin/tenants/${tenantId}/ai-assistant`, { enabled: true, monthlyLimit: 10000 }, superToken);

  r = await j('POST', '/ai-assistant/chat', { message: `Please create a task titled "Prep the Q3 report" for ${doerEmail}, due 2026-11-01.` }, adminToken);
  console.log('TURN 1:', JSON.stringify(r.data));

  r = await j('POST', '/ai-assistant/chat', { message: 'Yes, please go ahead and create it.' }, adminToken);
  console.log('TURN 2:', JSON.stringify(r.data));

  const { realModelCallCount } = require('../../utils/aiAssistant/provider');
  console.log('REAL CALLS THIS RUN:', realModelCallCount());
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
