const mongoose = require('mongoose');

/**
 * STEP TRACKING SCHEMA
 * Individual step performance within a live order.
 */
const StepTrackingSchema = new mongoose.Schema({
  nodeName: String,
  stepIndex: Number,

   assignedTo: String, // ✅ ADD THIS
   
  
  // The calculated "Target Time" (Current Time + Offset)
  plannedDeadline: Date,
  
  // The actual time the doer clicked "Done"
  actualCompletedAt: Date,
  
  status: { 
    type: String, 
    enum: ['Pending', 'Completed', 'Delayed'], 
    default: 'Pending' 
  },






  inputType: String, // copied from template

decision: {
  type: String,
  enum: ['Yes', 'No', null],
  default: null
},

isPaused: {
  type: Boolean,
  default: false
},

pausedAt: Date,


remarks: { type: String, default: "" },





  
  // Calculated automatically: (actualCompletedAt - plannedDeadline)
  delayInMinutes: { type: Number, default: 0 }
});

/**
 * FMS INSTANCE SCHEMA
 * Represents a single live order moving through the factory flow.
 */
const FmsInstanceSchema = new mongoose.Schema({
  tenantId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Tenant', 
    required: true 
  },
  templateId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'FmsTemplate', 
    required: true 
  },
  
  // e.g., "Order #786", "Batch-A1", or "Sheet Row ID"
  orderIdentifier: { 
    type: String, 
    required: true 
  }, 

  sheetRowId: String, // ✅ ADD THIS4


  sheetDataId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'FmsSheetData'
},

  
  // Deep copy of nodes from the Template to track this specific order's journey
  steps: [StepTrackingSchema],
  
  // Tracks which step is currently active (0, 1, 2...)
  currentStepIndex: { 
    type: Number, 
    default: 0 
  },
  
  isFullyCompleted: { 
    type: Boolean, 
    default: false 
  },
  
  startedAt: { 
    type: Date, 
    default: Date.now 
  }
}, { timestamps: true });

module.exports = mongoose.model('FmsInstance', FmsInstanceSchema);