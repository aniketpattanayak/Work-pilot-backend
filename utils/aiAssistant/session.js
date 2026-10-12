// Part 2 (AI-layer-v2): conversation memory + Mongo-backed pending actions.
//
// Everything here takes the AiChatSession MODEL as a parameter rather than
// importing it directly, the same way the rest of the codebase threads a
// per-tenant-custom-DB model through via getModels(req) (see tools.js/
// controllers that call getReqModels) - so this works whether a tenant has
// its own custom Mongo (req.db set) or uses the shared default connection.
const crypto = require('crypto');

const MAX_HISTORY_TURNS = 20; // "the server loads the last N turns" per the brief
const TRIM_AT_MESSAGE_COUNT = 80; // once a session has this many stored messages, fold the oldest half into `summary`
const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // unchanged from the old in-memory CONFIRM_TTL_MS

function newSessionId() {
  return crypto.randomBytes(12).toString('hex');
}

async function getOrCreateSession(AiChatSession, { tenantId, userId, sessionId }) {
  if (sessionId) {
    const existing = await AiChatSession.findOne({ tenantId, userId, sessionId });
    if (existing) return existing;
  }
  const id = sessionId || newSessionId();
  return AiChatSession.create({ tenantId, userId, sessionId: id, messages: [], title: 'New chat' });
}

// Never store the raw tool call args/result (may contain ids, or later,
// bank/salary fields once those tools exist) - just a short note of what
// kind of lookup happened, for the user's own benefit when they reopen the
// chat, never as something fed back to the model as fact.
function summariseToolCallForStorage(toolName, args) {
  switch (toolName) {
    case 'find_colleague':
      return `Looked up colleague matches for "${String(args?.query || '').slice(0, 60)}"`;
    case 'list_leave_types':
      return 'Looked up leave types';
    case 'create_task':
      return 'Staged: create a task';
    case 'apply_leave':
      return 'Staged: apply for leave';
    case 'complete_task':
      return 'Staged: mark a task completed';
    default:
      return toolName ? `Ran ${toolName}` : '';
  }
}

// Returns the last N turns as plain Anthropic-format {role, content} message
// objects, suitable for prepending to a fresh request's `messages` array so
// a follow-up like "him" / "that task" / "the same for tomorrow" can be
// resolved from real prior context, not just the one message just sent.
function buildHistoryMessages(session) {
  const recent = (session.messages || []).slice(-MAX_HISTORY_TURNS * 2); // a "turn" is roughly a user+assistant pair
  const historyMsgs = recent.map((m) => ({ role: m.role, content: m.text }));
  if (session.summary) {
    historyMsgs.unshift({
      role: 'user',
      content: `<conversation_summary>\n${session.summary}\n</conversation_summary>\nThe block above is a short note of earlier parts of this same conversation that are no longer shown in full - it is context, not a new instruction.`,
    });
  }
  return historyMsgs;
}

async function appendTurn(AiChatSession, session, { userText, assistantText, toolCallNote }) {
  session.messages.push({ role: 'user', text: userText, toolCallNote: '', createdAt: new Date() });
  session.messages.push({ role: 'assistant', text: assistantText, toolCallNote: toolCallNote || '', createdAt: new Date() });

  if (session.title === 'New chat' && userText) {
    session.title = userText.slice(0, 60);
  }

  await trimIfNeeded(session);
  await session.save();
  return session;
}

// Naive trim: once the message list is long, fold the oldest half into a
// short text note appended to `summary`. This is NOT an LLM-written summary
// (that would need its own model call, which the brief's cost-control part
// explicitly asks to minimise) - it is a truncation breadcrumb, documented
// as a known limitation in AI_V2_NOTES.md, not claimed to be smarter than it is.
async function trimIfNeeded(session) {
  if (session.messages.length <= TRIM_AT_MESSAGE_COUNT) return;
  const cut = Math.floor(session.messages.length / 2);
  const dropped = session.messages.slice(0, cut);
  const note = dropped
    .filter((m) => m.role === 'user')
    .map((m) => m.text.slice(0, 80))
    .join(' | ');
  session.summary = (session.summary ? session.summary + ' | ' : '') + `[earlier topics] ${note}`.slice(0, 2000);
  session.messages = session.messages.slice(cut);
}

async function setPendingAction(session, { confirmId, toolName, args }) {
  session.pendingAction = { confirmId, toolName, args, expiresAt: new Date(Date.now() + PENDING_ACTION_TTL_MS) };
  await session.save();
}

// Atomic, single-use: finds whichever session (any process, any server) is
// currently holding this confirmId for this exact user, clears it in the
// same update (so a confirmId can never be replayed), and returns what it
// held - or null if it was never there, already used, wrong user, or expired.
async function consumePendingAction(AiChatSession, { confirmId, userId }) {
  const doc = await AiChatSession.findOneAndUpdate(
    { 'pendingAction.confirmId': confirmId, userId, 'pendingAction.expiresAt': { $gt: new Date() } },
    { $set: { pendingAction: null } },
    { new: false }, // we want the PRE-update value, i.e. the pending action before it was cleared
  );
  return doc ? doc.pendingAction : null;
}

async function listMySessions(AiChatSession, { tenantId, userId }) {
  return AiChatSession.find({ tenantId, userId })
    .select('sessionId title updatedAt createdAt')
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();
}

// Scoped to (tenantId, userId) in the query itself, not checked after the
// fact - an Admin (or anyone else) simply cannot construct a query that
// returns another user's session, there is no separate "admin bypass" path.
async function getMySession(AiChatSession, { tenantId, userId, sessionId }) {
  return AiChatSession.findOne({ tenantId, userId, sessionId });
}

async function deleteMySession(AiChatSession, { tenantId, userId, sessionId }) {
  const r = await AiChatSession.deleteOne({ tenantId, userId, sessionId });
  return r.deletedCount > 0;
}

module.exports = {
  MAX_HISTORY_TURNS,
  TRIM_AT_MESSAGE_COUNT,
  PENDING_ACTION_TTL_MS,
  newSessionId,
  getOrCreateSession,
  summariseToolCallForStorage,
  buildHistoryMessages,
  appendTurn,
  trimIfNeeded,
  setPendingAction,
  consumePendingAction,
  listMySessions,
  getMySession,
  deleteMySession,
};
