const mongoose = require('mongoose');

// ─── INPUT FIELD SCHEMA ───────────────────────────────────────────────────────
// Defines a data-capture field on a node (number, text, dropdown etc.)
const InputFieldSchema = new mongoose.Schema({
  id:       { type: String, required: true },   // unique within node e.g. "field_1"
  label:    { type: String, required: true },   // shown to employee e.g. "Qty confirmed"
  type:     {
    type: String,
    enum: ['number', 'text', 'dropdown', 'date', 'checkbox'],
    default: 'text'
  },
  options:  { type: [String], default: [] },    // for dropdown only
  required: { type: Boolean, default: false },
}, { _id: false });

// ─── NODE SCHEMA ──────────────────────────────────────────────────────────────
// One node = one step in the flow. Nodes are connected by nextNodeId pointers.
const NodeSchema = new mongoose.Schema({
  id:   { type: String, required: true },        // unique within template e.g. "node_abc123"
  name: { type: String, required: true },        // e.g. "RM Check"
  type: {
    type: String,
    enum: ['start', 'action', 'yesno', 'input', 'end'],
    required: true,
  },

  // Who does this step
  // type: 'employee' → value is an employee _id string
  // type: 'sheetColumn' → value is a column name in rawSheetData (dynamic per order)
  assignedTo: {
    type:  { type: String, enum: ['employee', 'sheetColumn'], default: 'employee' },
    value: { type: String, default: '' },
  },

  // Deadline configuration
  // mode: 'wwh'      → T+N hours, stays inside working hours (plannedwwh logic)
  // mode: 'wwh2'     → T+N hours, trigger was outside working hours (plannedwwh2)
  // mode: 'days'     → T+N full working days (plannedindays)
  // mode: 'lead'     → T-N days before a date column in the sheet row (plannedlead)
  // mode: 'specific' → fixed time of day, N working days after prev step (specificTime)
  // mode: null       → no deadline (start/end nodes)
  deadline: {
    mode:       { type: String, enum: ['wwh', 'wwh2', 'days', 'lead', 'specific', null], default: null },
    value:      { type: Number, default: 0 },      // N (hours or days)
    timeOfDay:  { type: Number, default: null },    // for 'specific': hour e.g. 15 = 3pm
    dateColumn: { type: String, default: null },    // for 'lead': which rawSheetData key holds the target date
  },

  // Which rawSheetData keys to display to the employee at this step
  sheetColumnsToShow: { type: [String], default: [] },

  // Input fields the employee must/can fill before completing
  inputFields: { type: [InputFieldSchema], default: [] },

  // Question shown for Yes/No nodes
  question: { type: String, default: '' },

  // Routing — which node comes next
  nextNodeId:    { type: String, default: null },  // action / input / start nodes
  yesNextNodeId: { type: String, default: null },  // yesno nodes — yes path
  noNextNodeId:  { type: String, default: null },  // yesno nodes — no path

  // Notification channel for when this step becomes active
  notifyChannel: {
    type: String,
    enum: ['whatsapp', 'inapp', 'both', 'none'],
    default: 'both',
  },

  // Canvas position (for the visual builder UI)
  position: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
  },
}, { _id: false });

// ─── FLOW TEMPLATE SCHEMA ─────────────────────────────────────────────────────
const FlowTemplateSchema = new mongoose.Schema({
  tenantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:      { type: String, required: true },           // e.g. "Navtech O2D"
  isActive:  { type: Boolean, default: true },

  // Google Sheet connection (read-only — WorkPilot never writes to the sheet)
  googleSheetId:   { type: String, required: true },
  scriptUrl:       { type: String, required: true },
  tabName:         { type: String, default: 'Sheet1' },
  uniqueIdColumn:  { type: String, default: 'Order ID' }, // column that holds the order identifier

  // Working hours for deadline calculation
  workingHours: {
    open:     { type: Number, default: 9 },              // opening hour (24h) e.g. 9
    close:    { type: Number, default: 18 },             // closing hour e.g. 18
    workDays: { type: [Number], default: [1,2,3,4,5] },  // 0=Sun,1=Mon...6=Sat
  },

  // The flow graph
  startNodeId: { type: String, required: true },          // id of the first node to activate
  nodes:       { type: [NodeSchema], required: true },

  createdAt: { type: Date, default: Date.now },
});

// Indexes
FlowTemplateSchema.index({ tenantId: 1, isActive: 1 });
FlowTemplateSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('FlowTemplate', FlowTemplateSchema);
