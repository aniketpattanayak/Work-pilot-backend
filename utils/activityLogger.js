/**
 * activityLogger.js
 * Call log() from any controller to record an action in ActivityLog.
 * Non-blocking — never throws, never delays the main response.
 *
 * Usage:
 *   const { log } = require('../utils/activityLogger');
 *   await log({ tenantId, employeeId, employeeName, action: 'task_created', description: 'Created "Invoice review"', metadata: { taskTitle: 'Invoice review' } });
 */

const ActivityLog = require('../models/ActivityLog');

/**
 * Log an activity
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} [opts.employeeId]
 * @param {string} [opts.employeeName]
 * @param {string} [opts.employeeRole]
 * @param {string} opts.action  - must match ActivityLog enum
 * @param {string} [opts.description]
 * @param {Object} [opts.metadata]
 * @param {string} [opts.ip]
 */
async function log(opts) {
  try {
    await ActivityLog.create({
      tenantId:     opts.tenantId,
      employeeId:   opts.employeeId   || null,
      employeeName: opts.employeeName || 'System',
      employeeRole: opts.employeeRole || '',
      action:       opts.action,
      description:  opts.description  || '',
      metadata: {
        taskId:     opts.metadata?.taskId     || '',
        taskTitle:  opts.metadata?.taskTitle  || '',
        orderId:    opts.metadata?.orderId    || '',
        flowName:   opts.metadata?.flowName   || '',
        stepName:   opts.metadata?.stepName   || '',
        targetName: opts.metadata?.targetName || '',
        oldValue:   opts.metadata?.oldValue   || '',
        newValue:   opts.metadata?.newValue   || '',
        ip:         opts.ip                   || '',
        extra:      opts.metadata?.extra      || {},
      },
    });
  } catch (err) {
    // Never crash the main request due to logging failure
    console.error('[ActivityLog] Failed to log:', err.message);
  }
}

/**
 * Middleware to inject logger into req
 * Adds req.log() shortcut that auto-fills tenantId + employeeId from JWT
 */
function loggerMiddleware(req, res, next) {
  req.log = (action, description, metadata = {}) => {
    log({
      tenantId:     req.user?.tenantId,
      employeeId:   req.user?.id,
      employeeName: req.user?.name || '',
      employeeRole: req.user?.role || req.user?.roles?.[0] || '',
      action,
      description,
      metadata,
      ip: req.ip || req.headers['x-forwarded-for'] || '',
    });
  };
  next();
}

module.exports = { log, loggerMiddleware };
