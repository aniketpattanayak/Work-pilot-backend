const mongoose = require('mongoose');

// Part 2 (AI-layer-v2): conversation memory, so the assistant survives a page
// refresh and works across devices, and so pending write-confirmations live
// in Mongo (shared across however many server processes are running) instead
// of a single process's in-memory Map.
//
// Storage discipline (per the brief): never store full tool outputs that may
// carry sensitive fields (bank account numbers, salary figures, etc.) - only
// a short human-readable note of what was looked up. See
// utils/aiAssistant/session.js's summariseToolCallForStorage().

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    text: { type: String, required: true, maxlength: 8000 },
    // Short note only - e.g. "looked up colleague matches for \"Anik...\"" -
    // never the raw tool arguments/result. See session.js.
    toolCallNote: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// A single-use, user-bound, short-TTL staged write action. Replaces the old
// in-memory `pendingConfirmations` Map - living in Mongo means it is visible
// to and consumable by any server process, not just the one that staged it.
const PendingActionSchema = new mongoose.Schema(
  {
    confirmId: { type: String },
    toolName: { type: String },
    args: { type: mongoose.Schema.Types.Mixed },
    expiresAt: { type: Date },
  },
  { _id: false },
);

const AiChatSessionSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    sessionId: { type: String, required: true }, // opaque id the frontend keeps (e.g. in the URL or localStorage)
    title: { type: String, default: 'New chat' },
    messages: { type: [MessageSchema], default: [] },
    // Naive rolling summary of messages trimmed off the front of the array
    // once the session gets long - NOT an LLM-generated summary (that would
    // need its own model call); just enough of a breadcrumb that very old
    // context isn't silently invisible. See session.js's trimIfNeeded().
    summary: { type: String, default: '' },
    pendingAction: { type: PendingActionSchema, default: null },
  },
  { timestamps: true },
);

// A user's own session list / "open one" lookups.
AiChatSessionSchema.index({ tenantId: 1, userId: 1, updatedAt: -1 });
// Per-tenant, per-user, unique sessionId (the frontend-chosen opaque id).
AiChatSessionSchema.index({ tenantId: 1, userId: 1, sessionId: 1 }, { unique: true });
// Fast lookup of a pending confirmation by its id alone (confirmId already
// embeds the user id, so this is sparse/not globally unique across tenants
// in theory, but confirmId's own randomness makes a collision practically
// impossible - and the confirm path still re-checks userId before using it).
AiChatSessionSchema.index({ 'pendingAction.confirmId': 1 }, { sparse: true });

// TTL: a session is deleted this many days after its LAST activity (every
// message append or pending-action update bumps updatedAt, which is what the
// TTL index watches) - configurable via AI_SESSION_TTL_DAYS, read once at
// model-definition time. Changing the env var on an existing deployment
// requires a migration (drop and recreate this index) since Mongo TTL
// indexes don't support runtime reconfiguration - documented in AI_V2_NOTES.md.
const TTL_DAYS = Number(process.env.AI_SESSION_TTL_DAYS) > 0 ? Number(process.env.AI_SESSION_TTL_DAYS) : 30;
AiChatSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('AiChatSession', AiChatSessionSchema);
