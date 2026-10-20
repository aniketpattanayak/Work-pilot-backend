// models/CustomFieldDefinition.js
// A company-defined extra field for Employees, Delegation tasks or Checklist tasks.
// The values themselves live on the record in `customFields` (a Map keyed by fieldName).
// Fields are never hard-deleted: switching `isActive` off hides a field but keeps old values.
const mongoose = require('mongoose');

const CustomFieldDefinitionSchema = new mongoose.Schema({
  tenantId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  entity:     { type: String, enum: ['employee', 'delegation', 'task', 'subtask', 'ticket', 'leave', 'personal'], required: true },
  fieldName:  { type: String, required: true },   // stable key, e.g. "blood_group"
  fieldLabel: { type: String, required: true },   // what people see, e.g. "Blood group"
  fieldType:  { type: String, enum: ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'boolean', 'file', 'formula', 'lookup'], default: 'text' },
  options:    [{ type: String }],                 // for fieldType "select"
  isRequired: { type: Boolean, default: false },
  isActive:   { type: Boolean, default: true },
  order:      { type: Number, default: 0 },
  helpText:   { type: String, default: '' },
  // Type-specific settings: file {accept,camera,maxMb,multiple,maxFiles}, lookup {source,multiple}, formula {expression,decimals,resultType}
  config:     { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

CustomFieldDefinitionSchema.index({ tenantId: 1, entity: 1, fieldName: 1 }, { unique: true });

module.exports = mongoose.model('CustomFieldDefinition', CustomFieldDefinitionSchema);
