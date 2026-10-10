const mongoose = require('mongoose');

// A person's face template: up to 3 numeric descriptors (128 numbers each). No photo is stored.
// It is never sent back to any browser; matching happens on the server. Deleted when the person withdraws consent.
const FaceTemplateSchema = new mongoose.Schema({
  tenantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  descriptors: { type: [[Number]], default: [] },
  status:      { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  consentAt:   { type: Date, required: true },
  consentText: { type: String, default: '' },
  decidedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  decidedAt:   { type: Date, default: null },
}, { timestamps: true });
FaceTemplateSchema.index({ tenantId: 1, employeeId: 1 }, { unique: true });

module.exports = mongoose.model('FaceTemplate', FaceTemplateSchema);
