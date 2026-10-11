const mongoose = require('mongoose');

// A person's monthly salary from a given date. Changing someone's salary adds a new row with a later
// effectiveFrom; the old rows stay as history. Month by month, the latest row that has started applies.
const PayrollStructureSchema = new mongoose.Schema({
  tenantId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  effectiveFrom: { type: String, required: true },            // 'YYYY-MM-DD'
  basic:         { type: Number, required: true, min: 0 },
  items:         [{ _id: false, key: String, amount: Number }], // company components given to this person, with the amount
  bank:          { accountName: { type: String, default: '' }, bankName: { type: String, default: '' }, accountNumber: { type: String, default: '' }, ifsc: { type: String, default: '' } },
  note:          { type: String, default: '', maxlength: 200 },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
}, { timestamps: true });

PayrollStructureSchema.index({ tenantId: 1, employeeId: 1, effectiveFrom: 1 }, { unique: true });

module.exports = mongoose.model('PayrollStructure', PayrollStructureSchema);
