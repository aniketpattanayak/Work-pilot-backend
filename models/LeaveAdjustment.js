const mongoose = require('mongoose');

// A manual change of someone's leave balance (opening balance, correction, bonus leave). Never edited, only added.
const LeaveAdjustmentSchema = new mongoose.Schema({
  tenantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
  days:        { type: Number, required: true },
  date:        { type: String, required: true }, // the leave year containing this day receives the change
  reason:      { type: String, required: true, maxlength: 300 },
  by:          { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
}, { timestamps: true });

LeaveAdjustmentSchema.index({ tenantId: 1, employeeId: 1, leaveTypeId: 1 });

module.exports = mongoose.model('LeaveAdjustment', LeaveAdjustmentSchema);
