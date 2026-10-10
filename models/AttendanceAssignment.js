const mongoose = require('mongoose');

// Which shift a person follows and which sites they may punch from. No record = company default shift, any site.
const AttendanceAssignmentSchema = new mongoose.Schema({
  tenantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  shiftId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
  siteIds:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceSite' }],
}, { timestamps: true });
AttendanceAssignmentSchema.index({ tenantId: 1, employeeId: 1 }, { unique: true });

module.exports = mongoose.model('AttendanceAssignment', AttendanceAssignmentSchema);
