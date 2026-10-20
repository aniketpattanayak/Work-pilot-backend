// utils/settingsRegistry.js
// The list of on/off switches a company can use to turn a function off or on.
// Every switch's default is how the product behaves today, so existing companies
// see no change until somebody flips one. New functions add one line here.
const SWITCHES = [
  { key: 'delegation_doerRevise',   group: 'Tasks', label: 'Doers can change a deadline (Revise button)', help: 'When off, nobody sees the Revise button and the server refuses deadline-change requests from doers. Admins and assigners can still edit a task.', default: true },
  { key: 'delegation_assignOnward', group: 'Tasks', label: 'Doers can assign a received task onward',      help: 'When off, the Assign Onward button is hidden and the server refuses it.', default: true },
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
