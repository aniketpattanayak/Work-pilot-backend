# Deploy notes — AI-layer-v2 (prepare only, not deployed)

This file describes what would need to happen to deploy the work done on
this account, across three separate branches. **Nothing has been deployed.
No server or production database has been touched.** This is a
preparation document only.

## Branches involved

| Branch | Repo | Purpose | Depends on |
|---|---|---|---|
| `fix/respond-task-tenant-isolation` | Work-pilot-backend | Security fix: tenant/ownership check on `PUT /tasks/respond` | `origin/main` only — independent of the AI work, deployable on its own |
| `feature/ai-layer-v2` | Work-pilot-backend | The AI assistant (Parts 1–8) | `origin/main` — does **not** include the security-fix branch; that fix is also applied inside this branch already (it was found via this branch's own eval harness and fixed directly here too), so deploying this branch alone also carries the fix |
| `feature/ai-layer-v2` | Work-pilot-frontend | The AI assistant panel UI (chat, history, choice chips, voice) | `origin/main` — local commit `d8682a5`, not yet pushed (see "Frontend delivery" below) |

Recommended deploy order if both are wanted: `fix/respond-task-tenant-isolation`
first (small, backend-only, fixes a real bug with no AI dependency), then
`feature/ai-layer-v2` for both repos together (the frontend panel calls
backend routes that only exist on the backend's AI-layer-v2 branch).

### Frontend delivery note

This session does not have push access to `aniketpattanayak/Work-pilot-frontend`
(confirmed again this run — `add_repo` with `access: push` was denied). The
Part 5 (voice) commit exists only locally in this session, as commit
`d8682a5` on top of the already-pushed `origin/feature/ai-layer-v2`
(`7bba7c2`/`718cb3b`). It has been generated as a patch file and handed to
the user to apply and push themselves, the same way every other frontend
change on this branch was delivered this session.

## Files changed

**Backend, `fix/respond-task-tenant-isolation`** (3 files, 265 lines):
- `controllers/taskController.js` — tenant + role check added to `respondToTask`.
- `AI_V2_NOTES.md` — decision notes for this fix (new file on this branch only).
- `scripts/fix-respond-tenant-isolation/test-respond-roles-regression.js` — new regression test.

**Backend, `feature/ai-layer-v2`** (28 files, ~6,100 lines, mostly new):
- New AI assistant subsystem: `controllers/aiAssistantController.js`,
  `utils/aiAssistant/{tools,executor,provider,resolve,dateParse,session}.js`,
  `models/AiChatSession.js`, `routes/aiAssistantRoutes.js`.
- `controllers/taskController.js` — adds `getTaskById` (new
  `GET /api/tasks/:taskId` route) and the same tenant/ownership fix to
  `respondToTask` as the standalone security-fix branch.
- `routes/taskRoutes.js` — the new `GET /:taskId` route.
- `middleware/tenantDb.js` — minor adjustment (3 lines) for the AI routes' use.
- `tests/aiAssistant/eval-set.json` + `scripts/ai-eval.js` — the 80-case
  eval harness (Part 7).
- `scripts/phase4-ai-assistant/*.js` — ~13 regression test scripts.
- `AI_V2_NOTES.md` — running notes (env vars, known gaps, decisions).

**Frontend, `feature/ai-layer-v2`** (1 file):
- `src/components/AiAssistantPanel.jsx` — the floating chat panel: chat,
  confirmation cards, chat history, choice chips, phone-width/dark-mode
  layout, and (this round) voice input/output.

## New indexes

All on `AiChatSession` (new collection — `models/AiChatSession.js`), each
tenant's own per-tenant database (this app is one-database-per-tenant, via
`tenantDbMiddleware`), created automatically by Mongoose on first use, no
manual migration needed:
- `{ tenantId: 1, userId: 1, updatedAt: -1 }`
- `{ tenantId: 1, userId: 1, sessionId: 1 }` (unique)
- `{ 'pendingAction.confirmId': 1 }` (sparse)
- `{ updatedAt: 1 }` with `expireAfterSeconds` (TTL — auto-expires old
  sessions/pending actions; the actual number of days comes from
  `AI_SESSION_TTL_DAYS`, default 30)

No indexes were added to any existing collection (`DelegationTask`,
`Employee`, `Tenant`) by either branch.

## New environment variable NAMES (never values — nothing here is set,
## rotated, or printed; these are what ops would need to provision)

- `ANTHROPIC_API_KEY` — required only for the real model to respond; without
  it the assistant degrades gracefully (`"isn't available right now"`
  message) rather than failing to start. **Confirmed this run: the backend
  starts and the entire non-real-model test/eval suite runs end to end with
  no key present in the environment at all.**
- `AI_ASSISTANT_SELF_BASE` — optional; base URL the tool executor calls
  back into this same backend on. Defaults to `http://localhost:<PORT>`;
  only needs setting if the deployed self-base differs (e.g. behind a
  load balancer that doesn't route `localhost`).
- `AI_ASSISTANT_SELF_CALL_TIMEOUT_MS` — optional (new this round, Part 8);
  timeout for the self-call executor. Defaults to `15000`.
- `AI_SESSION_TTL_DAYS` — optional; how long a conversation session is
  kept before the Mongo TTL index expires it. Defaults to `30`.
- `AI_ASSISTANT_MODEL` — optional; which Anthropic model string to use.
  Defaults to `claude-sonnet-4-5`.
- `PORT` — already a standard var in this app; now also used as the
  self-call executor's default self-base.

None of these need to be set for the server to start or for any
non-AI-assistant route to work. `ANTHROPIC_API_KEY` is the only one that
affects AI assistant *behavior* (real vs. degraded replies), and even then
only for companies that have the feature turned on (see below).

## Confirmed: AI assistant is OFF by default, and starts without a key

- `models/Tenant.js`: `superAdmin.aiAssistant.enabled` defaults to `false`
  for every tenant — confirmed by reading the schema (`enabled: { type:
  Boolean, default: false }`). A SuperAdmin must explicitly turn it on per
  company from the SuperAdmin → Controls tab.
- `ANTHROPIC_API_KEY` is read lazily, only inside `callModel()` at the
  moment a chat request actually needs the real model
  (`utils/aiAssistant/provider.js`) — never at module load or server
  startup. Confirmed by running the full backend (`require('../../index.js')`
  as every regression test does) with no key present in this sandbox's
  environment at all, successfully, repeatedly, throughout this session.
- Net effect: deploying this branch changes nothing about any existing
  company's behavior until a SuperAdmin explicitly opts them in, and the
  server's ability to start and serve every other route is unaffected by
  whether `ANTHROPIC_API_KEY` is set.

## Rollback steps

**If `fix/respond-task-tenant-isolation` is deployed alone and needs
rolling back:** revert the single commit on this branch
(`git revert <commit>` or redeploy the previous `main`-based build) — it
only touches `respondToTask`'s permission check; no schema/data migration
to undo.

**If `feature/ai-layer-v2` is deployed and needs rolling back:**
1. Redeploy the previous build (this branch adds new routes/collections,
   it does not modify any existing route's response shape or any existing
   collection's schema, so reverting is a plain redeploy, not a data
   migration).
2. The new `AiChatSession` collection(s) can be left in place harmlessly —
   nothing else reads them — or dropped per tenant database if desired;
   neither action affects any other collection.
3. If any company had the AI assistant turned on, nothing further is
   needed — `superAdmin.aiAssistant.enabled` simply stops being read once
   the routes are gone.
4. No `.env` changes are required to roll back (no new required env var —
   everything new is optional with safe defaults).

## What to check after deploy (when this is actually deployed — not done here)

1. The server starts cleanly and responds on existing routes exactly as
   before (this branch is additive-only to existing routes, except the
   `respondToTask` permission tightening below).
2. **Important behavior change to watch for:** `PUT /api/tasks/respond`
   now enforces tenant + role checks that did not exist before. Any
   existing integration or workflow that was (knowingly or not) relying on
   that route accepting a call from someone outside the task's own
   tenant/doer/assigner/coordinator/helper/forward-chain/Admin set will now
   get a 403/404 instead of succeeding. Watch error rates on this route
   right after deploy.
3. `GET /api/tasks/:taskId` (new route) returns the expected task for a
   legitimate caller and 404 for everyone else, in production data (spot
   check a couple of real task ids as different real users).
4. SuperAdmin → Controls: confirm the AI Assistant toggle still shows every
   company OFF by default right after deploy (i.e., deploying this code
   must not silently turn it on anywhere).
5. If/when a company is turned on and `ANTHROPIC_API_KEY` is set in that
   environment: send one real chat message and confirm a normal reply
   (not the "isn't available" degraded message), then confirm a write
   action still requires and respects the confirmation step.
6. Watch Mongo for the new `AiChatSession` collection(s) building up at a
   reasonable rate relative to actual AI assistant usage (per-tenant
   database, since this app is one-database-per-tenant) — the TTL index
   should keep it from growing unbounded.
7. Frontend: confirm the AI assistant panel renders correctly and the mic/
   read-aloud icons degrade gracefully (no mic icon or a disabled one) in
   whatever browsers are actually used in production that may lack the
   Web Speech API (notably: no Firefox support for `SpeechRecognition` as
   of this session's knowledge — confirm this is acceptable or document it
   as a known limitation for that browser).
