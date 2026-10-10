const mongoose = require('mongoose');

// One punch in or out. "at" is always the server's clock. "date" is the India-time calendar day.
// A punch that needs a second look (outside the site, face did not match) waits as reviewStatus 'Pending'.
const PunchSchema = new mongoose.Schema({
  tenantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date:       { type: String, required: true },
  at:         { type: Date, required: true },
  type:       { type: String, enum: ['in', 'out'], required: true },
  source:     { type: String, enum: ['web', 'regularization', 'manual'], default: 'web' },
  lat:        { type: Number, default: null },
  lng:        { type: Number, default: null },
  accuracy:   { type: Number, default: null },
  siteId:     { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceSite', default: null },
  siteName:   { type: String, default: '' },
  distanceM:  { type: Number, default: null },
  face:       { checked: { type: Boolean, default: false }, matched: { type: Boolean, default: false }, distance: { type: Number, default: null } },
  note:       { type: String, default: '', maxlength: 300 },
  flagReason: { type: String, default: '' },
  reviewStatus: { type: String, enum: ['None', 'Pending', 'Approved', 'Rejected'], default: 'None' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: '', maxlength: 300 },
  addedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null }, // for manual / regularization punches
}, { timestamps: true });
PunchSchema.index({ tenantId: 1, employeeId: 1, date: 1 });
PunchSchema.index({ tenantId: 1, reviewStatus: 1 });

module.exports = mongoose.model('Punch', PunchSchema);
