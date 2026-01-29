const mongoose = require('mongoose');

const EmployeeSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name: { type: String, required: true },
  department: String,
  whatsappNumber: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  
  // Array of roles for multi-permission access
  roles: { 
    type: [String], 
    enum: ['Assigner', 'Doer', 'Coordinator', 'Viewer', 'Admin']
  },

  /**
   * BUDDY CONFIGURATION (LEAVE SUBSTITUTION)
   * Purpose: Automatically reroute Checklist tasks when a staff member is away.
   */
  leaveStatus: {
    onLeave: { type: Boolean, default: false },
    startDate: { type: Date },
    endDate: { type: Date },
    buddyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' } 
  },

  // Gamification: Earned badges denormalized for UI speed
  earnedBadges: [
    {
      badgeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant.badgeLibrary' },
      name: String,        
      iconName: String,    
      color: String,
      unlockedAt: { type: Date, default: Date.now }
    }
  ],
  
  // Hierarchical Mapping
  managedDoers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
  managedAssigners: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
  
  // Performance Engine
  totalPoints: { 
    type: Number, 
    default: 0 
  },
  
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Employee', EmployeeSchema);