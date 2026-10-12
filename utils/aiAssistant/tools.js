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
    // status is fixed by what this tool IS, never something the model supplies -
    // "complete_task" always means status: 'Completed', nothing else.
    autoFields: () => ({ status: 'Completed' }),
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

  // --- Read-only LOOKUP tools -------------------------------------------------
  // These exist only to resolve a name the user said in words into the real id
  // a write tool (create_task, apply_leave) needs - the model can never know a
  // colleague's MongoDB id or a leave type's id on its own, and must never guess
  // one. The controller feeds their results back to the model as DATA (never an
  // instruction) and lets it continue reasoning in the same request - see
  // controllers/aiAssistantController.js's multi-step loop.
  {
    name: 'find_colleague',
    description: "Search the current company's employees by name (case-insensitive, partial match). Returns id, name and department for each match - use the id only to call another tool, NEVER show an id to the user, always refer to people by name. If more than one person matches, you must ask the user which one before doing anything else - never guess.",
    needsConfirmation: false,
    isLookup: true,
    method: 'GET',
    path: () => '/api/tasks/employees',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 100, description: "the name, or part of it, the user said" } },
      additionalProperties: false,
    },
    // The underlying route has no server-side name filter, so it returns the
    // whole company's list (same data the user's own "Employees" screen would
    // show them) - this narrows it to what's relevant before the model ever
    // sees it, and strips every field except what's safe/needed to display.
    //
    // Part 1 (AI-layer-v2): matching goes through resolve.js instead of a
    // plain substring check, so a typo or a Devanagari name still finds the
    // right person - the list returned stays tenant-scoped exactly as before
    // (the route itself already returned only this tenant's employees; this
    // just ranks within that same list, it never widens the search).
    postProcess: (data, args) => {
      const { resolveEntity } = require('./resolve');
      const all = Array.isArray(data?.employees) ? data.employees : (Array.isArray(data) ? data : []);
      const toMatchPlain = (e) => ({ id: String(e._id || e.id), name: e.name, department: e.department });

      // A blank query is a deliberate internal convention (see
      // resolveDisplayNames in the controller: it calls this tool with
      // query:'' purely to fetch the whole roster, then looks a known id up
      // locally for the confirmation card) - NOT a real name search, so it
      // must return everyone rather than going through the resolver, which
      // correctly refuses to "match" an empty string against anything.
      if (!String(args?.query || '').trim()) {
        return { query: args?.query, matchCount: all.length, matches: all.map(toMatchPlain), decision: 'list-all' };
      }

      const result = resolveEntity(args?.query, all, {
        getPrimary: (e) => e.name || '',
        getAliases: (e) => [e.email ? String(e.email).split('@')[0] : ''],
        label: (e) => e.name,
      });
      const toMatch = (s) => ({ id: String(s.item._id || s.item.id), name: s.item.name, department: s.item.department });
      if (result.decision === 'single') {
        return { query: args?.query, matchCount: 1, matches: [toMatch(result.top)], decision: 'single' };
      }
      if (result.decision === 'ambiguous') {
        return {
          query: args?.query,
          matchCount: result.candidates.length,
          matches: result.candidates.map(toMatch),
          decision: 'ambiguous',
        };
      }
      return { query: args?.query, matchCount: 0, matches: [], decision: 'none', didYouMean: result.suggestions };
    },
  },
  {
    name: 'list_leave_types',
    description: "List the leave types configured for this company (id and name) - use this to resolve a leave type the user named in words (e.g. \"sick leave\") to its id before calling apply_leave. Never guess a leaveTypeId.",
    needsConfirmation: false,
    isLookup: true,
    method: 'GET',
    path: () => '/api/tasks/leave/types',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    postProcess: (data) => {
      const all = Array.isArray(data) ? data : (Array.isArray(data?.types) ? data.types : []);
      return all.map((t) => ({ id: String(t._id || t.id), name: t.name }));
    },
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
