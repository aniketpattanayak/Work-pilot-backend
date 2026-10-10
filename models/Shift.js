const mongoose = require('mongoose');

// A working shift. Times are 'HH:MM' in India time. Night shifts that cross midnight are not supported yet.
const ShiftSchema = new mongoose.Schema({
  tenantId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:           { type: String, required: true, maxlength: 40 },
  start:          { type: String, required: true },
  end:            { type: String, required: true },
  graceMinutes:   { type: Number, default: 10, min: 0, max: 180 },   // late / early-exit allowance
  halfDayMinutes: { type: Number, default: 240 },                    // worked at least this = half day
  fullDayMinutes: { type: Number, default: 480 },                    // worked at least this = full day
}, { timestamps: true });
ShiftSchema.index({ tenantId: 1, name: 1 });

module.exports = mongoose.model('Shift', ShiftSchema);
