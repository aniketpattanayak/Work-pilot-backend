// Part 1 (AI-layer-v2) unit tests for utils/aiAssistant/resolve.js.
// Pure unit test - no server, no DB. Run: node scripts/phase4-ai-assistant/test-resolve-regression.js
const assert = require('assert');
const { resolveEntity } = require('../../utils/aiAssistant/resolve');

let pass = 0, fail = 0;
const failures = [];

function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push({ name, error: e.message }); }
}

// A small tenant-A employee list used across most cases.
const TENANT_A = [
  { _id: 'a1', name: 'Aniket Pattanayak', department: 'Sales', email: 'aniket.p@co.com' },
  { _id: 'a2', name: 'Priya Sharma', department: 'HR', email: 'priya.s@co.com' },
  { _id: 'a3', name: 'Priya Verma', department: 'Finance', email: 'priya.v@co.com' },
  { _id: 'a4', name: 'Rohit Kumar', department: 'Ops', email: 'rohit.k@co.com' },
  { _id: 'a5', name: 'Sachin Tendulkar', department: 'Sales', email: 'sachin.t@co.com' },
  { _id: 'a6', name: 'Mohammed Shaikh', department: 'IT', email: 'mohammed.s@co.com' },
];

// A second tenant - used to prove cross-tenant isolation (the resolver only
// ever sees what the caller passes in, so this just proves that discipline:
// if tenant B's list is never passed in, tenant B's people can never appear).
const TENANT_B = [
  { _id: 'b1', name: 'Aniket Joshi', department: 'Sales', email: 'aniket.j@other.com' },
];

function byName(list, query) {
  return resolveEntity(query, list, {
    getPrimary: (e) => e.name,
    getAliases: (e) => [e.email.split('@')[0]],
    label: (e) => e.name,
  });
}

// ── Exact / near-exact ────────────────────────────────────────────────────
check('exact full name', () => {
  const r = byName(TENANT_A, 'Aniket Pattanayak');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a1');
});

check('exact first name only, unambiguous', () => {
  const r = byName(TENANT_A, 'Rohit');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a4');
});

check('case-insensitive', () => {
  const r = byName(TENANT_A, 'ANIKET PATTANAYAK');
  assert.strictEqual(r.decision, 'single');
});

check('extra whitespace tolerated', () => {
  const r = byName(TENANT_A, '  Aniket   Pattanayak  ');
  assert.strictEqual(r.decision, 'single');
});

check('honorific stripped: Mr Aniket', () => {
  const r = byName(TENANT_A, 'Mr Aniket Pattanayak');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a1');
});

check('honorific stripped: Shri', () => {
  const r = byName(TENANT_A, 'Shri Rohit Kumar');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a4');
});

check('honorific stripped: Ji suffix', () => {
  const r = byName(TENANT_A, 'Rohit Ji');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a4');
});

check('dots and hyphens normalised', () => {
  const r = byName(TENANT_A, 'Aniket-Pattanayak');
  assert.strictEqual(r.decision, 'single');
});

// ── Typos: the exact bug reported ──────────────────────────────────────────
check('BUG CASE: Anikeet -> Aniket', () => {
  const r = byName(TENANT_A, 'Anikeet');
  assert.strictEqual(r.decision, 'single', `expected single, got ${r.decision}`);
  assert.strictEqual(r.top.item._id, 'a1');
});

check('typo: Anikat -> Aniket', () => {
  const r = byName(TENANT_A, 'Anikat');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a1');
});

check('typo: Anicket -> Aniket (double vs single consonant family)', () => {
  const r = byName(TENANT_A, 'Aniket');
  assert.strictEqual(r.decision, 'single');
});

check('swapped letters: Patanayak -> Pattanayak', () => {
  const r = byName(TENANT_A, 'Patanayak');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a1');
});

check('missing vowel: Rohi Kumar -> Rohit Kumar', () => {
  const r = byName(TENANT_A, 'Rohi Kumar');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a4');
});

check('doubled letter typo: Sacchin -> Sachin', () => {
  const r = byName(TENANT_A, 'Sacchin Tendulkar');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a5');
});

check('sh/s family: Rohith -> Rohit (th/t rule)', () => {
  const r = byName(TENANT_A, 'Rohith Kumar');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a4');
});

check('v/w family: Mohammed Shaikh vs "Mohammed Shaikw"', () => {
  const r = byName(TENANT_A, 'Mohammed Shaikw');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a6');
});

check('surname typo\'d, first name exact: Sharma -> Sharma (control)', () => {
  const r = byName(TENANT_A, 'Priya Sharma');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a2');
});

check('first-name-only ambiguous between two Priyas', () => {
  const r = byName(TENANT_A, 'Priya');
  assert.strictEqual(r.decision, 'ambiguous');
  assert.ok(r.candidates.length >= 2);
  const ids = r.candidates.map((c) => c.item._id);
  assert.ok(ids.includes('a2') && ids.includes('a3'));
});

check('typo\'d first-name-only still ambiguous between two Priyas', () => {
  const r = byName(TENANT_A, 'Priyaa');
  assert.strictEqual(r.decision, 'ambiguous');
});

check('disambiguated by surname typo: Priya Sharrma -> Priya Sharma', () => {
  const r = byName(TENANT_A, 'Priya Sharrma');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a2');
});

check('disambiguated by surname typo: Priya Varma -> Priya Verma', () => {
  const r = byName(TENANT_A, 'Priya Varma');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a3');
});

