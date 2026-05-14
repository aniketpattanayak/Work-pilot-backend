const mongoose = require('mongoose');

const FmsHistorySchema = new mongoose.Schema({
  instanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'FmsInstance' },

  templateId: {   // ✅ ADD THIS
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FmsTemplate'
  },

  stepIndex: Number,

  nodeName: String,
  orderIdentifier: String,

  action: {
    type: String,
    enum: [
      'CREATED',
      'ASSIGNED',
      'STARTED',
      'COMPLETED',
      'DELAYED',
      'PAUSED',
      'RESUMED',
      'DECISION_TAKEN',
      'REMARK_ADDED',
      'DEADLINE_UPDATED'
    ]
  },

  performedBy: String, // email / user
  assignedTo: String,

  oldValue: mongoose.Schema.Types.Mixed,
  newValue: mongoose.Schema.Types.Mixed,

  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('FmsHistory', FmsHistorySchema);