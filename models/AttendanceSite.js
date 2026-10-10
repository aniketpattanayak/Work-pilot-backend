const mongoose = require('mongoose');

// An office or site people may punch from: a point on the map and how far around it counts as "at the site".
const AttendanceSiteSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:     { type: String, required: true, maxlength: 60 },
  lat:      { type: Number, required: true },
  lng:      { type: Number, required: true },
  radiusM:  { type: Number, default: 150, min: 20, max: 5000 },
}, { timestamps: true });
AttendanceSiteSchema.index({ tenantId: 1 });

module.exports = mongoose.model('AttendanceSite', AttendanceSiteSchema);
