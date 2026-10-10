const mongoose = require('mongoose');

// A leave application. Dates are calendar days ('YYYY-MM-DD'). daysDetail lists every day that counts.
const LeaveRequestSchema = new mongoose.Schema({
  tenantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
  typeName:    { type: String, default: '' },     // copied so history stays readable if the type is renamed
  paid:        { type: Boolean, default: true },
  fromDate:    { type: String, required: true },
  toDate:      { type: String, required: true },
  halfDay:     { type: String, enum: ['none', 'first', 'second'], default: 'none' },
  days:        { type: Number, required: true },
  daysDetail:  [{ _id: false, d: String, u: Number }],
  reason:      { type: String, default: '', maxlength: 500 },
  buddyId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  status:      { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Cancelled'], default: 'Pending' },
  decidedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  decidedAt:   { type: Date, default: null },
  decisionNote:{ type: String, default: '', maxlength: 300 },
  leaveStatusSynced: { type: Boolean, default: false }, // the existing "on leave + buddy" flag was set for this leave
}, { timestamps: true });

LeaveRequestSchema.index({ tenantId: 1, employeeId: 1, status: 1 });
LeaveRequestSchema.index({ tenantId: 1, status: 1, fromDate: 1 });

module.exports = mongoose.model('LeaveRequest', LeaveRequestSchema);
