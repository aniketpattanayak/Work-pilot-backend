const mongoose = require('mongoose');

const EmployeeSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name: { type: String, required: true },
  department: String,
  whatsappNumber: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  
  // UPDATED: Changed from 'role: String' to 'roles: [String]'
  roles: { 
    type: [String], 
    enum: ['Assigner', 'Doer', 'Coordinator', 'Viewer', 'Admin']
  },
  earnedBadges: [
    {
      badgeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant.badgeLibrary' },
      name: String,        // Denormalized for faster UI rendering
      iconName: String,    // Denormalized for faster UI rendering
      color: String,
      unlockedAt: { type: Date, default: Date.now }
    }
  ],
  
  managedDoers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
  managedAssigners: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
  // Add this field to your EmployeeSchema
  totalPoints: { 
    type: Number, 
    default: 0 
},
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Employee', EmployeeSchema);