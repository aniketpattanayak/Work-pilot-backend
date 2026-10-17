// The Superadmin gate for the voice module + helpers that find the right tenant models.
// EVERY voice code path (webhook, tools, scheduler, admin endpoints) goes through here, so a
// company that is not switched on - or a person who is not a verified beta user - is refused
// no matter how the request arrived.
const Tenant = require('../../models/Tenant');
const { getModels } = require('../getModels');
const tenantDbMiddleware = require('../../middleware/tenantDb');
const { normalizePhone } = require('./phone');

const GATE_MESSAGES = {
  NO_TENANT: 'Company not found.',
  PAUSED: 'This company account is not active.',
  MODULE_OFF: 'The voice module is not enabled for this company.',
  NO_EMPLOYEE: 'Employee not found.',
  NOT_BETA: 'This person is not a voice beta user.',
  NO_PHONE: 'This person has no verified phone number.',
};

/** Tenant-level gate. Returns { ok, code, message, tenant }. */
async function checkTenantGate(tenantId) {
  const tenant = tenantId ? await Tenant.findById(tenantId).catch(() => null) : null;
  if (!tenant) return { ok: false, code: 'NO_TENANT', message: GATE_MESSAGES.NO_TENANT };
  if ((tenant.superAdmin?.status || 'active') !== 'active') return { ok: false, code: 'PAUSED', message: GATE_MESSAGES.PAUSED, tenant };
  if (tenant.superAdmin?.voiceModuleEnabled !== true) return { ok: false, code: 'MODULE_OFF', message: GATE_MESSAGES.MODULE_OFF, tenant };
  return { ok: true, tenant };
}

async function modelsForTenant(tenant) {
  return getModels(tenant._id, tenant.superAdmin?.customMongoUri || '');
}

/** req.db for the tenant (null for the shared DB) - same as the normal request pipeline. */
async function reqDbForTenant(tenantId) {
  const fake = { user: { tenantId: String(tenantId) } };
  await new Promise((resolve) => tenantDbMiddleware(fake, {}, resolve));
  return fake.db || null;
}

const isBeta = (emp) => emp && emp.voiceBetaUser === true;
const hasVerifiedPhone = (emp) => emp && emp.voicePhoneVerified === true && !!normalizePhone(emp.voicePhone);

/** Tenant gate + person gate. Returns { ok, code, message, tenant, employee, M }. */
async function checkCallable(tenantId, employeeId) {
  const gate = await checkTenantGate(tenantId);
  if (!gate.ok) return gate;
  const M = await modelsForTenant(gate.tenant);
  const employee = await M.Employee.findOne({ _id: employeeId, tenantId: gate.tenant._id }).catch(() => null);
  if (!employee) return { ok: false, code: 'NO_EMPLOYEE', message: GATE_MESSAGES.NO_EMPLOYEE };
  if (!isBeta(employee)) return { ok: false, code: 'NOT_BETA', message: GATE_MESSAGES.NOT_BETA };
  if (!hasVerifiedPhone(employee)) return { ok: false, code: 'NO_PHONE', message: GATE_MESSAGES.NO_PHONE };
  return { ok: true, tenant: gate.tenant, employee, M };
}

/**
 * Inbound: who is calling? Only companies with the module ON are searched, and only verified
 * beta users match. Unknown numbers, non-beta users, and numbers that match more than one person
 * are all refused.
 */
async function resolveInboundCaller(rawNumber) {
  const phone = normalizePhone(rawNumber);
  if (!phone) return { ok: false, code: 'NO_PHONE', message: GATE_MESSAGES.NO_PHONE };
  const tenants = await Tenant.find({ 'superAdmin.voiceModuleEnabled': true, 'superAdmin.status': 'active' });
  const matches = [];
  for (const tenant of tenants) {
    try {
      const M = await modelsForTenant(tenant);
      const emps = await M.Employee.find({ tenantId: tenant._id, voicePhone: phone, voicePhoneVerified: true, voiceBetaUser: true }).limit(2);
      emps.forEach((employee) => matches.push({ tenant, employee, M }));
    } catch (e) {
      console.error('[Voice] resolveInboundCaller: tenant lookup failed', String(tenant._id), e.message);
    }
  }
  if (matches.length !== 1) return { ok: false, code: matches.length ? 'AMBIGUOUS' : 'NOT_BETA', message: 'Caller not authorised.' };
  return { ok: true, phone, ...matches[0] };
}

module.exports = { GATE_MESSAGES, checkTenantGate, checkCallable, resolveInboundCaller, modelsForTenant, reqDbForTenant, isBeta, hasVerifiedPhone };
