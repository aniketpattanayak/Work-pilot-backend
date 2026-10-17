// Placing calls: outbound doer check-ins and scheduled follow-up callbacks.
const VoiceCallLog = require('../../models/VoiceCallLog');
const vapi = require('./vapiClient');
const { checkCallable, checkTenantGate, modelsForTenant } = require('./voiceContext');
const { doerCheckinAssistant } = require('./assistantConfig');
const { OPEN_STATUSES } = require('./voiceTools');
const { normalizePhone, withinCallingHours, clampToCallingHours, formatIst } = require('./phone');

const MAX_TASKS_PER_CALL = 3;
const MIN_GAP_HOURS = Number(process.env.VOICE_MIN_HOURS_BETWEEN_CHECKINS || 4);
const MAX_CALLBACK_ATTEMPTS = 3;

async function pendingTasksFor(M, tenantId, doerId, onlyIds) {
  const q = { tenantId, doerId, status: { $in: OPEN_STATUSES } };
  if (onlyIds && onlyIds.length) q._id = { $in: onlyIds };
  const all = await M.DelegationTask.find(q).sort({ deadline: 1 }).select('title deadline');
  const now = new Date();
  const tasks = all.slice(0, MAX_TASKS_PER_CALL).map((t) => ({
    id: String(t._id), title: t.title, overdue: t.deadline < now, deadlineIst: formatIst(t.deadline),
  }));
  return { tasks, extraCount: Math.max(0, all.length - tasks.length), rawIds: all.slice(0, MAX_TASKS_PER_CALL).map((t) => t._id) };
}

/**
 * Places one outbound check-in call to a doer. Returns { placed, reason, log }.
 * Re-runs the whole Superadmin gate first - so a tenant switched off a moment ago is never called.
 */
async function placeDoerCheckin({ tenantId, employeeId, onlyTaskIds, callbackOfCallId, previousBlocker, force = false, now = new Date() }) {
  const gate = await checkCallable(tenantId, employeeId);
  if (!gate.ok) return { placed: false, reason: gate.code };
  const { tenant, employee, M } = gate;
  if (!(employee.roles || []).includes('Doer')) return { placed: false, reason: 'NOT_A_DOER' };
  if (!force && !withinCallingHours(now)) return { placed: false, reason: 'OUTSIDE_CALLING_HOURS' };
  if (employee.leaveStatus?.onLeave) return { placed: false, reason: 'ON_LEAVE' };

  if (!callbackOfCallId && !force) {
    const since = new Date(now.getTime() - MIN_GAP_HOURS * 3600000);
    const recent = await VoiceCallLog.findOne({ tenantId: tenant._id, employeeId: employee._id, purpose: 'doer_checkin', direction: 'outbound', createdAt: { $gte: since } });
    if (recent) return { placed: false, reason: 'CALLED_RECENTLY' };
  }

  const { tasks, extraCount, rawIds } = await pendingTasksFor(M, tenant._id, employee._id, onlyTaskIds);
  if (!tasks.length) return { placed: false, reason: 'NO_PENDING_TASKS' };

  const log = await VoiceCallLog.create({
    tenantId: tenant._id, employeeId: employee._id, employeeName: employee.name, phone: normalizePhone(employee.voicePhone),
    direction: 'outbound', purpose: 'doer_checkin', roles: employee.roles || [], taskIds: rawIds,
    status: 'queued', callbackOfCallId: callbackOfCallId || undefined,
  });

  try {
    const assistant = doerCheckinAssistant({ employee, tasks, extraCount, isCallback: !!callbackOfCallId, previousBlocker });
    const r = await vapi.createCall({ assistant, customerNumber: log.phone, metadata: { voiceLogId: String(log._id), tenantId: String(tenant._id) } });
    log.providerCallId = r.id; log.status = 'ringing'; await log.save();
    return { placed: true, log };
  } catch (err) {
    console.error('[Voice] placing call failed:', err.message);
    log.status = 'failed'; log.endedReason = `placement-error: ${err.message}`.slice(0, 200); await log.save();
    return { placed: false, reason: 'PROVIDER_ERROR', log };
  }
}

