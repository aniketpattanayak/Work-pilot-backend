const mongoose = require('mongoose');

// One kind of leave a company offers (Casual, Sick, Earned, Unpaid ...). Made by the company's Admin.
const LeaveTypeSchema = new mongoose.Schema({
  tenantId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:              { type: String, required: true, trim: true, maxlength: 40 },
  paid:              { type: Boolean, default: true },
  unlimited:         { type: Boolean, default: false },       // no balance (for example unpaid leave)
  annualQuota:       { type: Number, default: 0, min: 0, max: 366 },
  accrual:           { type: String, enum: ['upfront', 'monthly'], default: 'monthly' },
  carryForwardMax:   { type: Number, default: 0, min: 0, max: 366 }, // days that move to next year; 0 = lapse
  maxNegative:       { type: Number, default: 0, min: 0, max: 366 }, // days the balance may go below zero
  halfDayAllowed:    { type: Boolean, default: true },
  maxConsecutiveDays:{ type: Number, default: 0, min: 0, max: 366 }, // 0 = no limit
  minNoticeDays:     { type: Number, default: 0, min: 0, max: 365 },
  backdateDays:      { type: Number, default: 7, min: 0, max: 365 }, // how many days back a request may start
  sandwich:          { type: Boolean, default: false },       // weekly offs / holidays inside the leave count
  requiresReason:    { type: Boolean, default: true },
  active:            { type: Boolean, default: true },
  createdBy:         { type: mongoose.Schema.Types.ObjectId },
}, { timestamps: true });

LeaveTypeSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('LeaveType', LeaveTypeSchema);
