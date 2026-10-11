const mongoose = require('mongoose');

const AmountRow = { _id: false, key: String, name: String, full: Number, amount: Number, adjustment: { type: Boolean, default: false }, statutory: { type: Boolean, default: false } };

// One month's payroll. Draft (can be recalculated and adjusted) -> Approved -> Released (locked; payslips visible).
// Every line keeps a snapshot of the figures used, so a released payslip never changes afterwards.
const PayrollRunSchema = new mongoose.Schema({
  tenantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  month:     { type: String, required: true },                 // 'YYYY-MM'
  status:    { type: String, enum: ['Draft', 'Approved', 'Released', 'Cancelled'], default: 'Draft' },
  dayBasis:  { type: String, default: 'calendar' },
  roundNet:  { type: Boolean, default: true },
  components:[{ _id: false, key: String, name: String, type: String, calc: String, value: Number, prorate: Boolean, active: Boolean, pf: Boolean }],
  lines: [{
    _id: false,
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    name: String, department: String,
    structureFrom: { type: String, default: '' },
    days: { type: mongoose.Schema.Types.Mixed, default: {} },
    earnings: [AmountRow], deductions: [AmountRow],
    employer: [AmountRow], employerTotal: { type: Number, default: 0 },          // employer's own PF / ESI cost (not taken from the pay)
    statutoryInfo: { type: mongoose.Schema.Types.Mixed, default: null },         // wages the PF / ESI / PT figures were worked from
    ids: { uan: { type: String, default: '' }, esiNumber: { type: String, default: '' }, pan: { type: String, default: '' } },
    adjustments: [{ _id: false, label: String, type: String, amount: Number, note: String }],
    gross: { type: Number, default: 0 }, totalDeductions: { type: Number, default: 0 }, rounding: { type: Number, default: 0 }, net: { type: Number, default: 0 },
    hold: { type: Boolean, default: false }, holdNote: { type: String, default: '' },
    warnings: [String],
    noStructure: { type: Boolean, default: false },
    bank: { accountName: { type: String, default: '' }, bankName: { type: String, default: '' }, accountNumber: { type: String, default: '' }, ifsc: { type: String, default: '' } },
  }],
  totals: { count: Number, held: Number, gross: Number, deductions: Number, net: Number, employer: Number },
  statutory: { type: mongoose.Schema.Types.Mixed, default: null },             // PF / ESI / PT settings the run was worked with
  preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }, preparedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }, approvedAt: Date,
  releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }, releasedAt: Date,
  history: [{ _id: false, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId }, byName: String, action: String, note: String }],
}, { timestamps: true });

PayrollRunSchema.index({ tenantId: 1, month: 1, status: 1 });
PayrollRunSchema.index({ tenantId: 1, 'lines.employeeId': 1, status: 1 });

module.exports = mongoose.model('PayrollRun', PayrollRunSchema);
