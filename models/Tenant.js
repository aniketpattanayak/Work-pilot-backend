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

  // Company-defined lists used by the dropdowns in Add Employee (edited in Settings)
  sectors:   { type: [String], default: [] },
  locations: { type: [String], default: [] },

  // Company-defined WhatsApp country-code list for the employee form's
  // country dropdown (edited in Settings). Additive and optional: an empty
  // or missing list means the frontend falls back to its built-in default
  // list, so nothing changes for existing companies that never touch this.
  phoneCountries: {
    type: [{
      _id: false,
      id:       { type: String, required: true },
      name:     { type: String, required: true },
      flag:     { type: String, default: '' },
      dialCode: { type: String, required: true },
    }],
    default: [],
  },

  // Custom access roles (attendance / leave / payroll permissions) made by the company's Admin
  accessRoles: [{
    _id: false,
    key:         { type: String, required: true },
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    permissions: [{ _id: false, key: String, scope: String }],
    createdBy:   { type: mongoose.Schema.Types.ObjectId },
    createdAt:   { type: Date, default: Date.now }
  }],
  // HR modules are off for every company until the platform owner switches them on
  hrModules: {
    attendance: { type: Boolean, default: false },
    leave:      { type: Boolean, default: false },
    payroll:    { type: Boolean, default: false }
  },
  // Leave settings: month the leave year starts (1 = January ... 4 = April) and whether an approver may approve their own leave
  leaveConfig: {
    yearStartMonth:    { type: Number, default: 1, min: 1, max: 12 },
    allowSelfApproval: { type: Boolean, default: false }
  },
  // Attendance settings: location rule, face check, default shift and day lengths
  attendanceConfig: {
    requireLocation:  { type: Boolean, default: false },
    allowOutsideSite: { type: Boolean, default: true },
    faceMode:         { type: String, enum: ['off', 'optional', 'required'], default: 'off' },
    faceThreshold:    { type: Number, default: 0.5, min: 0.3, max: 0.7 },
    defaultShiftId:   { type: mongoose.Schema.Types.ObjectId, default: null },
    fullDayMinutes:   { type: Number, default: 480 },
    halfDayMinutes:   { type: Number, default: 240 },
    regularizeDays:   { type: Number, default: 31 },
    graceMinutes:     { type: Number, default: 10 }
  },

  // Payroll settings: how days are counted, rounding, who may approve, payslip header and the salary components (HRA, allowances, deductions)
  payrollConfig: {
    dayBasis:          { type: String, enum: ['calendar', '30'], default: 'calendar' },
    roundNet:          { type: Boolean, default: true },
    allowSelfApproval: { type: Boolean, default: false },
    requireReview:     { type: Boolean, default: false },   // a reviewer must mark the payroll Reviewed before it can be approved
    employerName:      { type: String, default: '' },
    employerAddress:   { type: String, default: '' },
    components: [{
      _id: false, key: String, name: String,
      type:   { type: String, enum: ['earning', 'deduction'] },
      calc:   { type: String, enum: ['fixed', 'percentBasic'], default: 'fixed' },
      value:  { type: Number, default: 0 },
      prorate:{ type: Boolean, default: true },
      active: { type: Boolean, default: true },
      pf:     { type: Boolean, default: false }   // earning counts as PF wages (Basic always does)
    }],
    // PF, ESI and professional tax settings (checked by utils/statutoryEngine.js); null = all off
    statutory: { type: mongoose.Schema.Types.Mixed, default: null }
  },

  // Review Meeting settings (all optional; defaults apply when nothing is saved)
  reviewConfig: {
    period: { type: String, enum: ['Daily', 'Weekly', 'TwiceMonthly', 'Monthly', 'Quarterly'], default: 'Monthly' },
    weights: {
      delegation: { type: Number, default: 1 },
      checklist:  { type: Number, default: 1 },
      fms:        { type: Number, default: 1 }
    },
    // location '' = every location, department '' = every department
    overrides: [{
      _id: false,
      location:   { type: String, default: '' },
      department: { type: String, default: '' },
      delegation: { type: Number, default: 1 },
      checklist:  { type: Number, default: 1 },
      fms:        { type: Number, default: 1 }
    }],
    thresholds: {
      red:    { type: Number, default: 20 },
      orange: { type: Number, default: 10 }
    },
    // Drift column colours (days): 0..greenMax green, up to yellowMax yellow, up to orangeMax orange, above = red
    driftBands: {
      greenMax:  { type: Number, default: 10 },
      yellowMax: { type: Number, default: 50 },
      orangeMax: { type: Number, default: 100 }
    }
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

  // Company-chosen settings: on/off switches and WhatsApp message overrides.
  // Nothing saved here = today's behaviour (see utils/settingsRegistry.js).
  companySettings: {
    switches:          { type: mongoose.Schema.Types.Mixed, default: {} },   // { 'delegation.doerRevise': false }
    dateChangeReasons: { type: [String], default: undefined },           // the list people pick a deadline-change reason from
    formLayouts:       { type: mongoose.Schema.Types.Mixed, default: {} },   // { employee: { fields: { name: { label, required, hidden } }, order: [] } }
    masterLists:       { type: mongoose.Schema.Types.Mixed, default: undefined }, // [{ key, label, items: [] }] lists a dropdown can be linked to
    whatsappTemplates: { type: mongoose.Schema.Types.Mixed, default: {} },   // { new_task_delegation_v2: { enabled, body, providerTemplate, senderPhoneId } }
    dailyAlert:        { type: mongoose.Schema.Types.Mixed, default: {} }    // { enabled, time: 'HH:MM', lastSentOn: 'YYYY-MM-DD' } Daily task reminder (platform owner must allow it)
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
    uploadLimitMb:   { type: Number, default: 10 },    // max size (MB) of each uploaded file

    // Custom database URI (optional — if set, tenant uses their own MongoDB)
    customMongoUri:    { type: String, default: '' },

    // Switches the company admin may NOT see (the platform owner decides). Empty = admin sees all.
    hiddenSwitches: { type: [String], default: [] },

    // Custom WhatsApp API key (optional — if set, overrides global DoubleTick key)
    customWhatsappKey: { type: String, default: '' },

    // Feature flags — toggle modules on/off per tenant
    features: {
      // Task modules
      tasks:        { type: Boolean, default: true },  // Manage Tasks + My Tasks
      personalTasks:{ type: Boolean, default: true },  // Personal Tasks (private to-do / checklist tab)
      checklist:    { type: Boolean, default: true },  // Manage Checklist
      fms:          { type: Boolean, default: true },  // Flow Management
      // Communication
      chat:         { type: Boolean, default: true },  // Chat
      whatsapp:     { type: Boolean, default: true },  // WhatsApp notifications
      // Management
      tracking:     { type: Boolean, default: true },  // Coordinator Tracking
      reviewMeeting:{ type: Boolean, default: true },  // Review Meeting
      employees:    { type: Boolean, default: true },  // Employees tab
      mapping:      { type: Boolean, default: true },  // Mapping tab
      // Forms & Orders
      orderForms:   { type: Boolean, default: true },  // Order Forms
      newOrder:     { type: Boolean, default: true },  // New Order
      // Analytics & Rewards
      reports:      { type: Boolean, default: true },  // Reports Hub
      rewards:      { type: Boolean, default: true },  // Rewards Log
      // Settings
      settings:     { type: Boolean, default: true },  // Settings tab
      // Things the platform owner must switch ON for a company (off until then)
      formDesigner: { type: Boolean, default: false }, // Settings > Form designer (rename / hide / reorder fields, new field types)
      menuControl:  { type: Boolean, default: false }, // Settings > Functions > Menu (switch side-menu sections off)
      planner: { type: Boolean, default: false },       // Planner tab (plans made of ordered steps that become tasks; off until switched on for a company)
      dailyTaskAlert: { type: Boolean, default: false }, // Daily WhatsApp reminder: overdue / today / tomorrow tasks (off until switched on for a company)
    },

    // Voice AI calling module (BETA). Default OFF; only the Superadmin can switch it on
    // (PUT /api/superadmin/tenants/:tenantId/voice). Even when on, only employees flagged
    // voiceBetaUser (with a verified phone) are ever called or answered.
    voiceModuleEnabled: { type: Boolean, default: false },

    // Billing
    plan:        { type: String, enum: ['free', 'starter', 'pro', 'enterprise', 'custom'], default: 'free' },
    amount:      { type: Number, default: 0 },
    renewalDate: { type: Date,   default: null },
    billingNote: { type: String, default: '' },

    // AI Assistant (Phase 4) — per-company kill switch, default OFF, plus a
    // SuperAdmin-settable monthly usage cap. Usage is a rolling counter reset
    // by month key (YYYY-MM) rather than a cron, to survive the server being down.
    aiAssistant: {
      enabled:          { type: Boolean, default: false },
      monthlyLimit:     { type: Number,  default: 500 },
      usageMonth:       { type: String,  default: '' },   // 'YYYY-MM' the counter below is for
      usageCount:       { type: Number,  default: 0 },
    },

    // Notes from superadmin
    internalNote: { type: String, default: '' },
  },
});

module.exports = mongoose.model('Tenant', TenantSchema);