// models/TablePreference.js
// Saved column layout (which columns show, and in what order) for one table.
// userId set  -> that person's own layout.
// userId null -> the company-wide default, saved by an Admin.
const mongoose = require('mongoose');

const TablePreferenceSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  userId:   { type: mongoose.Schema.Types.ObjectId, index: true, default: null },
  tableKey: { type: String, required: true },      // e.g. "employee_table", "delegation_table"
  columns: [{
    _id:       false,
    key:       { type: String, required: true },
    label:     { type: String },
    isVisible: { type: Boolean, default: true },
    order:     { type: Number, default: 0 },
    width:     { type: Number },
  }],
}, { timestamps: true });

TablePreferenceSchema.index({ tenantId: 1, userId: 1, tableKey: 1 }, { unique: true });

module.exports = mongoose.model('TablePreference', TablePreferenceSchema);
