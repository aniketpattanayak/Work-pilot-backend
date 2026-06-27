const mongoose = require('mongoose');

/**
 * Message — one per chat message
 * Auto-deleted after 30 days via MongoDB TTL index
 * No delete by anyone — permanent for 30 days
 */
const MessageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  tenantId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  senderId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  senderName:     { type: String, required: true },
  senderRole:     { type: String, default: '' },

  // Content
  text:    { type: String, default: '' },
  fileUrl: { type: String, default: '' },  // S3 or local upload URL
  fileName:{ type: String, default: '' },  // original filename
  fileType:{ type: String, default: '' },  // image/pdf/doc etc.

  // Read receipts — array of employeeIds who have seen this message
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],

  // @mentions — notify these employees
  mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],

  // TTL — MongoDB auto-deletes after 30 days
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

// TTL index — MongoDB deletes documents when expiresAt is reached
MessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ tenantId: 1, senderId: 1 });

module.exports = mongoose.model('Message', MessageSchema);
