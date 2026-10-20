// utils/notificationRegistry.js
// Every WhatsApp message the system can send: what triggers it, what each
// variable means ({{1}}, {{2}} ...), and the plain-text wording used by providers
// that send free text (Maytapi). DoubleTick / WATI send a template that was
// approved inside WhatsApp, so only its name can be changed here, not its words.
const T = (key, label, trigger, vars, body) => ({ key, label, trigger, variables: vars, body });

const TEMPLATES = [
  T('new_task_delegation_v2', 'New task assigned', 'A task is given to a person', ['Doer name', 'Task title', 'Given by', 'Deadline', 'Priority', 'Link'],
    '🚀 NEW TASK ASSIGNED\n\nHi {{1}}, a new Task has been assigned to you.\n\nTask: {{2}}\nGiven By: {{3}}\nDeadline: {{4}}\nPriority: {{5}}\n\nView Briefing: {{6}}\nThank you!'),
  T('task_completion_alert', 'Task completed', 'A doer marks a task complete', ['Doer name', 'Task title', 'Completion time', 'Proof', 'Link'],
    '✅ TASK COMPLETED\n\nThe work assigned to {{1}} has been finalized.\n\nTask: {{2}}\nCompletion Time: {{3}}\nProof: {{4}}\n\nPlease review and verify the ledger: {{5}}\nThank you!!!'),
  T('task_revision_request', 'Deadline change / revision', 'A doer changes or asks to change a deadline', ['Doer name', 'Task title', 'New deadline', 'Reason', 'Link'],
    '🔄 REVISION REQUESTED\n\nPersonnel {{1}} has requested a change for Task: "{{2}}".\n\nRequested Deadline: {{3}}\nReason: {{4}}\n\nPlease approve or reassign the work: {{5}}\n\nThank you!!!'),
  T('coordinator_manual_reminder', 'Manual pending reminder', 'A coordinator sends a reminder', ['Doer name', 'Task title', 'Coordinator', 'Message', 'Link'],
    '🔔 PENDING REMINDER\n\nHello {{1}}, your work "{{2}}" is still flagged as PENDING.\n\nCoordinator: {{3}}\nMessage: {{4}}\n\nPlease update your status immediately: {{5}}\nThank you!!!'),
  T('checklist_entry_saved', 'Checklist entry saved', 'A checklist item is submitted', ['Checklist name', 'Date', 'Done by', 'Time', 'Evidence', 'Link'],
    '✨ ROUTINE ENTRY SAVED\n\nChecklist entry for "{{1}}" has been recorded for date: {{2}}.\n\nDone By: {{3}}\nTimestamp: {{4}}\nEvidence: {{5}}\n\nRegistry successfully updated: {{6}}\nThank you!!!'),
  T('daily_morning_briefing', 'Daily morning briefing', 'Every morning at the briefing time', ['Person name', 'Date', "Today's tasks", 'Backlog', 'Total needing action', 'Link'],
    "🌅 DAILY MISSION BRIEFING\n\nGood Morning {{1}}, here is your operational agenda for {{2}}:\n\n✅ TODAY'S TASKS: {{3}}\n⚠️ PENDING BACKLOG: {{4}}\n\nTotal Items Needing Action: {{5}}\n\nPlease ensure all safety protocols are followed. Synchronize your progress here: {{6}}\nThank you!!!"),
  T('fms_step_assigned', 'Flow step assigned', 'A flow step becomes active for a person', ['Person name', 'Step', 'Order ID', 'Flow name', 'Complete by', 'Link'],
    'Hi {{1}},\n\nYou have a new task assigned to you in WorkPilot.\n\nStep: {{2}}\nOrder ID: {{3}}\nFlow: {{4}}\nComplete by: {{5}}\n\nPlease log in and complete this step on time.\n\n{{6}}\n\nThank you\nWorkPilot Team'),
  T('fms_step_reminder', 'Flow step due in 1 hour', 'One hour before a flow step is due', ['Person name', 'Step', 'Order ID', 'Due by'],
    'Hi {{1}},\n\nThis is a reminder that your task is due in 1 hour.\n\nStep: {{2}}\nOrder ID: {{3}}\nDue by: {{4}}\n\nPlease complete it as soon as possible to avoid delay.\n\nThank you\nWorkPilot Team'),
  T('fms_step_overdue', 'Flow step overdue', 'A flow step passes its deadline', ['Person name', 'Step', 'Order ID', 'Delayed by', 'Link'],
    'Hi {{1}},\n\nYour task is overdue. Please complete it immediately.\n\nStep: {{2}}\nOrder ID: {{3}}\nDelayed by: {{4}}\n\nThis delay has been recorded. Please log in and complete this step now.\n\n{{5}}\n\nThank you\nWorkPilot Team'),
  T('fms_overdue_manager', 'Flow step overdue (to manager)', 'A flow step is late; the manager is told', ['Manager name', 'Person name', 'Step', 'Order ID', 'Minutes late'],
    'Hi {{1}},\n\n{{2}} is late on a task and it needs your attention.\n\nStep: {{3}}\nOrder ID: {{4}}\nDelayed by: {{5}} minutes\n\nPlease follow up with {{2}}.'),
  T('mployee_onboarding_welcome', 'Welcome to a new employee', 'A new employee is added', ['Employee name', 'Company', 'Role', 'Department', 'Link'],
    '👋 WELCOME TO THE TEAM\n\nHello {{1}}, you have been added to the {{2}} operational system.\n\nRole: {{3}}\nDepartment: {{4}}\n\nYou can now access your dashboard using your registered mobile number here: {{5}}\nThank you!!!'),
  T('_employee_profile_update', 'Employee profile updated', 'An employee profile is changed', ['Employee name', 'Designation', 'Department', 'Link'],
    '⚙️ PROFILE UPDATED\n\nHello {{1}}, your personnel registry profile has been updated by the Admin.\n\nNew Designation: {{2}}\nDepartment: {{3}}\n\nIf you did not request this, please contact your supervisor.\nLogin: {{4}}\n\nThank you!!!'),
  T('task_deadline_changed', 'Deadline changed', 'Someone changes the deadline of a task', ['Doer name', 'Task title', 'Old deadline', 'New deadline', 'Changed by', 'Reason', 'Link'],
    '📅 DEADLINE CHANGED\n\nHi {{1}}, the deadline of your task was changed.\n\nTask: {{2}}\nOld deadline: {{3}}\nNew deadline: {{4}}\nChanged by: {{5}}\nReason: {{6}}\n\nView: {{7}}\nThank you!'),
  T('task_date_request', 'Deadline change asked (follower)', 'A follower asks to change a deadline', ['Assigner name', 'Task title', 'Asked by', 'Asked deadline', 'Reason', 'Link'],
    '🕒 DEADLINE CHANGE REQUEST\n\nHi {{1}}, {{3}} asks to move the deadline of "{{2}}" to {{4}}.\n\nReason: {{5}}\n\nPlease approve or reject: {{6}}\nThank you!'),
  T('task_date_request_result', 'Deadline request answered', 'The assigner answers a follower\'s request', ['Person name', 'Task title', 'Answer', 'Deadline now', 'Link'],
    '🕒 DEADLINE REQUEST {{3}}\n\nHi {{1}}, your request for "{{2}}" was answered: {{3}}.\nDeadline now: {{4}}\n\nView: {{5}}\nThank you!'),
  T('task_on_hold', 'Task put On hold', 'A doer puts a task On hold', ['Assigner name', 'Task title', 'Doer name', 'Reason', 'Link'],
    '⏸ TASK ON HOLD\n\nHi {{1}}, {{3}} has put "{{2}}" On hold.\n\nReason: {{4}}\n\nView: {{5}}\nThank you!'),
  T('task_resumed', 'Task resumed', 'A doer resumes a task that was On hold', ['Assigner name', 'Task title', 'Doer name', 'New deadline', 'Link'],
    '▶️ TASK RESUMED\n\nHi {{1}}, {{3}} has resumed "{{2}}". The waiting time was not counted.\n\nNew deadline: {{4}}\n\nView: {{5}}\nThank you!'),
  T('subtask_assigned', 'Sub task assigned', 'A sub task is given to a person', ['Receiver name', 'Sub task', 'Main task', 'Given by', 'Deadline', 'Link'],
    '🧩 SUB TASK ASSIGNED\n\nHi {{1}}, a sub task was given to you.\n\nSub task: {{2}}\nPart of: {{3}}\nGiven by: {{4}}\nDeadline: {{5}}\n\nView: {{6}}\nThank you!'),
  T('subtask_created_info', 'Sub task created (to the main assigner)', 'A sub task is created under a task you gave', ['Assigner name', 'Sub task', 'Main task', 'Given to', 'Link'],
    '🧩 SUB TASK CREATED\n\nHi {{1}}, a sub task "{{2}}" was created under "{{3}}" and given to {{4}}.\n\nView: {{5}}\nThank you!'),
];
const BY_KEY = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));

// {{1}} -> variables[0]
const render = (body, vars) => String(body || '').replace(/\{\{(\d+)\}\}/g, (_, n) => {
  const v = (vars || [])[Number(n) - 1];
  return v === undefined || v === null ? '' : String(v);
});

module.exports = { TEMPLATES, BY_KEY, render };
