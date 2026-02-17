const mongoose = require('mongoose');

/**
 * FMS NODE SCHEMA
 * Purpose: Defines a single task within a flow.
 * Updated: Supports relative time planning (e.g., 2 hours after previous step).
 */
const FmsNodeSchema = new mongoose.Schema({
  nodeName: { type: String, required: true }, // e.g., "Confirm Billing"
  
  // Logical order of the step (0, 1, 2, etc.)
  stepIndex: { type: Number, default: 0 }, 
  
  // Integration Fields (Kept for initial trigger or write-back)
  sheetColumn: { type: String }, 
  emailColumn: { type: String, required: true }, // To identify the doer
  
  type: { 
    type: String, 
    enum: ['Action', 'Decision'], 
    default: 'Action' 
  },

  // NEW: RELATIVE TIME PLANNING FIELDS
  // Example: 2 [Value] hours [Unit] after the previous step is marked "Done"
  offsetValue: { type: Number, default: 0 }, 
  offsetUnit: { 
    type: String, 
    enum: ['minutes', 'hours', 'days'], 
    default: 'hours' 
  },

  // For 'Decision' type nodes
  branches: [{
    label: String, // e.g., "Stock Available"
    value: String, // Value written back to Sheets (if connected)
    nextStepIndex: Number 
  }],

  // Legacy/Monitoring fields
  assignedRole: String, // Backup role
  slaHours: { type: Number, default: 24 } 
});

/**
 * FMS TEMPLATE SCHEMA
 * Purpose: The blueprint/master plan for a specific factory process.
 */
const FmsTemplateSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  flowName: { type: String, required: true },
  
  // TRIGGER CONFIGURATION
  // Used to detect when a "New Order" arrives to start the clock for Step 1
  googleSheetId: { type: String, required: true },
  scriptUrl: { type: String, required: true }, 
  tabName: { type: String, required: true },
  uniqueIdentifierColumn: { type: String, default: "Timestamp" },

  // The sequence of timed nodes
  nodes: [FmsNodeSchema], 
  
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('FmsTemplate', FmsTemplateSchema);