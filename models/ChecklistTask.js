const mongoose = require('mongoose');

const ChecklistTaskSchema = new mongoose.Schema({
  tenantId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Tenant', 
    required: true 
  },
  taskName: { 
    type: String, 
    required: true 
  },
  description: { 
    type: String 
  },
  doerId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Employee', 
    required: true 
  },
  frequency: {
    type: String, 
    // UPDATED: Added 'Interval' to support "Every X days" logic
    enum: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Interval'],
    required: true
  },
  frequencyConfig: {
    /** * For "Twice/Thrice a Week": Use an array of numbers (0-6) 
     * e.g., [1, 3, 5] for Mon, Wed, Fri
     */
    daysOfWeek: { type: [Number], default: [] }, 
    
    /** * For "Multiple times a Month": Use an array of dates (1-31)
     * e.g., [1, 15] for the 1st and 15th of every month
     */
    daysOfMonth: { type: [Number], default: [] },

    /**
     * For "10 times a month" or "Every 3 days":
     * Set frequency to 'Interval' and intervalDays to 3.
     */
    intervalDays: { type: Number, default: 0 },

    // Preserving your original single-value fields for backward compatibility
    dayOfWeek: Number, 
    dayOfMonth: Number, 
    month: Number
  },
  lastCompleted: { 
    type: Date 
  },
  nextDueDate: { 
    type: Date, 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['Active', 'Paused'], 
    default: 'Active' 
  },
  history: [{
    action: String,
    timestamp: { type: Date, default: Date.now },
    remarks: String,
    attachmentUrl: String,
    instanceDate: Date // CRITICAL: Added to track exactly which day was finished in the backlog
  }],
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

// CRITICAL: This is what allows ChecklistTask.find() to work
module.exports = mongoose.model('ChecklistTask', ChecklistTaskSchema);