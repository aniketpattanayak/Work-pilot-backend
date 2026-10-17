// models/PersonalTask.js
// A person's PRIVATE to-do list and repeating checklist. This is deliberately a separate
// collection from DelegationTask / ChecklistTask: nothing here is ever read by points,
// dashboards, reports, reviews, tracking, the admin lists or the AI assistant. It is only
// returned to its owner, plus (read-only) to assigners the owner chose to share it with.
const mongoose = require('mongoose');

const PersonalTaskSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  ownerId:  { type: mongoose.Schema.Types.ObjectId, required: true },
  type:     { type: String, enum: ['Task', 'Checklist'], required: true },
  title:    { type: String, required: true, trim: true, maxlength: 200 },
  notes:    { type: String, default: '', maxlength: 2000 },
  priority: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Medium' },

  // Dates are plain 'YYYY-MM-DD' strings so they never shift with server time zones.
  dueDate:  { type: String, default: '' },          // Task: optional due date

  // Task state
  done:     { type: Boolean, default: false },
  doneAt:   { type: Date },

  // Checklist schedule
  frequency: { type: String, enum: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Interval', ''], default: '' },
  frequencyConfig: {
    daysOfWeek:   { type: [Number], default: [] },
    daysOfMonth:  { type: [Number], default: [] },
    intervalDays: { type: Number, default: 0 },
  },
  startDate:   { type: String, default: '' },
  nextDueDate: { type: String, default: '' },
  lastDoneDate:{ type: String, default: '' },
  doneCount:   { type: Number, default: 0 },
  history:     { type: [{ instanceDate: String, completedAt: { type: Date, default: Date.now } }], default: [] },

  // Manual position (drag to reorder). Lower = higher in the list.
  order:      { type: Number, default: 0 },
  // Assigners this person chose to show the item to (read-only for them).
  sharedWith: [{ type: mongoose.Schema.Types.ObjectId }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

PersonalTaskSchema.index({ tenantId: 1, ownerId: 1, order: 1 });
PersonalTaskSchema.index({ tenantId: 1, sharedWith: 1 });

module.exports = mongoose.models.PersonalTask || mongoose.model('PersonalTask', PersonalTaskSchema);
