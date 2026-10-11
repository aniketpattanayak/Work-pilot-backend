const mongoose = require('mongoose');

// A person's income tax declaration for one financial year ('2026-27'). HR enters it (or the person's proofs are entered by HR).
// Used to work out TDS on salary. `regime` empty means "use the company's default regime".
const PayrollDeclarationSchema = new mongoose.Schema({
  tenantId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  fy:               { type: String, required: true },
  regime:           { type: String, enum: ['', 'old', 'new'], default: '' },
  section80C:       { type: Number, default: 0 },   // old regime: investments (PF from payroll is added automatically)
  section80D:       { type: Number, default: 0 },
  nps80CCD1B:       { type: Number, default: 0 },
  homeLoanInterest: { type: Number, default: 0 },
  hraExemption:     { type: Number, default: 0 },
  otherDeductions:  { type: Number, default: 0 },
  prevIncome:       { type: Number, default: 0 },   // salary already paid this year before this payroll (earlier employer or months before Work-Pilot)
  prevTds:          { type: Number, default: 0 },   // tax already deducted on that
  updatedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
}, { timestamps: true });

PayrollDeclarationSchema.index({ tenantId: 1, employeeId: 1, fy: 1 }, { unique: true });

module.exports = mongoose.model('PayrollDeclaration', PayrollDeclarationSchema);
