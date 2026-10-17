// Voice module HTTP surface:
//   POST /api/voice/webhook            - called by the voice provider (Vapi) for every call event
//   POST /api/voice/outbound/checkin   - admin: ring one beta doer now (beta testing aid)
//   GET  /api/voice/logs               - admin: recent calls, recordings, transcripts, blockers
const crypto = require('crypto');
const VoiceCallLog = require('../models/VoiceCallLog');
const { checkTenantGate, checkCallable, resolveInboundCaller } = require('../utils/voice/voiceContext');
const { runTool, allowedTools } = require('../utils/voice/voiceTools');
const { inboundAssistant } = require('../utils/voice/assistantConfig');
const { REJECTION_MESSAGE } = require('../utils/voice/prompts');
const { placeDoerCheckin } = require('../utils/voice/callService');
const { clampToCallingHours } = require('../utils/voice/phone');

// ── Webhook authentication: shared secret, constant-time compare. No secret configured = refuse all. ──
function secretOk(req) {
  const expected = process.env.VOICE_WEBHOOK_SECRET;
  if (!expected) return false;
  const got = String(req.headers['x-vapi-secret'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const a = Buffer.from(got); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findLog(call) {
  const metaId = call?.metadata?.voiceLogId;
  if (metaId) { const l = await VoiceCallLog.findById(metaId).catch(() => null); if (l) return l; }
  if (call?.id) return VoiceCallLog.findOne({ providerCallId: call.id });
  return null;
}

// ── assistant-request: someone is calling the number ──
async function onAssistantRequest(message) {
  const call = message.call || {};
  const caller = await resolveInboundCaller(call.customer?.number);
  // The gate: unknown number, non-beta person, unverified phone, or company without the module => refused.
  if (!caller.ok) return { error: REJECTION_MESSAGE };

  const roles = caller.employee.roles || [];
  const canAssign = roles.includes('Assigner') || roles.includes('Admin');
  if (!canAssign) return { error: REJECTION_MESSAGE };

  const purpose = roles.includes('Assigner') ? 'assigner_create_task' : 'admin_inquiry';
  const log = await VoiceCallLog.create({
    tenantId: caller.tenant._id, employeeId: caller.employee._id, employeeName: caller.employee.name, phone: caller.phone,
    direction: 'inbound', purpose, roles, providerCallId: call.id, status: 'in-progress', startedAt: new Date(),
  });
  const tools = allowedTools(log, caller.employee);
  return { assistant: { ...inboundAssistant({ employee: caller.employee, roles, tools }), metadata: { voiceLogId: String(log._id) } } };
}

// ── tool-calls: the agent wants to do something ──
async function onToolCalls(message) {
  const list = message.toolCallList || (message.toolWithToolCallList || []).map((x) => x.toolCall) || [];
  const results = [];
  const log = await findLog(message.call);
  // Re-check the gate on EVERY tool call: switching the module off mid-call stops further actions.
  const gate = log ? await checkCallable(log.tenantId, log.employeeId) : { ok: false };
  for (const tc of list) {
    const name = tc.function?.name || tc.name;
    let result;
    if (!log || !gate.ok) {
      result = 'This voice line is not available right now.';
    } else {
      let args = tc.function?.arguments ?? tc.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      result = await runTool(name, { log, employee: gate.employee, tenant: gate.tenant, M: gate.M, toolCallId: tc.id, args });
    }
    results.push({ name, toolCallId: tc.id, result: String(result) });
  }
  return { results };
}

const NO_ANSWER = /(did-not-answer|busy|voicemail|no-answer|not-answer)/i;

async function onEndOfCallReport(message) {
  const log = await findLog(message.call);
  if (!log) return {};
  const art = message.artifact || {};
  log.recordingUrl = art.recordingUrl || art.recording?.url || art.recording?.mono?.combinedUrl || art.recording?.stereoUrl || log.recordingUrl;
  log.transcript = art.transcript || log.transcript;
  log.summary = message.analysis?.summary || message.summary || log.summary;
  log.endedReason = message.endedReason || log.endedReason;
  log.endedAt = message.endedAt ? new Date(message.endedAt) : new Date();
  log.startedAt = log.startedAt || (message.startedAt ? new Date(message.startedAt) : undefined);
  if (log.startedAt) log.durationSec = Math.max(0, Math.round((log.endedAt - log.startedAt) / 1000));
  const unanswered = NO_ANSWER.test(String(log.endedReason || ''));
  log.status = unanswered ? 'no-answer' : 'completed';
  // Nobody picked up an outbound check-in: try again later (bounded), unless a callback is already planned.
  if (unanswered && log.direction === 'outbound' && log.callbackStatus === 'none' && (log.callbackAttempts || 0) < 2) {
    log.callbackAt = clampToCallingHours(new Date(Date.now() + 2 * 3600000));
    log.callbackStatus = 'pending';
  }
  await log.save();
  return {};
}

async function onStatusUpdate(message) {
  const log = await findLog(message.call);
  if (!log) return {};
  const map = { ringing: 'ringing', 'in-progress': 'in-progress' };
  if (map[message.status]) { log.status = map[message.status]; if (message.status === 'in-progress' && !log.startedAt) log.startedAt = new Date(); await log.save(); }
  return {};
}

exports.webhook = async (req, res) => {
  if (!secretOk(req)) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const message = req.body?.message || {};
    let out = {};
    switch (message.type) {
      case 'assistant-request': out = await onAssistantRequest(message); break;
      case 'tool-calls': out = await onToolCalls(message); break;
      case 'end-of-call-report': out = await onEndOfCallReport(message); break;
      case 'status-update': out = await onStatusUpdate(message); break;
      default: out = {};
    }
    return res.status(200).json(out);
  } catch (err) {
    console.error('[Voice] webhook error:', err.message);
    return res.status(200).json(req.body?.message?.type === 'assistant-request' ? { error: REJECTION_MESSAGE } : {});
  }
};

// ── Admin endpoints (behind authMiddleware + tenantDb + requireVoiceTenant) ──
const isAdmin = (u) => !!u && (u.isSuperAdmin || (Array.isArray(u.roles) && u.roles.includes('Admin')));

exports.requireVoiceTenant = async (req, res, next) => {
  const tenantId = req.user?.isSuperAdmin ? (req.query.tenantId || req.body?.tenantId) : req.user?.tenantId;
  const gate = await checkTenantGate(tenantId);
  if (!gate.ok) return res.status(403).json({ message: gate.message, code: gate.code });
  req.voiceTenant = gate.tenant;
  next();
};

exports.triggerCheckin = async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Admins only.' });
  const r = await placeDoerCheckin({ tenantId: req.voiceTenant._id, employeeId: req.body?.employeeId, force: req.body?.force === true });
  if (!r.placed) return res.status(409).json({ message: `Call not placed: ${r.reason}`, reason: r.reason });
  res.status(202).json({ message: 'Call started', logId: r.log._id });
};

exports.listLogs = async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Admins only.' });
  const logs = await VoiceCallLog.find({ tenantId: req.voiceTenant._id }).sort({ createdAt: -1 }).limit(100).select('-handledToolCalls');
  res.json(logs);
};
