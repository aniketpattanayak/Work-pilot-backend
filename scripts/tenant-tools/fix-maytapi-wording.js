const path = require('path');
const safePatch = require('./safe-patch');
const SERVER_ROOT = path.join(__dirname, '..', '..');

safePatch(
  path.join(SERVER_ROOT, 'utils/whatsappNotify.js'),
  `const sendViaMaytapi = async (toPhone, data, config) => {
  const phone = cleanPhone(toPhone);
  const { productId, token, phoneId } = config;
  const variables = Array.isArray(data.variables) ? data.variables : [];
  const message = variables.join('\\n') || data.templateName || String(data);`,
  `// Maytapi sends plain text — it doesn't render an approved WhatsApp
// Business template the way DoubleTick does, so we word each known
// template ourselves, matching the real approved template copy.
// Unmapped templates fall back to the old line-per-variable behavior.
const MAYTAPI_TEMPLATES = {
  checklist_entry_saved: (v) =>
    \`✨ ROUTINE ENTRY SAVED\\n\\nChecklist entry for "\${v[0]}" has been recorded for date: \${v[1]}.\\n\\nDone By: \${v[2]}\\nTimestamp: \${v[3]}\\nEvidence: \${v[4]}\\n\\nRegistry successfully updated: \${v[5]}\\nThank you!!!\`,

  task_completion_alert: (v) =>
    \`✅ TASK COMPLETED\\n\\nThe work assigned to \${v[0]} has been finalized.\\n\\nTask: \${v[1]}\\nCompletion Time: \${v[2]}\\nProof: \${v[3]}\\n\\nPlease review and verify the ledger: \${v[4]}\\nThank you!!!\`,

  task_revision_request: (v) =>
    \`🔄 REVISION REQUESTED\\n\\nPersonnel \${v[0]} has requested a change for Task: "\${v[1]}".\\n\\nRequested Deadline: \${v[2]}\\nReason: \${v[3]}\\n\\nPlease approve or reassign the work: \${v[4]}\\n\\nThank you!!!\`,

  coordinator_manual_reminder: (v) =>
    \`🔔 PENDING REMINDER\\n\\nHello \${v[0]}, your work "\${v[1]}" is still flagged as PENDING.\\n\\nCoordinator: \${v[2]}\\nMessage: \${v[3]}\\n\\nPlease update your status immediately: \${v[4]}\\nThank you!!!\`,

  new_task_delegation_v2: (v) =>
    \`🚀 NEW TASK ASSIGNED\\n\\nHi \${v[0]}, a new Task has been assigned to you.\\n\\nTask: \${v[1]}\\nGiven By: \${v[2]}\\nDeadline: \${v[3]}\\nPriority: \${v[4]}\\n\\nView Briefing: \${v[5]}\\nThank you!\`,

  daily_morning_briefing: (v) =>
    \`🌅 DAILY MISSION BRIEFING\\n\\nGood Morning \${v[0]}, here is your operational agenda for \${v[1]}:\\n\\n✅ TODAY'S TASKS: \${v[2]}\\n⚠️ PENDING BACKLOG: \${v[3]}\\n\\nTotal Items Needing Action: \${v[4]}\\n\\nPlease ensure all safety protocols are followed. Synchronize your progress here: \${v[5]}\\nThank you!!!\`,

  mployee_onboarding_welcome: (v) =>
    \`👋 WELCOME TO THE TEAM\\n\\nHello \${v[0]}, you have been added to the \${v[1]} operational system.\\n\\nRole: \${v[2]}\\nDepartment: \${v[3]}\\n\\nYou can now access your dashboard using your registered mobile number here: \${v[4]}\\nThank you!!!\`,

  _employee_profile_update: (v) =>
    \`⚙️ PROFILE UPDATED\\n\\nHello \${v[0]}, your personnel registry profile has been updated by the Admin.\\n\\nNew Designation: \${v[1]}\\nDepartment: \${v[2]}\\n\\nIf you did not request this, please contact your supervisor.\\nLogin: \${v[3]}\\n\\nThank you!!!\`,

  fms_step_assigned: (v) =>
    \`Hi \${v[0]},\\n\\nYou have a new task assigned to you in WorkPilot.\\n\\nStep: \${v[1]}\\nOrder ID: \${v[2]}\\nFlow: \${v[3]}\\nComplete by: \${v[4]}\\n\\nPlease log in and complete this step on time.\\n\\n\${v[5]}\\n\\nThank you\\nWorkPilot Team\`,

  fms_step_reminder: (v) =>
    \`Hi \${v[0]},\\n\\nThis is a reminder that your task is due in 1 hour.\\n\\nStep: \${v[1]}\\nOrder ID: \${v[2]}\\nDue by: \${v[3]}\\n\\nPlease complete it as soon as possible to avoid delay.\\n\\nThank you\\nWorkPilot Team\`,

  fms_step_overdue: (v) =>
    \`Hi \${v[0]},\\n\\nYour task is overdue. Please complete it immediately.\\n\\nStep: \${v[1]}\\nOrder ID: \${v[2]}\\nDelayed by: \${v[3]}\\n\\nThis delay has been recorded. Please log in and complete this step now.\\n\\n\${v[4]}\\n\\nThank you\\nWorkPilot Team\`,
};

const sendViaMaytapi = async (toPhone, data, config) => {
  const phone = cleanPhone(toPhone);
  const { productId, token, phoneId } = config;
  const variables = Array.isArray(data.variables) ? data.variables : [];
  const renderer = MAYTAPI_TEMPLATES[data.templateName];
  const message = renderer ? renderer(variables) : (variables.join('\\n') || data.templateName || String(data));`
);
