// models/Plan.js
// A person's PRIVATE plan: a goal (optionally linked to an existing task) broken into ordered steps.
// A step stays a note until its owner turns it into a real Delegation or Checklist task; the task
// then carries planId / planStepId so the app can show it under the Planner tab.
const mongoose = require('mongoose');

const StepSchema = new mongoose.Schema({
  title:    { type: String, required: true, trim: true, maxlength: 200 },
  notes:    { type: String, default: '', maxlength: 2000 },
  priority: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Medium' },
  kind:     { type: String, enum: ['Delegation', 'Checklist'], default: 'Delegation' },
  // Set once the step has been turned into a real task
  taskId:   { type: mongoose.Schema.Types.ObjectId },
  taskType: { type: String, enum: ['Delegation', 'Checklist', ''], default: '' },
  createdAt:{ type: Date, default: Date.now },
});

const PlanSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  ownerId:  { type: mongoose.Schema.Types.ObjectId, required: true },
  title:    { type: String, required: true, trim: true, maxlength: 200 },
  notes:    { type: String, default: '', maxlength: 2000 },
  // The existing task this plan is for (optional)
  linkedTask: {
    taskType: { type: String, enum: ['Delegation', 'Checklist', ''], default: '' },
    taskId:   { type: mongoose.Schema.Types.ObjectId },
    title:    { type: String, default: '' },
  },
  steps:    { type: [StepSchema], default: [] },
  order:    { type: Number, default: 0 },
  createdAt:{ type: Date, default: Date.now },
  updatedAt:{ type: Date, default: Date.now },
});
PlanSchema.index({ tenantId: 1, ownerId: 1, order: 1 });

module.exports = mongoose.models.Plan || mongoose.model('Plan', PlanSchema);
