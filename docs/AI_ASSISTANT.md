# AI Assistant (Phase 4)

## What it is

A chat-based assistant that acts strictly **as the currently logged-in employee**. It never has its own privileged path into the data: every action it takes is a real HTTP call to this same backend, carrying the end user's own JWT, through the same middleware (`authMiddleware`, `subscriptionGuard`, `tenantDbMiddleware`, `requirePermission`, etc.) a normal UI click would go through. If the user's account can't do something on screen, the assistant can't do it either — by construction, not by a parallel copy of the permission rules.

Off by default for every company (`Tenant.superAdmin.aiAssistant.enabled = false`). A SuperAdmin turns it on per tenant and sets a monthly usage cap (`PUT /api/superadmin/tenants/:tenantId/ai-assistant`).

## Architecture

```
POST /api/ai-assistant/chat
  → authMiddleware, subscriptionGuard, tenantDbMiddleware
  → controllers/aiAssistantController.js
      - checks Tenant.superAdmin.aiAssistant.enabled (per-company kill switch)
      - checks + bumps the monthly usage counter
      - checks a per-user in-memory rate limit
      - builds the system prompt + fixed tool list
      - calls utils/aiAssistant/provider.js (Anthropic, or a test-only fake model)
      - if the model wants to call a tool:
          - FORBIDDEN_ACTIONS (approve/release/money) → refused immediately, names the screen to open
          - a write tool → staged as a "needsConfirmation" response with a plain-
            language summary; NOT executed yet
          - a read-only tool → executed immediately via utils/aiAssistant/executor.js
      - every executed or blocked action is written to ActivityLog
POST /api/ai-assistant/chat { confirmId }
  → looks up the staged action, runs it via executor.js, clears the confirmId
    (single-use, 5-minute expiry)
```

`executor.js` is the only place a tool call turns into a real effect. It fires `fetch(SELF_BASE + tool.path, { headers: { Authorization: Bearer <the user's own token> } })` — i.e. it is a loopback HTTP client calling this same Express app. Identity fields the model should never be trusted to supply (e.g. `assignerId`, `tenantId` on `create_task`) are injected server-side from the authenticated user, never taken from the model's tool-call arguments.

## The fixed tool list (`utils/aiAssistant/tools.js`)

| Tool | Needs confirmation | What it does |
|---|---|---|
| `list_my_tasks` | No (read-only) | The user's own delegated tasks |
| `create_task` | Yes | Create a task for a named doer, explicit deadline |
| `complete_task` | Yes | Mark the user's own task Completed |
| `view_leave_balance` | No | The user's own leave balance |
| `apply_leave` | Yes | Apply for leave, explicit date range |
| `list_pending_leave_requests` | No | Requests the user is permitted to approve |
| `view_my_payslips` | No | The user's own payslip list only |
| `view_attendance_today` | No | The user's own punch status |
| `find_colleague` | No (read-only, lookup) | Search employees by name — resolves a name to an id for `create_task`, never shown to the user |
| `list_leave_types` | No (read-only, lookup) | List the company's leave types — resolves a name to an id for `apply_leave` |

Every schema is `additionalProperties: false` with explicit required fields, and is now validated server-side (`utils/aiAssistant/validateArgs.js`) before any tool call is run OR staged — a schema-invalid call from the model (missing required field, wrong type, an unexpected extra field) is rejected with a plain message instead of reaching a real route or a confirmation card.

**Lookup tools and the multi-step loop:** `create_task` and `apply_leave` need real MongoDB ids (`doerId`, `leaveTypeId`) that the model can never know on its own and must never guess. `find_colleague` and `list_leave_types` are read-only tools marked `isLookup: true`; the controller executes them immediately (over the same real route/token as everything else) and feeds the result back to the model as `<untrusted_data>` in a proper Anthropic tool-use/tool-result turn, then loops (capped at a few steps) so the model can continue — pick the resolved id, or ask the user to disambiguate if `find_colleague` returned more than one match. The confirmation card shown to the user always names the person/leave type (e.g. "assigned to Priya Sharma"), never a raw id.

**Never a tool, under any circumstance:** `approve_payroll`, `release_payroll`, `change_salary`, `approve_leave`, `reset_admin_password` (the `FORBIDDEN_ACTIONS` map in `tools.js`). If the model tries to call one of these — including as a result of a prompt-injection attempt — `executor.js` refuses it unconditionally, before any HTTP call is made, and tells the user which real screen to open instead.

## Confirmation flow

