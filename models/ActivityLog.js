const mongoose = require('mongoose');

/**
 * ActivityLog — records every meaningful action in the system
 * Used by SuperAdmin to see exactly who did what and when
 * Auto-deleted after 90 days via MongoDB TTL index
 */
const ActivityLogSchema = new mongoose.Schema({
  tenantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  employeeName: { type: String, default: 'System' },
  employeeRole: { type: String, default: '' },

  // Action type — what happened
  action: {
    type: String,
    enum: [
      // Auth
      'login', 'logout',
      // Tasks
      'task_created', 'task_assigned', 'task_completed', 'task_revision',
      // FMS
      'flow_created', 'flow_updated', 'flow_deleted',
      'order_submitted', 'step_completed', 'flow_completed',
      // Employees
      'employee_created', 'employee_updated', 'employee_deleted',
      // Access roles
      'role_saved', 'role_deleted', 'role_assigned',
      // Leave
      'leave_type_saved', 'leave_applied', 'leave_decided', 'leave_cancelled', 'leave_adjusted',
      // Attendance
      'attendance_config_saved', 'attendance_shift_saved', 'attendance_shift_deleted', 'attendance_site_saved', 'attendance_site_deleted',
      'attendance_assigned', 'attendance_regularization_applied', 'attendance_regularization_decided', 'attendance_punch_reviewed',
      'attendance_manual_punch', 'attendance_face_enrolled', 'attendance_face_decided', 'attendance_face_deleted',
      // Chat
      'message_sent', 'announcement_created',
      // SuperAdmin
      'tenant_paused', 'tenant_resumed', 'plan_changed', 'limit_changed',
      // System
      'whatsapp_sent', 'file_uploaded',
    ],
    required: true,
  },

  // Human-readable description
  description: { type: String, default: '' },

  // Extra data about the action
  metadata: {
    taskId:       { type: String, default: '' },
    taskTitle:    { type: String, default: '' },
    orderId:      { type: String, default: '' },
    flowName:     { type: String, default: '' },
    stepName:     { type: String, default: '' },
    targetName:   { type: String, default: '' }, // who was affected
    oldValue:     { type: String, default: '' },
    newValue:     { type: String, default: '' },
    ip:           { type: String, default: '' },
    extra:        { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  // TTL — auto-delete after 90 days
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  },
}, { timestamps: true });

ActivityLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ActivityLogSchema.index({ tenantId: 1, createdAt: -1 });
ActivityLogSchema.index({ tenantId: 1, action: 1 });
ActivityLogSchema.index({ tenantId: 1, employeeId: 1 });

module.exports = mongoose.model('ActivityLog', ActivityLogSchema);
