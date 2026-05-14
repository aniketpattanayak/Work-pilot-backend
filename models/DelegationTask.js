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
    },
  ],

  files: [
    {
      fileName:   String,
      fileUrl:    String,
      uploadedAt: { type: Date, default: Date.now },
    },
  ],

  createdAt: { type: Date, default: Date.now },
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
