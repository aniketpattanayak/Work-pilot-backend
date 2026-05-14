// server/models/Employee.js
// FIX P-4: Added indexes. Most critical: unique compound index on (tenantId, email)
//           to prevent duplicate accounts within a tenant and speed up login.

const mongoose = require('mongoose');

const EmployeeSchema = new mongoose.Schema({
  tenantId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:            { type: String, required: true },
  department:      String,
  whatsappNumber:  { type: String, required: true },
  email:           { type: String, required: true },
  password:        { type: String, required: true },
  weeklyLateTarget:{ type: Number, default: 20 },

  roles: {
    type: [String],
    enum: ['Assigner', 'Doer', 'Coordinator', 'Viewer', 'Admin'],
  },

  leaveStatus: {
    onLeave:  { type: Boolean, default: false },
    startDate:{ type: Date },
    endDate:  { type: Date },
    buddyId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  },

  earnedBadges: [
    {
      badgeId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant.badgeLibrary' },
      name:       String,
      iconName:   String,
      color:      String,
      unlockedAt: { type: Date, default: Date.now },
    },
  ],

  managedDoers:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
  managedAssigners:[{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],

  totalPoints: { type: Number, default: 0 },
  workOnSunday:{ type: Boolean, default: false },
  shadowName:  { type: String },

  createdAt: { type: Date, default: Date.now },
});

// ─── INDEXES ─────────────────────────────────────────────────────────────────
// Login query: Employee.findOne({ email, tenantId })
// Unique prevents duplicate accounts within the same company
EmployeeSchema.index({ tenantId: 1, email: 1 }, { unique: true });

// getEmployeeList: Employee.find({ tenantId })
EmployeeSchema.index({ tenantId: 1, createdAt: -1 });

// Buddy substitution: Employee.find({ 'leaveStatus.buddyId': doerId })
EmployeeSchema.index({ 'leaveStatus.buddyId': 1 });

// dispatchDailyBriefings: Employee.find({ tenantId })
EmployeeSchema.index({ tenantId: 1, whatsappNumber: 1 });

module.exports = mongoose.model('Employee', EmployeeSchema);
