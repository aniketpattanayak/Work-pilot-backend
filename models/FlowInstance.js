const mongoose = require('mongoose');

// ─── NODE HISTORY ENTRY ───────────────────────────────────────────────────────
// Immutable record of a completed step. One entry pushed per step done.
const NodeHistorySchema = new mongoose.Schema({
  nodeId:       { type: String, required: true },
  nodeName:     { type: String, required: true },
  nodeType:     { type: String },                     // action / yesno / input

  // Who was assigned and who actually did it
  assignedToId:   { type: String },                   // employee _id or 'sheetColumn'
  assignedToName: { type: String },                   // display name
  completedById:  { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  completedByName:{ type: String },

  // Timing
  activatedAt:      { type: Date },                   // when this step became active
  plannedDeadline:  { type: Date },                   // calculated deadline
  completedAt:      { type: Date },                   // when employee clicked done/yes/no

  // What the employee decided
  decision:    { type: String, enum: ['done', 'yes', 'no', null], default: null },

  // Values collected via input fields — { fieldId: value, fieldLabel: value }
  inputs:      { type: mongoose.Schema.Types.Mixed, default: {} },

  // Performance
  onTime:         { type: Boolean, default: true },
  delayMinutes:   { type: Number, default: 0 },       // negative = early, positive = late
}, { _id: false });

// ─── ACTIVE STEP SCHEMA ───────────────────────────────────────────────────────
// Tracks the currently active step for this instance (mutable, updated live)
const ActiveStepSchema = new mongoose.Schema({
  nodeId:          { type: String },
  nodeName:        { type: String },
  nodeType:        { type: String },
  assignedToId:    { type: String },
  assignedToName:  { type: String },
  activatedAt:     { type: Date, default: Date.now },
  plannedDeadline: { type: Date },
  notified:        { type: Boolean, default: false }, // WhatsApp sent?
  reminderSent:    { type: Boolean, default: false }, // 1h reminder sent?
}, { _id: false });

// ─── FLOW INSTANCE SCHEMA ─────────────────────────────────────────────────────
const FlowInstanceSchema = new mongoose.Schema({
  tenantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  templateId:   { type: mongoose.Schema.Types.ObjectId, ref: 'FlowTemplate', required: true },
  templateName: { type: String },                     // denormalized for quick display

  // The unique order identifier (e.g. "ORD-2042")
  orderIdentifier: { type: String, required: true },

  // Full snapshot of the sheet row — read once, stored here, sheet never touched again
  rawSheetData: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Current state
  status:       { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
  activeStep:   { type: ActiveStepSchema, default: null },

  // Complete audit trail — every step that has been completed
  nodeHistory:  { type: [NodeHistorySchema], default: [] },

  // Timestamps
  startedAt:    { type: Date, default: Date.now },
  completedAt:  { type: Date, default: null },

}, { timestamps: true });

// Indexes
FlowInstanceSchema.index({ tenantId: 1, status: 1 });
FlowInstanceSchema.index({ tenantId: 1, templateId: 1 });
FlowInstanceSchema.index({ templateId: 1, orderIdentifier: 1 }, { unique: true });
FlowInstanceSchema.index({ 'activeStep.assignedToId': 1, status: 1 }); // getMyTasks
FlowInstanceSchema.index({ 'activeStep.plannedDeadline': 1, status: 1 }); // overdue check

module.exports = mongoose.model('FlowInstance', FlowInstanceSchema);
