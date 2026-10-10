const mongoose = require('mongoose');

// "I forgot to punch / my punch is wrong." On approval the times become punches with source 'regularization'.
const RegularizationSchema = new mongoose.Schema({
  tenantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date:       { type: String, required: true },
  inTime:     { type: String, default: '' },    // 'HH:MM' India time
  outTime:    { type: String, default: '' },
  reason:     { type: String, required: true, maxlength: 300 },
  status:     { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Cancelled'], default: 'Pending' },
  decidedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  decidedAt:  { type: Date, default: null },
  decisionNote: { type: String, default: '', maxlength: 300 },
}, { timestamps: true });
RegularizationSchema.index({ tenantId: 1, employeeId: 1, status: 1 });
RegularizationSchema.index({ tenantId: 1, status: 1, date: 1 });

module.exports = mongoose.model('Regularization', RegularizationSchema);