/** Places the follow-up calls whose time has come. Safe to run every minute from any number of processes. */
async function runDueCallbacks(now = new Date()) {
  const results = [];
  for (let i = 0; i < 20; i++) {
    // Atomically claim one due callback so two scheduler ticks never double-call.
    const orig = await VoiceCallLog.findOneAndUpdate(
      { callbackStatus: 'pending', callbackAt: { $lte: now } },
      { $set: { callbackStatus: 'placed' }, $inc: { callbackAttempts: 1 } },
      { sort: { callbackAt: 1 }, new: true },
    );
    if (!orig) break;

    const gate = await checkTenantGate(orig.tenantId);
    if (!gate.ok) { await VoiceCallLog.updateOne({ _id: orig._id }, { callbackStatus: 'cancelled' }); results.push({ id: orig._id, outcome: 'cancelled', reason: gate.code }); continue; }

    if (!withinCallingHours(now)) {
      await VoiceCallLog.updateOne({ _id: orig._id }, { callbackStatus: 'pending', callbackAt: clampToCallingHours(now), $inc: { callbackAttempts: -1 } });
      results.push({ id: orig._id, outcome: 'deferred' }); continue;
    }

    const unfinished = orig.taskOutcomes.filter((o) => !o.finished).map((o) => o.taskId);
    const r = await placeDoerCheckin({
      tenantId: orig.tenantId, employeeId: orig.employeeId, onlyTaskIds: unfinished,
      callbackOfCallId: orig._id, previousBlocker: orig.blockerReason, now,
    });
    if (r.placed) { results.push({ id: orig._id, outcome: 'placed', newLogId: r.log._id }); continue; }

    const final = ['NO_PENDING_TASKS', 'NOT_BETA', 'NO_PHONE', 'NO_EMPLOYEE', 'MODULE_OFF', 'NOT_A_DOER', 'ON_LEAVE'].includes(r.reason);
    if (final) { await VoiceCallLog.updateOne({ _id: orig._id }, { callbackStatus: 'cancelled' }); results.push({ id: orig._id, outcome: 'cancelled', reason: r.reason }); }
    else if (orig.callbackAttempts < MAX_CALLBACK_ATTEMPTS) {
      await VoiceCallLog.updateOne({ _id: orig._id }, { callbackStatus: 'pending', callbackAt: new Date(now.getTime() + 30 * 60000) });
      results.push({ id: orig._id, outcome: 'retry', reason: r.reason });
    } else { await VoiceCallLog.updateOne({ _id: orig._id }, { callbackStatus: 'failed' }); results.push({ id: orig._id, outcome: 'failed', reason: r.reason }); }
  }
  return results;
}

/** Daily sweep: check in with every beta doer (of enabled tenants) who has pending work. */
async function runDailyCheckins() {
  const Tenant = require('../../models/Tenant');
  const tenants = await Tenant.find({ 'superAdmin.voiceModuleEnabled': true, 'superAdmin.status': 'active' });
  const out = [];
  for (const tenant of tenants) {
    const M = await modelsForTenant(tenant);
    const doers = await M.Employee.find({ tenantId: tenant._id, voiceBetaUser: true, voicePhoneVerified: true, roles: 'Doer' }).select('_id');
    for (const d of doers) {
      const r = await placeDoerCheckin({ tenantId: tenant._id, employeeId: d._id });
      out.push({ tenantId: tenant._id, employeeId: d._id, placed: r.placed, reason: r.reason });
    }
  }
  return out;
}

module.exports = { placeDoerCheckin, runDueCallbacks, runDailyCheckins, pendingTasksFor, MAX_CALLBACK_ATTEMPTS };
