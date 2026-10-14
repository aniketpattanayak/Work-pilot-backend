// Unit-level test of the REAL exports.updateSettings, for the new
// `phoneCountries` field (Settings -> company-managed WhatsApp country
// code list), with Tenant.findByIdAndUpdate monkey-patched instead of
// hitting a database.
//
// Why this exists: this sandbox cannot run a real MongoDB (mongodb-memory-
// server's binary download, and MongoDB's own apt repo, are both blocked
// by this environment's network allowlist). This is NOT a substitute for
// a real-database regression test of tenant isolation and the Admin-only
// check end-to-end (same caveat as scripts/task-media-history-ux/test-
// respond-unit-mocked.js) - that still needs to run wherever a reachable
// Mongo exists before this goes to production. This script instead calls
// the real, merged exports.updateSettings with a monkey-patched Tenant
// model, so the validation logic and the Admin/tenant-isolation checks
// get automated coverage here and now.

const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  results.push({ name, pass, detail: pass ? undefined : detail });
  console.log(pass ? 'PASS' : 'FAIL', '-', name, pass ? '' : String(JSON.stringify(detail)).slice(0, 400));
}

const Tenant = require('../../models/Tenant');
const tenantController = require('../../controllers/tenantController');

// Capture the $set the controller tries to persist, and hand back a fake
// "saved" tenant so the controller's post-save logic (res.json) runs too.
let lastUpdateArgs = null;
Tenant.findByIdAndUpdate = async (id, update, opts) => {
  lastUpdateArgs = { id, update, opts };
  return { _id: id, ...(update && update.$set) };
};

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

