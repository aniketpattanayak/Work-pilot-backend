const mongoose = require('mongoose');

const DelegationTaskSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  title: { type: String, required: true },
  description: { type: String },
  
  // People Involved
  assignerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  doerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  coordinatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  coworkers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }], 

  helperDoers: [
    {
      helperId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
      name: String // Denormalized for faster UI rendering
    }
  ],
  // Task Details
  priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  deadline: { type: Date, required: true },
  
  isRevisionAllowed: { type: Boolean, default: true }, 
  status: { 
    type: String, 
    enum: ['Pending', 'Accepted', 'Revision Requested', 'Completed', 'Verified', 'Rejected'], 
    default: 'Pending' 
  },
  
  history: [
    {
      action: String,
      performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
      timestamp: { type: Date, default: Date.now },
      remarks: String
    }
  ],

  // UPDATED: Store detailed file information
  files: [{
    fileName: String,
    fileUrl: String,
    uploadedAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DelegationTask', DelegationTaskSchema);