// Phase 4 AI Assistant — the FIXED tool list.
//
// Design rule (non-negotiable, from the project brief): the assistant acts AS the
// logged-in user via the SAME HTTP routes/token the normal UI uses, never a
// privileged internal path. Every tool below is executed by firing a real HTTP
// request at this same backend, with the user's own JWT in the Authorization
// header (see executor.js). That means every existing requirePermission/
// adminOfSameCompany/subscriptionGuard/tenantDbMiddleware check the route already
// has runs exactly as it would for a normal UI click - the assistant provably
// cannot do anything the user's real permissions don't already allow, because it
// is not a separate code path, it is the same one.
//
// Approve / release / money-moving actions (payroll approve, payroll release,
// salary change) are intentionally NOT in this list at all, per the brief's rule
// that voice/chat must never perform those - the assistant responds to a request
// for one of those by naming the screen to open instead (see controller).

const TOOLS = [
  {
    name: 'list_my_tasks',
    description: "List the current user's own delegated tasks (as doer or assigner).",
    needsConfirmation: false,
    method: 'GET',
    path: (u) => `/api/tasks/doer/${u.id}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_task',
    description: 'Create a new delegated task assigned to a specific doer with a deadline.',
    needsConfirmation: true,
    method: 'POST',
    path: () => '/api/tasks/create-task',
    // assignerId/tenantId are never something the model should supply - the
    // assistant always acts AS the current user, so the assigner is always them,
    // never a value the model could be tricked into substituting.
    autoFields: (u) => ({ assignerId: u.id, tenantId: u.tenantId }),
    inputSchema: {
      type: 'object',
      required: ['title', 'doerId', 'deadline'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        doerId: { type: 'string', description: 'MongoDB id of the employee this task is assigned to' },
        deadline: { type: 'string', description: 'ISO date, must be a real calendar date the user stated explicitly' },
        priority: { type: 'string', enum: ['Low', 'Medium', 'High'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'complete_task',
    description: "Mark one of the current user's own tasks as Completed.",
    needsConfirmation: true,
    method: 'PUT',
    path: () => '/api/tasks/respond',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: { taskId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'view_leave_balance',
    description: "View the current user's own leave balance.",
    needsConfirmation: false,
    method: 'GET',
    path: () => '/api/tasks/leave/balance',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'apply_leave',
    description: 'Apply for leave for the current user, for an explicit date range the user stated.',
    needsConfirmation: true,
    method: 'POST',
    path: () => '/api/tasks/leave/requests',
    inputSchema: {
      type: 'object',
      required: ['leaveTypeId', 'fromDate', 'toDate'],
      properties: {
        leaveTypeId: { type: 'string' },
        fromDate: { type: 'string', description: 'ISO date, must be a real date the user explicitly stated - never guessed' },
        toDate: { type: 'string', description: 'ISO date, must be a real date the user explicitly stated - never guessed' },
        reason: { type: 'string', maxLength: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_pending_leave_requests',
    description: 'List leave requests waiting for the current user to approve or reject (only returns what the user is permitted to see/approve).',
    needsConfirmation: false,
    method: 'GET',
    path: () => '/api/tasks/leave/requests?status=Pending',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'view_my_payslips',
    description: "View the current user's own past payslips list. Does not expose any other employee's salary data.",
    needsConfirmation: false,
    method: 'GET',
    path: () => '/api/tasks/payroll/my-payslips',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'view_attendance_today',
    description: "View the current user's own attendance punch status for today.",
    needsConfirmation: false,
    method: 'GET',
    path: () => '/api/tasks/attendance/today',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// Actions the brief explicitly forbids doing via the assistant, ever - these are
// not tools at all. If the model (or an injected instruction) tries to invent a
// call with one of these names, the executor rejects it unconditionally before
// any HTTP call is made. The assistant instead tells the user which screen to
// open, by name, for each of these.
const FORBIDDEN_ACTIONS = {
  approve_payroll: 'Payroll → Runs → open the run and click Approve',
  release_payroll: 'Payroll → Runs → open the approved run and click Release',
  change_salary: "Payroll → Salaries → open the employee's salary structure",
  approve_leave: 'Leave → open the pending request and approve/reject it there',
  reset_admin_password: 'SuperAdmin panel → Tenant detail → Reset Password',
};

function getToolByName(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

module.exports = { TOOLS, FORBIDDEN_ACTIONS, getToolByName };