async function run() {
  // 1. Non-Admin, non-SuperAdmin caller is rejected before any validation runs.
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Doer'], tenantId: 't1', isSuperAdmin: false },
      body: { tenantId: 't1', phoneCountries: [{ id: 'XX', name: 'Testland', dialCode: '55' }] },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('Non-Admin caller is rejected with 403, no write attempted',
      res.statusCode === 403 && lastUpdateArgs === null,
      { statusCode: res.statusCode, body: res.body, wrote: !!lastUpdateArgs });
  }

  // 2. Admin of a DIFFERENT tenant cannot update this tenant's settings (tenant isolation).
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Admin'], tenantId: 'other-tenant', isSuperAdmin: false },
      body: { tenantId: 't1', phoneCountries: [{ id: 'XX', name: 'Testland', dialCode: '55' }] },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('Admin of a different tenant is rejected with 403 (tenant isolation), no write attempted',
      res.statusCode === 403 && lastUpdateArgs === null,
      { statusCode: res.statusCode, body: res.body, wrote: !!lastUpdateArgs });
  }

  // 3. The tenant's own Admin can save a valid list.
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Admin'], tenantId: 't1', isSuperAdmin: false },
      body: {
        tenantId: 't1',
        phoneCountries: [
          { id: 'IN', name: 'India', flag: '🇮🇳', dialCode: '91' },
          { id: 'SG', name: 'Singapore', flag: '🇸🇬', dialCode: '65' },
        ],
      },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('Own-tenant Admin can save a valid phoneCountries list',
      res.statusCode === 200 &&
      lastUpdateArgs &&
      Array.isArray(lastUpdateArgs.update.$set.phoneCountries) &&
      lastUpdateArgs.update.$set.phoneCountries.length === 2,
      { statusCode: res.statusCode, body: res.body, saved: lastUpdateArgs && lastUpdateArgs.update.$set.phoneCountries });
  }

  // 4. SuperAdmin can update ANY tenant's list, regardless of their own tenantId.
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: [], tenantId: 'platform', isSuperAdmin: true },
      body: { tenantId: 't1', phoneCountries: [{ id: 'US', name: 'United States', dialCode: '1' }] },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('SuperAdmin can update any tenant\'s phoneCountries',
      res.statusCode === 200 && lastUpdateArgs && lastUpdateArgs.update.$set.phoneCountries.length === 1,
      { statusCode: res.statusCode, body: res.body });
  }

  // 5. Validation: dialCode with a leading zero is rejected.
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Admin'], tenantId: 't1', isSuperAdmin: false },
      body: { tenantId: 't1', phoneCountries: [{ id: 'XX', name: 'Testland', dialCode: '055' }] },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('dialCode with a leading zero is rejected (400), no write attempted',
      res.statusCode === 400 && lastUpdateArgs === null,
      { statusCode: res.statusCode, body: res.body });
  }

  // 6. Validation: dialCode longer than 4 digits is rejected.
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Admin'], tenantId: 't1', isSuperAdmin: false },
      body: { tenantId: 't1', phoneCountries: [{ id: 'XX', name: 'Testland', dialCode: '12345' }] },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('dialCode over 4 digits is rejected (400)',
      res.statusCode === 400 && lastUpdateArgs === null,
      { statusCode: res.statusCode, body: res.body });
  }

  // 7. Validation: duplicate ids are rejected.
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Admin'], tenantId: 't1', isSuperAdmin: false },
      body: {
        tenantId: 't1',
        phoneCountries: [
          { id: 'XX', name: 'Testland', dialCode: '55' },
          { id: 'xx', name: 'Testland Two', dialCode: '56' }, // same id, different case
        ],
      },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('Duplicate ids (case-insensitive) are rejected (400)',
      res.statusCode === 400 && lastUpdateArgs === null,
      { statusCode: res.statusCode, body: res.body });
  }

  // 8. Validation: name over 40 characters is rejected.
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Admin'], tenantId: 't1', isSuperAdmin: false },
      body: { tenantId: 't1', phoneCountries: [{ id: 'XX', name: 'A'.repeat(41), dialCode: '55' }] },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('Country name over 40 characters is rejected (400)',
      res.statusCode === 400 && lastUpdateArgs === null,
      { statusCode: res.statusCode, body: res.body });
  }

  // 9. Validation: more than 60 entries is rejected.
  {
    lastUpdateArgs = null;
    const tooMany = Array.from({ length: 61 }, (_, i) => ({ id: `C${i}`, name: `Country ${i}`, dialCode: '9' }));
    const req = {
      user: { roles: ['Admin'], tenantId: 't1', isSuperAdmin: false },
      body: { tenantId: 't1', phoneCountries: tooMany },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('More than 60 country codes is rejected (400)',
      res.statusCode === 400 && lastUpdateArgs === null,
      { statusCode: res.statusCode, body: res.body });
  }

  // 10. Validation: missing/empty id is rejected.
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Admin'], tenantId: 't1', isSuperAdmin: false },
      body: { tenantId: 't1', phoneCountries: [{ id: '', name: 'Testland', dialCode: '55' }] },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    check('Missing id is rejected (400)',
      res.statusCode === 400 && lastUpdateArgs === null,
      { statusCode: res.statusCode, body: res.body });
  }

  // 11. Sending phoneCountries alongside sectors/locations still validates
  // and saves all three (no regression to the existing fields' handling).
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Admin'], tenantId: 't1', isSuperAdmin: false },
      body: {
        tenantId: 't1',
        sectors: ['Ops'],
        locations: ['HQ'],
        phoneCountries: [{ id: 'IN', name: 'India', dialCode: '91' }],
      },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    const set = lastUpdateArgs && lastUpdateArgs.update.$set;
    check('sectors, locations and phoneCountries can all be saved together',
      res.statusCode === 200 && set &&
      JSON.stringify(set.sectors) === JSON.stringify(['Ops']) &&
      JSON.stringify(set.locations) === JSON.stringify(['HQ']) &&
      Array.isArray(set.phoneCountries) && set.phoneCountries.length === 1,
      { statusCode: res.statusCode, set });
  }

  // 12. Omitting phoneCountries entirely leaves it untouched (additive -
  // existing companies that never send this field are unaffected).
  {
    lastUpdateArgs = null;
    const req = {
      user: { roles: ['Admin'], tenantId: 't1', isSuperAdmin: false },
      body: { tenantId: 't1', sectors: ['Ops'] },
    };
    const res = mockRes();
    await tenantController.updateSettings(req, res);
    const set = lastUpdateArgs && lastUpdateArgs.update.$set;
    check('Omitting phoneCountries does not touch it at all',
      res.statusCode === 200 && set && !('phoneCountries' in set),
      { statusCode: res.statusCode, set });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

run();