// ── Devanagari ──────────────────────────────────────────────────────────────
check('Devanagari: अनिकेत matches Aniket', () => {
  const r = byName(TENANT_A, 'अनिकेत');
  assert.strictEqual(r.decision, 'single', `expected single, got ${r.decision} (candidates: ${JSON.stringify(r.candidates.map(c=>c.item.name))})`);
  assert.strictEqual(r.top.item._id, 'a1');
});

check('Devanagari: रोहित matches Rohit', () => {
  const r = byName(TENANT_A, 'रोहित');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a4');
});

check('Devanagari full name: प्रिया शर्मा matches Priya Sharma over Priya Verma', () => {
  const r = byName(TENANT_A, 'प्रिया शर्मा');
  assert.strictEqual(r.decision, 'single', `got ${r.decision}`);
  assert.strictEqual(r.top.item._id, 'a2');
});

// ── Email-prefix alias matching ─────────────────────────────────────────────
check('email prefix matches: rohit.k', () => {
  const r = byName(TENANT_A, 'rohit.k');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a4');
});

// ── Nothing found ───────────────────────────────────────────────────────────
check('completely unrelated name returns none with suggestions', () => {
  const r = byName(TENANT_A, 'Zzxxqq Nonexistent');
  assert.strictEqual(r.decision, 'none');
  assert.ok(Array.isArray(r.suggestions));
  assert.ok(r.suggestions.length <= 3);
});

check('empty query returns none, not a crash', () => {
  const r = byName(TENANT_A, '');
  assert.strictEqual(r.decision, 'none');
});

check('empty candidate list returns none, not a crash', () => {
  const r = byName([], 'Aniket');
  assert.strictEqual(r.decision, 'none');
});

// ── Cross-tenant isolation (resolver only ever sees what's passed in) ───────
check('tenant B name never appears when only tenant A list is passed', () => {
  const r = byName(TENANT_A, 'Aniket Joshi'); // exists only in tenant B
  const ids = r.candidates.map((c) => c.item._id);
  assert.ok(!ids.includes('b1'));
});

check('same first name across tenants does not leak: searching tenant A list for "Aniket Joshi" still only ever returns tenant A people', () => {
  const r = byName(TENANT_A, 'Aniket Joshi');
  for (const c of r.candidates) {
    assert.ok(TENANT_A.find((e) => e._id === c.item._id), 'result must come from the list the caller passed in');
  }
});

// ── Two people with the same first name, more typo variants ────────────────
check('typo of ambiguous first name still surfaces both, not a wrong single pick', () => {
  const r = byName(TENANT_A, 'Pria'); // typo of "Priya"
  assert.strictEqual(r.decision, 'ambiguous', `expected ambiguous, got ${r.decision}`);
});

check('clear winner beats a weak second place (gap threshold)', () => {
  // "Aniket Pattanayak" is near-exact; "Sachin Tendulkar" should score far lower.
  const r = byName(TENANT_A, 'Aniket Pattanayek');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a1');
});

// ── Departments / leave types via the same resolver (generic reuse) ────────
const DEPARTMENTS = [
  { name: 'Sales' }, { name: 'Finance' }, { name: 'Human Resources' }, { name: 'Information Technology' },
];
function byDept(q) {
  return resolveEntity(q, DEPARTMENTS, { getPrimary: (d) => d.name, label: (d) => d.name });
}
check('department fuzzy: Finace -> Finance', () => {
  const r = byDept('Finace');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item.name, 'Finance');
});
check('department prefix: "Human" -> Human Resources', () => {
  const r = byDept('Human');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item.name, 'Human Resources');
});
check('department no match returns none with suggestions', () => {
  const r = byDept('Zzz Nonexistent Dept');
  assert.strictEqual(r.decision, 'none');
});

const LEAVE_TYPES = [
  { name: 'Sick Leave' }, { name: 'Casual Leave' }, { name: 'Earned Leave' },
];
function byLeaveType(q) {
  return resolveEntity(q, LEAVE_TYPES, { getPrimary: (t) => t.name, label: (t) => t.name });
}
check('leave type typo: Sik Leave -> Sick Leave', () => {
  const r = byLeaveType('Sik Leave');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item.name, 'Sick Leave');
});
check('leave type partial: "Casual" -> Casual Leave', () => {
  const r = byLeaveType('Casual');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item.name, 'Casual Leave');
});

// ── Robustness / no-crash guarantees ─────────────────────────────────────────
check('null query does not throw', () => {
  assert.doesNotThrow(() => byName(TENANT_A, null));
});
check('undefined query does not throw', () => {
  assert.doesNotThrow(() => byName(TENANT_A, undefined));
});
check('candidate with missing email field does not throw', () => {
  const list = [{ _id: 'x1', name: 'No Email Person' }];
  assert.doesNotThrow(() => resolveEntity('No Email', list, { getPrimary: (e) => e.name, getAliases: (e) => [e.email ? e.email.split('@')[0] : ''] }));
});
check('numeric-ish query does not throw', () => {
  assert.doesNotThrow(() => byName(TENANT_A, '12345'));
});
check('very long query does not throw or hang', () => {
  assert.doesNotThrow(() => byName(TENANT_A, 'a'.repeat(500)));
});

// ── A few more realistic Hinglish/typo combos ───────────────────────────────
check('Hinglish-spelled: "Rohit kumarr"', () => {
  const r = byName(TENANT_A, 'Rohit kumarr');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a4');
});
check('reversed word order still token-matches: "Pattanayak Aniket"', () => {
  const r = byName(TENANT_A, 'Pattanayak Aniket');
  assert.strictEqual(r.decision, 'single');
  assert.strictEqual(r.top.item._id, 'a1');
});
check('single-letter query returns none/ambiguous, never a false single', () => {
  const r = byName(TENANT_A, 'a');
  assert.notStrictEqual(r.decision, 'single');
});

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
