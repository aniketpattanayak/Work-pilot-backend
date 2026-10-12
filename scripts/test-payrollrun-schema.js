// Regression test for the "bare type key" Mongoose footgun in models/PayrollRun.js.
// A subdocument array element with a field literally named `type` (e.g. { type: String }) must be
// wrapped as `type: { type: String, enum: [...] }`, or Mongoose reads the whole element definition as
// a type descriptor and silently casts the array to [String] instead of an array of objects.
// This previously broke every payroll run that had salary components, and every bonus/recovery
// adjustment on a payroll line, with "Cast to [string] failed ... at path components.0" /
// "... at path lines.0.adjustments.0". No database connection needed — this only exercises the
// compiled Mongoose schema and client-side validation.
const assert = require('assert');
const PayrollRun = require('../models/PayrollRun');

function run(name, fn) {
  try { fn(); console.log('PASS -', name); return true; }
  catch (e) { console.log('FAIL -', name, '|', e.message); return false; }
}

let ok = true;

ok = run('components path is a document array (SchemaDocumentArray), not [String]', () => {
  const p = PayrollRun.schema.path('components');
  assert.strictEqual(p.constructor.name, 'SchemaDocumentArray', `expected a SchemaDocumentArray, got "${p.constructor.name}" (caster: ${p.caster && p.caster.constructor.name})`);
  assert.ok(p.schema, 'expected the array to have its own subdocument schema');
}) && ok;

ok = run('lines.adjustments path is a document array (SchemaDocumentArray), not [String]', () => {
  const linesPath = PayrollRun.schema.path('lines');
  const adjPath = linesPath.schema.path('adjustments');
  assert.strictEqual(adjPath.constructor.name, 'SchemaDocumentArray', `expected a SchemaDocumentArray, got "${adjPath.constructor.name}" (caster: ${adjPath.caster && adjPath.caster.constructor.name})`);
  assert.ok(adjPath.schema, 'expected the array to have its own subdocument schema');
}) && ok;

ok = run('a PayrollRun with real salary components passes validation (no DB write)', () => {
  const doc = new PayrollRun({
    tenantId: new (require('mongoose').Types.ObjectId)(),
    month: '2026-09', status: 'Draft',
    components: [
      { key: 'hra', name: 'HRA', type: 'earning', calc: 'percentBasic', value: 40, prorate: true, active: true, pf: false },
      { key: 'special', name: 'Special Allowance', type: 'earning', calc: 'fixed', value: 5000, prorate: false, active: true, pf: false }
    ],
    lines: [{
      employeeId: new (require('mongoose').Types.ObjectId)(), name: 'Test Person', department: 'Engineering',
      adjustments: [{ label: 'Diwali bonus', type: 'earning', amount: 2000, note: '' }],
      earnings: [], deductions: [], employer: [], gross: 0, totalDeductions: 0, net: 0, warnings: []
    }]
  });
  const err = doc.validateSync();
  if (err) throw new Error('validateSync() reported: ' + err.message);
  assert.strictEqual(doc.components[0].type, 'earning', `components[0].type should read back as "earning", got ${JSON.stringify(doc.components[0])}`);
  assert.strictEqual(doc.lines[0].adjustments[0].type, 'earning', `lines[0].adjustments[0].type should read back as "earning", got ${JSON.stringify(doc.lines[0].adjustments[0])}`);
}) && ok;

process.exitCode = ok ? 0 : 1;
console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
