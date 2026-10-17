// server/models/VoiceCallLog.js
// One row per voice call (outbound check-in, inbound task creation, inbound admin inquiry)
// and per scheduled callback. Lives in the shared database (central ops log), always carrying tenantId.
// New collection only: nothing in tasks / employees / tenants is read from or written to this model.

const mongoose = require('mongoose');

const TaskOutcomeSchema = new mongoose.Schema({
  taskId:           { type: mongoose.Schema.Types.ObjectId },
  taskTitle:        String,
  finished:         { type: Boolean, default: false },
  blockerReason:    String,                 // why it is not finished (doer's own words, tidied)
  expectedFinishAt: Date,                   // the doer's new expected finish time
}, { _id: false });

const VoiceCallLogSchema = new mongoose.Schema({
  tenantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  employeeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeName: String,
  phone:       String,                      // E.164 number that was called / that called in

  direction:   { type: String, enum: ['outbound', 'inbound'], required: true },
  purpose:     { type: String, enum: ['doer_checkin', 'assigner_create_task', 'admin_inquiry', 'rejected'], required: true },
  roles:       [String],                    // roles the caller had when the call started

  // Provider ids
  provider:    { type: String, default: 'vapi' },
  providerCallId: { type: String, index: true, sparse: true },

  status:      { type: String, enum: ['queued', 'ringing', 'in-progress', 'completed', 'failed', 'no-answer', 'rejected'], default: 'queued' },
  startedAt:   Date,
  endedAt:     Date,
  endedReason: String,
  durationSec: Number,

  // What the call was about (outbound doer check-in)
  taskIds:     [{ type: mongoose.Schema.Types.ObjectId }],
  taskOutcomes: [TaskOutcomeSchema],

  // Call artifacts
  recordingUrl: String,
  transcript:   String,
  summary:      String,

  // Reason / blocker details (the first blocker is mirrored here for quick listing)
  blockerReason:    String,
  expectedFinishAt: Date,

  // Follow-up callback
  callbackAt:       Date,
  callbackStatus:   { type: String, enum: ['none', 'pending', 'placed', 'cancelled', 'failed'], default: 'none' },
  callbackAttempts: { type: Number, default: 0 },
  callbackOfCallId: { type: mongoose.Schema.Types.ObjectId, ref: 'VoiceCallLog' }, // set on the call that was placed as a callback

  // Inbound task creation
  createdTaskIds:   [{ type: mongoose.Schema.Types.ObjectId }],

  // Idempotency: a provider can retry a tool call; each toolCallId is applied once.
  handledToolCalls: [String],

  createdAt: { type: Date, default: Date.now },
});

VoiceCallLogSchema.index({ callbackStatus: 1, callbackAt: 1 });
VoiceCallLogSchema.index({ tenantId: 1, employeeId: 1, createdAt: -1 });

module.exports = mongoose.model('VoiceCallLog', VoiceCallLogSchema);
