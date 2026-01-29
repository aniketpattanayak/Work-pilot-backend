const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema({
  companyName: { type: String, required: true },
  subdomain: { type: String, required: true, unique: true }, // e.g., 'xyz-factory'
  adminEmail: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  
  // Settings for the company
  officeHours: {
    opening: String, // e.g., "09:00"
    closing: String  // e.g., "18:00"
  },

  /**
   * CUSTOM WEEKEND CONFIGURATION
   * Stores array of day indexes (0=Sunday, 1=Monday, ..., 6=Saturday)
   * Default is set to [0] (Sunday only)
   */
  weekends: {
    type: [Number],
    default: [0] 
  },

  holidays: [
    {
      name: String,
      date: Date
    }
  ],
  logo: { 
    type: String, 
    default: null // Stores the AWS S3 URL or local path
  },

  // WhatsApp Configuration (Stored per client)
  whatsappConfig: {
    isActive: { type: Boolean, default: false },
    apiKey: String,
    instanceId: String
  },

  // Point system mechanics
  pointSettings: {
    isActive: { type: Boolean, default: false }, // Admin can toggle the whole system ON/OFF
    brackets: [
      {
        label: { type: String, required: true }, // e.g., "Quick Tasks", "Project Phase"
        maxDurationDays: { type: Number, required: true }, // The 'Up to X days' limit
        pointsUnit: { type: String, enum: ['hour', 'day'], default: 'hour' },
        earlyBonus: { type: Number, default: 0 }, // Points gained per unit early
        latePenalty: { type: Number, default: 0 }  // Points lost per unit late
      }
    ]
  },

  // Gamification Assets
  badgeLibrary: [
    {
      name: { type: String, required: true },         // e.g., "Night Owl"
      description: { type: String },                  // e.g., "Awarded for 1000 total points"
      pointThreshold: { type: Number, required: true }, // Points needed to unlock
      iconName: { type: String, default: 'Star' },    // Key for Lucide icon or S3 URL
      color: { type: String, default: '#fbbf24' },    // Custom HEX for the badge glow
      createdAt: { type: Date, default: Date.now }
    }
  ],
  
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Tenant', TenantSchema);