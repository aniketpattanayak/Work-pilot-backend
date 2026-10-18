// server/models/DelegationTask.js
// FIX P-4: Added compound indexes on the most frequently queried fields.
//           Without indexes, every query performs a full collection scan.
//           These indexes match the exact query patterns in taskController.js.

const mongoose = require('mongoose');

const DelegationTaskSchema = new mongoose.Schema({
  tenantId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  title:         { type: String, required: true },
  description:   { type: String },

  // People Involved
  assignerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  doerId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  coordinatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  coworkers:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],

  // Onward-assignment chain: people who received this task and passed it on, oldest first.
  // Full chain shown to users = assignerId -> forwardChain[0] -> forwardChain[1] ... -> doerId
  forwardChain: [
    {
      employeeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
      forwardedAt: { type: Date, default: Date.now },
    },
  ],

  helperDoers: [
    {
      helperId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
      name: String,
    },
  ],

  // Task Details
  priority: {
    type: String,
    enum: ['Low', 'Medium', 'High', 'Urgent'],
    default: 'Medium',
  },
  deadline:          { type: Date, required: true },
  proposedDeadline:  { type: Date },
  isRevisionAllowed: { type: Boolean, default: true },
  // How many days past the deadline the doer may move it (0 = old behaviour: ask the assigner to approve)
  maxExtensionDays:  { type: Number, default: 0, min: 0, max: 90 },
  originalDeadline:  { type: Date },   // the deadline before the doer revised it
  revisedAt:         { type: Date },
  revisedByDoerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }, // the doer whose revision moved the deadline
  status: {
    type: String,
    enum: ['Pending', 'Accepted', 'Revision Requested', 'Completed', 'Verified', 'Rejected'],
    default: 'Pending',
  },
  remarks: { type: String },

  history: [
    {
      action:      String,
      performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
      timestamp:   { type: Date, default: Date.now },
      remarks:     String,
      // The exact photos sent along with THIS action (a subset/copy of
      // what also lands in the flat `files` array below) - so the History
      // & Files view can show each photo directly under the stage that
      // produced it, instead of a disconnected gallery the viewer has to
      // match up by eye.
      files: [{ fileName: String, fileUrl: String, _id: false }],
    },
  ],

  files: [
    {
      fileName:   String,
      fileUrl:    String,
      uploadedAt: { type: Date, default: Date.now },
      // Who uploaded it and at which stage of the task - so the History &
      // Files view can say e.g. "Task Created — Lalit Raj" next to this
      // photo instead of leaving every viewer to guess which side sent it.
      uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
      stage:      String, // mirrors the history action that produced this file, e.g. "Task Created", "Completed", "Accepted" (rejection/send-back)
    },
  ],

  // Company-defined extra fields (see CustomFieldDefinition). Old records simply have an empty map.
  customFields: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => ({}) },

  createdAt: { type: Date, default: Date.now },
}, {
  // Map values (customFields) must come out as plain objects, also from toObject()
  toObject: { flattenMaps: true },
  toJSON:   { flattenMaps: true },
});

// ─── INDEXES ─────────────────────────────────────────────────────────────────
// getDoerTasks, completeChecklistTask: filter by doerId + status
DelegationTaskSchema.index({ doerId: 1, status: 1 });

// getAssignerTasks: filter by assignerId
DelegationTaskSchema.index({ assignerId: 1, createdAt: -1 });

// getCoordinatorTasks: filter by coordinatorId
DelegationTaskSchema.index({ coordinatorId: 1, status: 1 });

// getGlobalPerformance, dispatchDailyBriefings: filter by tenantId
DelegationTaskSchema.index({ tenantId: 1, status: 1 });

// Buddy substitution query: leaveStatus.buddyId lookup
DelegationTaskSchema.index({ 'helperDoers.helperId': 1 });

// Deadline range queries (daily briefings, overdue detection)
DelegationTaskSchema.index({ deadline: 1, status: 1 });

module.exports = mongoose.model('DelegationTask', DelegationTaskSchema);
