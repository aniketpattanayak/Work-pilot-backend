// server/models/ChecklistTask.js
// FIX P-4: Added indexes on the most frequently queried fields.
//           getChecklistTasks queries by doerId; getAllChecklists by tenantId.

const mongoose = require('mongoose');

const ChecklistTaskSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  taskName: { type: String, required: true },
  description: { type: String },
  doerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  frequency: {
    type: String,
    enum: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Interval'],
    required: true,
  },
  frequencyConfig: {
    // For "Twice/Thrice a Week": array of day numbers (0-6), e.g. [1, 3, 5]
    daysOfWeek: { type: [Number], default: [] },
    // For "Multiple times a Month": array of dates (1-31), e.g. [1, 15]
    daysOfMonth: { type: [Number], default: [] },
    // For "Every X days": set frequency to 'Interval', intervalDays to X
    intervalDays: { type: Number, default: 0 },
    // Legacy single-value fields kept for backward compatibility
    dayOfWeek:  Number,
    dayOfMonth: Number,
    month:      Number,
  },
  lastCompleted: { type: Date },
  nextDueDate:   { type: Date, required: true },
  status: {
    type: String,
    enum: ['Active', 'Paused'],
    default: 'Active',
  },
  history: [
    {
      action:        String,
      timestamp:     { type: Date, default: Date.now },
      remarks:       String,
      attachmentUrl: String,
      instanceDate:  Date, // Tracks exactly which day was completed in backlog
    },
  ],
  createdAt: { type: Date, default: Date.now },
});

// ─── INDEXES ─────────────────────────────────────────────────────────────────
// getChecklistTasks: find({ doerId }) — the hottest query path
ChecklistTaskSchema.index({ doerId: 1, status: 1 });

// getAllChecklists: find({ tenantId }) — admin/coordinator overview
ChecklistTaskSchema.index({ tenantId: 1, status: 1 });

// Overdue detection: find tasks where nextDueDate has passed
ChecklistTaskSchema.index({ nextDueDate: 1, status: 1 });

// Compound for tenant + doer scoped queries
ChecklistTaskSchema.index({ tenantId: 1, doerId: 1 });

module.exports = mongoose.model('ChecklistTask', ChecklistTaskSchema);
