const mongoose = require('mongoose');

/**
 * Conversation — one per chat thread
 * type: 'dm'          → 1-on-1 between two employees
 * type: 'task'        → thread attached to a delegation task or FMS step
 * type: 'announcement'→ admin broadcast to all employees (read-only for non-admins)
 */
const ConversationSchema = new mongoose.Schema({
  tenantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  type:         { type: String, enum: ['dm', 'task', 'announcement'], required: true },

  // For DMs — exactly 2 participants
  // For task threads — all people involved in that task
  // For announcements — empty (everyone in tenant sees it)
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],

  // For task-type conversations
  taskId:       { type: mongoose.Schema.Types.ObjectId, default: null }, // DelegationTask or FlowInstance id
  taskType:     { type: String, enum: ['delegation', 'flow', null], default: null },
  taskTitle:    { type: String, default: '' }, // cached for display

  // For announcements
  title:        { type: String, default: '' },

  // Latest message cache — for sidebar preview
  lastMessage: {
    text:      { type: String, default: '' },
    senderId:  { type: mongoose.Schema.Types.ObjectId, default: null },
    senderName:{ type: String, default: '' },
    sentAt:    { type: Date, default: null },
    hasFile:   { type: Boolean, default: false },
  },

  // Unread counts per participant: { employeeId: count }
  unreadCounts: { type: Map, of: Number, default: {} },

  isActive: { type: Boolean, default: true },
}, { timestamps: true });

ConversationSchema.index({ tenantId: 1, type: 1 });
ConversationSchema.index({ tenantId: 1, participants: 1 });
ConversationSchema.index({ tenantId: 1, taskId: 1 });

module.exports = mongoose.model('Conversation', ConversationSchema);
