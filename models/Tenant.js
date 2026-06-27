const mongoose = require('mongoose');

/**
 * TENANT MODEL v2.0
 * Purpose: Global configuration for individual factories (ARV, Navtech, etc.).
 * Updated: Added automated reporting fields for factory admins.
 */
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
      // Subscription control
  subscription: {
    status:   { type: String, enum: ['active', 'paused'], default: 'active' },
    pausedAt: { type: Date, default: null },
    pausedBy: { type: String, default: null }, // superadmin username
    reason:   { type: String, default: '' },
  },

  createdAt: { type: Date, default: Date.now }
    }
  ],

  /**
   * AUTOMATED REPORTING SETTINGS
   * These fields store the specific preferences for each factory admin.
   */
  reportEmail: { 
    type: String, 
    default: "" 
  },
  weeklyReportDay: { 
    type: String, 
    default: "Saturday" 
  },
  monthlyReportDate: { 
    type: Number, 
    default: 1 
  },
  
  createdAt: { type: Date, default: Date.now },

  // ── SuperAdmin controls ──────────────────────────────────────
  superAdmin: {
    // Subscription status
    status:        { type: String, enum: ['active', 'paused', 'suspended'], default: 'active' },
    pausedAt:      { type: Date,   default: null },
    pausedBy:      { type: String, default: '' },
    pauseReason:   { type: String, default: '' },
    scheduledPauseFrom: { type: Date, default: null },
    scheduledPauseTo:   { type: Date, default: null },

    // Limits
    employeeLimit:   { type: Number, default: 50 },   // max employees allowed
    whatsappLimit:   { type: Number, default: 1000 },  // max WA msgs per month

    // Feature flags — toggle modules on/off per tenant
    features: {
      tasks:        { type: Boolean, default: true },
      fms:          { type: Boolean, default: true },
      chat:         { type: Boolean, default: true },
      reports:      { type: Boolean, default: true },
      orderForms:   { type: Boolean, default: true },
      whatsapp:     { type: Boolean, default: true },
      rewards:      { type: Boolean, default: true },
      checklist:    { type: Boolean, default: true },
    },

    // Billing
    plan:        { type: String, enum: ['free', 'starter', 'pro', 'enterprise', 'custom'], default: 'free' },
    amount:      { type: Number, default: 0 },
    renewalDate: { type: Date,   default: null },
    billingNote: { type: String, default: '' },

    // Notes from superadmin
    internalNote: { type: String, default: '' },
  },
});

module.exports = mongoose.model('Tenant', TenantSchema);