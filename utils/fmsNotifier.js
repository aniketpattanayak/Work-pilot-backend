/**
 * server/utils/fmsNotifier.js
 *
 * WhatsApp notification engine for the new FMS.
 * Runs on a cron schedule and handles 3 types of notifications:
 *
 *   1. ASSIGNMENT  — fires once when a step becomes active (notified = false)
 *   2. REMINDER    — fires 1 hour before the planned deadline (reminderSent = false)
 *   3. OVERDUE     — fires when a step is past its deadline, alerts employee + admin
 *
 * Call startFmsNotifier() once after MongoDB connects.
 */

const cron             = require('node-cron');
const FlowInstance     = require('../models/FlowInstance');
const Employee         = require('../models/Employee');
const Tenant           = require('../models/Tenant');
const sendWhatsAppMessage = require('./whatsappNotify');

// ─── TEMPLATE NAMES ───────────────────────────────────────────────────────────
// These must match your DoubleTick / WhatsApp Business template names exactly.
const TEMPLATES = {
  ASSIGNED: 'fms_step_assigned',   // vars: [employeeName, stepName, orderID, templateName, deadline, loginLink]
  REMINDER: 'fms_step_reminder',   // vars: [employeeName, stepName, orderID, deadline]
  OVERDUE:  'fms_step_overdue',    // vars: [employeeName, stepName, orderID, minutesLate, loginLink]
  MANAGER:  'fms_overdue_manager', // vars: [managerName, employeeName, stepName, orderID, minutesLate]
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmtDeadline(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

async function getEmployeePhone(employeeId) {
  if (!employeeId) return null;
  try {
    const emp = await Employee.findById(employeeId).select('whatsappNumber name');
    return emp;
  } catch { return null; }
}

async function getTenantAdmins(tenantId) {
  try {
    const admins = await Employee.find({
      tenantId,
      roles: { $in: ['Admin'] },
      'leaveStatus.onLeave': { $ne: true },
    }).select('whatsappNumber name');
    return admins;
  } catch { return []; }
}

function buildLoginLink(tenantId) {
  // Replace with your actual subdomain logic if needed
  return 'https://app.lrbcloud.ai/dashboard/flow-tasks';
}

// ─── NOTIFICATION 1: ASSIGNMENT ──────────────────────────────────────────────

async function sendAssignmentNotifications() {
  try {
    const instances = await FlowInstance.find({
      status: 'active',
      'activeStep.notified': false,
      'activeStep.assignedToId': { $ne: null },
    }).select('activeStep orderIdentifier templateName tenantId');

    if (!instances.length) return;

    for (const inst of instances) {
      const step = inst.activeStep;

      // Find the employee
      const emp = await getEmployeePhone(step.assignedToId);
      if (!emp?.whatsappNumber) {
        // Mark notified anyway to prevent retry loop
        await FlowInstance.updateOne(
          { _id: inst._id },
          { $set: { 'activeStep.notified': true } }
        );
        continue;
      }

      const loginLink = buildLoginLink(inst.tenantId);

      await sendWhatsAppMessage(emp.whatsappNumber, {
        templateName: TEMPLATES.ASSIGNED,
        variables: [
          emp.name,
          step.nodeName,
          inst.orderIdentifier,
          inst.templateName,
          fmtDeadline(step.plannedDeadline),
          loginLink,
        ],
      });

      // Mark as notified
      await FlowInstance.updateOne(
        { _id: inst._id },
        { $set: { 'activeStep.notified': true } }
      );

      console.log(`[FMS Notify] Assignment sent to ${emp.name} for "${step.nodeName}" — ${inst.orderIdentifier}`);
    }
  } catch (err) {
    console.error('[FMS Notify] Assignment error:', err.message);
  }
}

// ─── NOTIFICATION 2: 1-HOUR REMINDER ─────────────────────────────────────────

async function sendReminderNotifications() {
  try {
    const now         = new Date();
    const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);

    // Find steps whose deadline is within the next hour and reminder hasn't been sent
    const instances = await FlowInstance.find({
      status: 'active',
      'activeStep.reminderSent': false,
      'activeStep.notified': true,            // only remind if already assigned
      'activeStep.plannedDeadline': {
        $gte: now,
        $lte: oneHourLater,
      },
      'activeStep.assignedToId': { $ne: null },
    }).select('activeStep orderIdentifier templateName tenantId');

    if (!instances.length) return;

    for (const inst of instances) {
      const step = inst.activeStep;
      const emp  = await getEmployeePhone(step.assignedToId);
      if (!emp?.whatsappNumber) {
        await FlowInstance.updateOne({ _id: inst._id }, { $set: { 'activeStep.reminderSent': true } });
        continue;
      }

      await sendWhatsAppMessage(emp.whatsappNumber, {
        templateName: TEMPLATES.REMINDER,
        variables: [
          emp.name,
          step.nodeName,
          inst.orderIdentifier,
          fmtDeadline(step.plannedDeadline),
        ],
      });

      await FlowInstance.updateOne(
        { _id: inst._id },
        { $set: { 'activeStep.reminderSent': true } }
      );

      console.log(`[FMS Notify] Reminder sent to ${emp.name} for "${step.nodeName}" — ${inst.orderIdentifier}`);
    }
  } catch (err) {
    console.error('[FMS Notify] Reminder error:', err.message);
  }
}

// ─── NOTIFICATION 3: OVERDUE ESCALATION ──────────────────────────────────────

// Track which instances have already had an overdue alert sent this session
// (prevents repeat alerts every minute)
const overdueAlerted = new Set();

async function sendOverdueNotifications() {
  try {
    const now = new Date();

    const instances = await FlowInstance.find({
      status: 'active',
      'activeStep.plannedDeadline': { $lt: now, $ne: null },
      'activeStep.notified': true,
    }).select('activeStep orderIdentifier templateName tenantId _id');

    if (!instances.length) return;

    for (const inst of instances) {
      const key = `${inst._id}_${inst.activeStep.nodeId}`;

      // Only alert once per step (not every minute)
      if (overdueAlerted.has(key)) continue;
      overdueAlerted.add(key);

      const step        = inst.activeStep;
      const minutesLate = Math.round((now - new Date(step.plannedDeadline)) / 60000);
      const loginLink   = buildLoginLink(inst.tenantId);

      // Notify the employee
      const emp = await getEmployeePhone(step.assignedToId);
      if (emp?.whatsappNumber) {
        await sendWhatsAppMessage(emp.whatsappNumber, {
          templateName: TEMPLATES.OVERDUE,
          variables: [
            emp.name,
            step.nodeName,
            inst.orderIdentifier,
            String(minutesLate),
            loginLink,
          ],
        });
      }

      // Escalate to admins
      const admins = await getTenantAdmins(inst.tenantId);
      for (const admin of admins) {
        if (!admin.whatsappNumber) continue;
        await sendWhatsAppMessage(admin.whatsappNumber, {
          templateName: TEMPLATES.MANAGER,
          variables: [
            admin.name,
            emp?.name || step.assignedToName || 'Unknown',
            step.nodeName,
            inst.orderIdentifier,
            String(minutesLate),
          ],
        });
      }

      console.log(`[FMS Notify] Overdue alert: "${step.nodeName}" for ${inst.orderIdentifier} — ${minutesLate}min late`);
    }
  } catch (err) {
    console.error('[FMS Notify] Overdue error:', err.message);
  }
}

// ─── CRON SCHEDULER ──────────────────────────────────────────────────────────

/**
 * startFmsNotifier()
 * Call this once inside your mongoose.connect().then() callback.
 * Runs all 3 checks every minute on a staggered schedule.
 */
const startFmsNotifier = () => {
  // Assignment notifications — every minute at :00
  cron.schedule('* * * * *', async () => {
    await sendAssignmentNotifications();
  });

  // Reminder notifications — every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await sendReminderNotifications();
  });

  // Overdue escalation — every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    await sendOverdueNotifications();
  });

  console.log('🔔 [FMS Notifier] WhatsApp notification engine active.');
};

module.exports = startFmsNotifier;
