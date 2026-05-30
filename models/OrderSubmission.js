// server/models/OrderSubmission.js
// One submission = one order (with one or more line items).
// Each line item becomes one FlowInstance.

const mongoose = require('mongoose');

const LineItemSchema = new mongoose.Schema({
  lineItemId:   { type: String, required: true }, // e.g. NAVTECHORD-2026-0001-ITEM001
  fieldValues:  { type: mongoose.Schema.Types.Mixed, default: {} }, // { "Item Name": "SS Ladle", "Qty": 960 }
  instanceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'FlowInstance' }, // linked flow
  status:       { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
}, { _id: false });

const OrderSubmissionSchema = new mongoose.Schema({
  tenantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  formId:      { type: mongoose.Schema.Types.ObjectId, ref: 'OrderForm', required: true },
  templateId:  { type: mongoose.Schema.Types.ObjectId, ref: 'FlowTemplate', required: true },

  // Auto-generated order ID e.g. NAVTECHORD-2026-0001
  orderId:     { type: String, required: true },

  // Order-level field values (applies to all line items)
  orderFields: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Line items — each gets its own flow instance
  lineItems:   { type: [LineItemSchema], default: [] },

  // Who submitted
  submittedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  submittedByName: { type: String },
  submittedAt:   { type: Date, default: Date.now },

  status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
}, { timestamps: true });

OrderSubmissionSchema.index({ tenantId: 1, status: 1 });
OrderSubmissionSchema.index({ tenantId: 1, orderId: 1 });
OrderSubmissionSchema.index({ formId: 1 });

module.exports = mongoose.model('OrderSubmission', OrderSubmissionSchema);