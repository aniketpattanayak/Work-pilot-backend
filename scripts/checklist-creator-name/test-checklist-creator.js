// Unit check (no database): the ChecklistTask schema accepts createdBy,
// and a checklist WITHOUT createdBy (created before this field existed) is still valid.
const assert = require('assert');
const mongoose = require('mongoose');
const ChecklistTask = require('../../models/ChecklistTask');

const base = () => ({
  tenantId: new mongoose.Types.ObjectId(),
  taskName: 'Ac cleaning',
  doerId: new mongoose.Types.ObjectId(),
  frequency: 'Daily',
  nextDueDate: new Date(),
});

const creator = new mongoose.Types.ObjectId();
const withCreator = new ChecklistTask({ ...base(), createdBy: creator });
assert.strictEqual(withCreator.validateSync(), undefined, 'valid with createdBy');
assert.strictEqual(String(withCreator.createdBy), String(creator));

const legacy = new ChecklistTask(base());
assert.strictEqual(legacy.validateSync(), undefined, 'legacy checklist without createdBy is still valid');
assert.strictEqual(legacy.createdBy, undefined);

// The id guard used in createChecklistTask / bulkAddChecklists
const guard = (id) => (mongoose.Types.ObjectId.isValid(id) ? id : undefined);
assert.strictEqual(guard(undefined), undefined);
assert.strictEqual(guard('not-an-id'), undefined);
assert.strictEqual(guard(String(creator)), String(creator));

console.log('checklist creator-name checks: all passed');
