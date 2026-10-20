// utils/settingsRegistry.js
// The list of on/off switches a company can use to turn a function off or on.
// Every switch's default is how the product behaves today, so existing companies
// see no change until somebody flips one. New functions add one line here.
const SWITCHES = [
  { key: 'delegation_doerRevise',   group: 'Tasks', label: 'Doers can change a deadline (Revise button)', help: 'When off, nobody sees the Revise button and the server refuses deadline-change requests from doers. Admins and assigners can still edit a task.', default: true },
  { key: 'delegation_assignOnward', group: 'Tasks', label: 'Doers can assign a received task onward',      help: 'When off, the Assign Onward button is hidden and the server refuses it.', default: true },
  // ── Deadlines ──
  { key: 'dates_requireReason',     group: 'Deadlines', label: 'A reason is required for every deadline change', help: 'The person changing a date must pick a reason from the list (and may add a note).', default: true },
  { key: 'dates_lockWhenDone',      group: 'Deadlines', label: 'Lock the deadline once a task is done',          help: 'Nobody can change the deadline of a completed task, so past scores cannot change quietly.', default: true },
  { key: 'dates_notifyDoer',        group: 'Deadlines', label: 'Tell the doer when someone else changes the deadline', help: 'Sends a WhatsApp message to the doer and shows a "Revised" mark.', default: true },
  { key: 'dates_followersChange',   group: 'Deadlines', label: 'Followers can change a deadline',                 help: 'Followers can never mark a task done. When this is on, each task has a tick box "Followers can change the date"; if it is not ticked a follower must ask and the assigner decides.', default: true },
  { key: 'tasks_onHold',            group: 'Deadlines', label: 'Doers can put a task On hold',                    help: 'The doer says why the work is stuck; the assigner is told and the waiting time is not counted against the doer.', default: true },
  { key: 'tasks_subTasks',          group: 'Tasks', label: 'Sub tasks',                                           help: 'A person who is both Doer and Assigner can split a task and give parts of it to people from their Doer Mapping.', default: true },
  { key: 'tasks_bulkActions',       group: 'Tasks', label: 'Tick boxes and bulk actions in My Tasks',             help: 'Complete, assign onward or revise many tasks at once.', default: true },
];
const BY_KEY = Object.fromEntries(SWITCHES.map((s) => [s.key, s]));

const valuesOf = (tenant) => (tenant && tenant.companySettings && tenant.companySettings.switches) || {};
const hiddenOf = (tenant) => (tenant && tenant.superAdmin && Array.isArray(tenant.superAdmin.hiddenSwitches)) ? tenant.superAdmin.hiddenSwitches : [];

// Effective value (saved value, else the default which equals today's behaviour)
function effective(tenant) {
  const v = valuesOf(tenant);
  const out = {};
  for (const s of SWITCHES) out[s.key] = typeof v[s.key] === 'boolean' ? v[s.key] : s.default;
  return out;
}
const isOn = (tenant, key) => effective(tenant)[key] !== false;

module.exports = { SWITCHES, BY_KEY, effective, isOn, valuesOf, hiddenOf };
