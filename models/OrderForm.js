// server/models/OrderForm.js
// Stores the form design for a flow template.
// When a tenant doesn't use Google Sheets, they use this form instead.

const mongoose = require('mongoose');

const FieldSchema = new mongoose.Schema({
  id:          { type: String, required: true },  // unique within form e.g. "field_001"
  label:       { type: String, required: false, default: '' },  // shown to employee e.g. "Customer Name"
  type:        {
    type: String,
    enum: ['text', 'number', 'dropdown', 'date', 'textarea', 'autoid'],
    required: true
  },
  required:    { type: Boolean, default: false },
  placeholder: { type: String, default: '' },
  options:     { type: [String], default: [] },   // for dropdown only
  isOrderId:   { type: Boolean, default: false }, // marks the Order ID field
  isLineItemId:{ type: Boolean, default: false }, // marks the Line Item ID field
  isItemField: { type: Boolean, default: false }, // field belongs to each line item row
  order:       { type: Number, default: 0 },      // display order
}, { _id: false });

const AutoIdConfigSchema = new mongoose.Schema({
  prefix:      { type: String, default: 'ORD' },  // e.g. NAVTECHORD
  digits:      { type: Number, default: 4 },       // e.g. 4 → 0001
  resetYearly: { type: Boolean, default: true },   // reset counter each year
  separator:   { type: String, default: '-' },     // e.g. NAVTECHORD-2026-0001
  includeYear: { type: Boolean, default: true },
}, { _id: false });

const LineItemConfigSchema = new mongoose.Schema({
  enabled:   { type: Boolean, default: true },
  prefix:    { type: String, default: 'ITEM' }, // e.g. NAVTECHORD-2026-0001-ITEM001
  digits:    { type: Number, default: 3 },
  separator: { type: String, default: '-' },
}, { _id: false });

const OrderFormSchema = new mongoose.Schema({
  tenantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'FlowTemplate', default: null }, // set when linked to a flow
  name:       { type: String, required: true }, // e.g. "Navtech PO Form"
  isActive:   { type: Boolean, default: true },

  // Form fields — split into order-level and item-level
  orderFields:   { type: [FieldSchema], default: [] }, // header fields (one per order)
  itemFields:    { type: [FieldSchema], default: [] }, // line item fields (one per item)

  // Auto-ID configuration
  orderIdConfig:   { type: AutoIdConfigSchema, default: () => ({}) },
  lineItemConfig:  { type: LineItemConfigSchema, default: () => ({}) },

  // Counter — WorkPilot tracks this to generate sequential IDs
  lastOrderNumber: { type: Number, default: 0 },
  // Per-year counters: { "2026": 5, "2027": 0 }
  yearCounters:    { type: mongoose.Schema.Types.Mixed, default: {} },

  // Roles that can submit orders using this form
  allowedRoles: { type: [String], default: ['Admin', 'Assigner', 'Coordinator', 'OrderEntry'] },

  createdAt: { type: Date, default: Date.now },
});

OrderFormSchema.index({ tenantId: 1, isActive: 1 });
OrderFormSchema.index({ templateId: 1 }); // form linked to a template (not unique — same form can link to multiple flows)

module.exports = mongoose.model('OrderForm', OrderFormSchema);