Any tool with `needsConfirmation: true` is never executed on the first turn. The controller stages `{ toolName, args }` in memory under a short-lived, single-use `confirmId`, returns a plain-language summary (`describeToolCall()`), and waits for the user to send that exact `confirmId` back. Nothing about the staged action can change between staging and execution — the summary shown to the user is exactly what runs.

## Prompt-injection defense

Any user-authored content handed to the model as context (a task title, a chat message, a document) is wrapped by `wrapAsData()` in an explicit `<untrusted_data>` boundary with a standing instruction that content inside it is never a command. This is a defense-in-depth layer, not the only one: even if the model is fooled by injected text into trying to call a forbidden action anyway, `executor.js`'s unconditional `FORBIDDEN_ACTIONS` check still blocks it — the system does not rely on the model behaving.

## Tenant/data safety

The assistant never queries the database directly and never sees a whole table — every read goes through the same tenant-scoped, permission-checked route the UI uses, returning only what that user's own token is entitled to see. It never has access to raw bank details, password hashes, or other users' tokens, because none of the fixed tools return them (the underlying routes already exclude them for the normal UI).

## Rate limiting, usage cap, and audit

- **Per-user rate limit**: in-memory sliding window, 10 requests/minute/user (`controllers/aiAssistantController.js`). Documented limitation: this is per-process state, so it resets per server instance and does not share state across the multi-process/cluster deployment Phase 5 scaling plan calls for — a shared store (Redis) is the fix, not built this session (see `SCALING_PLAN.md`). Idle entries (no request from that user within the window) are swept out of the in-memory map on a periodic timer (`sweepIdleRateBuckets`), so this map does not grow without bound in a long-running process with many distinct users.
- **Per-company monthly cap**: `Tenant.superAdmin.aiAssistant.monthlyLimit`, settable by SuperAdmin, enforced server-side and reset by calendar month, via an atomic `$inc` (the check and the increment happen in the same MongoDB query), so two concurrent requests can never both pass the check and push the count past the cap the way a read-then-save counter could.
- **Audit**: every executed tool call and every blocked forbidden-action attempt is written to `ActivityLog` (`ai_assistant_action` / `ai_assistant_blocked`), visible to SuperAdmin via the existing per-tenant activity log endpoint.

## Model provider

`utils/aiAssistant/provider.js` is the one module that knows about a model provider. Default: the Anthropic API with server-side tool use (`@anthropic-ai/sdk`, installed this session — current version verified via web search rather than relying on training-time memory, since package versions move). The API key is read from `process.env.ANTHROPIC_API_KEY` only; it is never sent to or readable by the client. If no key is configured, or the call errors or times out, the assistant degrades gracefully with a `503 AI_SERVICE_DOWN` and a plain message pointing the user back to the regular screens, instead of crashing the request.

**Model name**: read at startup from `process.env.AI_ASSISTANT_MODEL`, falling back to `'claude-sonnet-4-5'` if that env var isn't set (`const MODEL = process.env.AI_ASSISTANT_MODEL || 'claude-sonnet-4-5'`). This is a single source of truth — nothing else in the codebase hardcodes a model string. **The model actually tested against a real key in this project was `claude-sonnet-4-5`** (the default — `AI_ASSISTANT_MODEL` was never set in any environment this ran in), confirmed by `MODEL` being logged at the start of `scripts/phase4-ai-assistant/test-ai-assistant-real-model.js`. If `AI_ASSISTANT_MODEL` is ever set to a different model before a future real-model run, that run's own log line is the source of truth for which model it actually exercised — this doc should not be assumed current if that changes.

A test-only fake-model injection point (`global.__AI_ASSISTANT_FAKE_MODEL__`) lets test scripts script the model's responses deterministically. It is not reachable from any request parameter, so a real end user can never trigger it — see `AI_ASSISTANT_REPORT.md` for why this was necessary this session (no API key was available) and what was and wasn't therefore verified against a real model.

## What's not built (frontend)

This session built and tested the full backend (routes, permission-equivalence, confirmation flow, forbidden-action blocking, injection defense, rate limiting, usage cap, audit). The floating chat panel UI (mic button, confirmation cards, history, light/dark, desktop/phone, Web Speech API voice input with English/Hindi selection and a text fallback) described in the original brief was **not built this session** — see `AI_ASSISTANT_REPORT.md`'s "Not done" section. The backend is ready for that UI to be built against: `POST /api/ai-assistant/chat` is the only endpoint it needs.
