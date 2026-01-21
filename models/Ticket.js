const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  
  // Context Capture
  reporterName: { type: String, required: true },
  reporterEmail: { type: String, required: true },
  reporterRole: { type: String, required: true }, // Captures 'Doer', 'Assigner', etc.
  
  title: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String, default: "Technical" },
  priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  
  // Media Payloads (S3 URLs)
  initialMedia: [{
    fileName: String,
    fileUrl: String,
    fileType: String, // 'image' or 'video'
    uploadedAt: { type: Date, default: Date.now }
  }],
  
  status: { 
    type: String, 
    enum: ['Open', 'In-Progress', 'Resolved', 'Closed'], 
    default: 'Open' 
  },
  
  // Admin Resolution Data
  adminRemarks: { type: String },
  resolutionMedia: [{
    fileName: String,
    fileUrl: String,
    uploadedAt: { type: Date, default: Date.now }
  }],
  resolvedAt: { type: Date },
  
  history: [{
    action: String,
    performedBy: String,
    timestamp: { type: Date, default: Date.now },
    remarks: String
  }]
}, { timestamps: true });

module.exports = mongoose.model('SupportTicket', TicketSchema);