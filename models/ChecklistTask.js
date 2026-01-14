const mongoose = require('mongoose');

const ChecklistTaskSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  taskName: { type: String, required: true },
  description: { type: String },
  doerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  frequency: {
    type: String, 
    enum: ['Daily', 'Weekly', 'Monthly', 'Yearly'],
    required: true
  },
  frequencyConfig: {
    dayOfWeek: Number, 
    dayOfMonth: Number, 
    month: Number
  },
  lastCompleted: { type: Date },
  nextDueDate: { type: Date, required: true },
  status: { type: String, enum: ['Active', 'Paused'], default: 'Active' },
  history: [{
    action: String,
    timestamp: { type: Date, default: Date.now },
    remarks: String,
    attachmentUrl: String
  }],
  createdAt: { type: Date, default: Date.now }
});

// CRITICAL: This is what allows ChecklistTask.find() to work
module.exports = mongoose.model('ChecklistTask', ChecklistTaskSchema);