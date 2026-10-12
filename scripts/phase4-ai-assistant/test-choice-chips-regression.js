// Part 6 (UI) backend support: when find_colleague resolves to 'ambiguous'
// (more than one close name match), the controller now answers directly
// with a structured `choices` array instead of looping back to the model
// to phrase a plain-text question - this is what the panel's choice-chip
// UI renders. Proves the shape is right and that a clear single match still
// goes through the normal loop unaffected (no choices field at all).
process.env.PORT = process.env.PORT || '5196';

const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 400));
}

async function j(base, method, p, body, token) {
  const headers = { Authorization: token ? `Bearer ${token}` : undefined };
  let sendBody;
  if (body !== undefined && method !== 'GET') { headers['Content-Type'] = 'application/json'; sendBody = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers, body: sendBody });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

(async () => {
  require('../../index.js');
  await new Promise((r) => setTimeout(r, 5000));
  const BASE = `http://localhost:${process.env.PORT}/api`;

  let r = await j(BASE, 'POST', '/tenants/master-login', { username: 'test_superadmin', password: 'TestPass123!' });
  const superToken = r.data.token;
  check('setup: superadmin login works', r.status === 200 && !!superToken, r);

  const sub = 'zzz-chips-' + Date.now();
  const fd = new FormData();
  fd.append('companyName', sub); fd.append('subdomain', sub);
  fd.append('ownerEmail', `admin@${sub}.test`); fd.append('adminPassword', 'TestPass123!');
  await fetch(BASE + '/tenants/create-company', { method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: fd });
  r = await j(BASE, 'POST', '/tenants/login-employee', { subdomain: sub, email: `admin@${sub}.test`, password: 'TestPass123!' });
  const adminToken = r.data.token, tenantId = r.data.tenantId;
  check('setup: tenant created, admin can log in', r.status === 200 && !!adminToken, r);
  await j(BASE, 'PUT', `/superadmin/tenants/${tenantId}/ai-assistant`, { enabled: true, monthlyLimit: 10000 }, superToken);

  await j(BASE, 'POST', '/tasks/add-employee', { tenantId, name: 'Priya Sharma', email: `ps-${Date.now()}@${sub}.test`, department: 'Ops', whatsappNumber: '9999911111', roles: ['Doer'], password: 'TestPass123!' }, adminToken);
  await j(BASE, 'POST', '/tasks/add-employee', { tenantId, name: 'Priya Verma', email: `pv-${Date.now()}@${sub}.test`, department: 'Ops', whatsappNumber: '9999911112', roles: ['Doer'], password: 'TestPass123!' }, adminToken);
  await j(BASE, 'POST', '/tasks/add-employee', { tenantId, name: 'Rakesh Singh', email: `rs-${Date.now()}@${sub}.test`, department: 'Ops', whatsappNumber: '9999911113', roles: ['Doer'], password: 'TestPass123!' }, adminToken);

  // Ambiguous: two close "Priya" matches -> structured choices, no model loop.
  global.__AI_ASSISTANT_FAKE_MODEL__ = async ({ messages }) => {
    const last = messages.filter((m) => typeof m.content === 'string').pop()?.content || '';
    if (/AMBIGUOUS_LOOKUP/.test(last)) return { toolUse: { id: 't1', name: 'find_colleague', input: { query: 'Priya' } }, text: '' };
    if (/CLEAR_LOOKUP/.test(last)) return { toolUse: { id: 't2', name: 'find_colleague', input: { query: 'Rakesh' } }, text: 'got it' };
    return { toolUse: null, text: 'unhandled' };
  };
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'AMBIGUOUS_LOOKUP: assign it to priya' }, adminToken);
  check('ambiguous find_colleague returns a `choices` array, one per candidate, no model round-trip needed',
    Array.isArray(r.data.choices) && r.data.choices.length === 2
      && r.data.choices.some((c) => c.label === 'Priya Sharma') && r.data.choices.some((c) => c.label === 'Priya Verma'),
    r.data);
  check('the ambiguous reply asks which one, in one short sentence', /which one did you mean/.test(r.data.reply), r.data);

  // Clear single match: unaffected, no choices field, falls through to the
  // normal lookup loop (model gets the result, keeps reasoning).
  r = await j(BASE, 'POST', '/ai-assistant/chat', { message: 'CLEAR_LOOKUP: assign it to rakesh' }, adminToken);
  check('a CLEAR single match is unaffected - no `choices` field at all', r.data.choices === undefined, r.data);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} PASS / ${total - passed} FAIL / ${total} TOTAL`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
