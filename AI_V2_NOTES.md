# AI-layer-v2 notes

Working notes for the `feature/ai-layer-v2` branch. This file lists env var
**names** the AI assistant relies on — never values. Keys stay exactly as set
on the server; nothing here is a deploy or key-rotation instruction.

## Env vars this feature reads (names only)

- `ANTHROPIC_API_KEY` — required for the real model. Already set on the
  server; not touched by this branch.
- `AI_ASSISTANT_SELF_BASE` — optional; base URL the tool executor calls back
  into this same backend on (defaults to `http://localhost:<PORT>`).
- `AI_SESSION_TTL_DAYS` — optional; how long a conversation session is kept
  before Mongo's TTL index expires it (defaults to 30).
- `PORT` — standard Express port, used by the executor's default self-base.

Per-tenant: the AI assistant is OFF by default for every company
(`tenant.superAdmin.aiAssistant.enabled`), with a monthly usage cap
(`monthlyLimit`, default 500) enforced by an atomic counter. A SuperAdmin
turns it on per company from the SuperAdmin → Controls tab.

## What the assistant can and cannot do

It always acts as the logged-in user, over the same HTTP routes/JWT the
normal UI uses — never a separate privileged path. Payroll approve/release,
salary changes, leave approval, and password resets are not tools at all;
the assistant names the screen to open instead.

Every write needs an explicit confirmation card first (single-use, Mongo-
backed, short TTL) and is audit-logged.

## Known gaps / future features (not implemented, by design)

- **`task_comments` / `add_task_comment`** — there is no comment thread
  anywhere on a task today. `DelegationTask` has no comments field, and
  `respondToTask`'s `remarks` is a single last-value string, not a log of
  individual comments. Adding real comment support would need a schema
  change (an array of `{authorId, text, createdAt}`) plus a new route
  (`POST /tasks/:taskId/comments`, `GET /tasks/:taskId/comments`) — out of
  scope for this branch; flagged here as a future feature to build.
- **`my_attendance` date ranges** — `GET /attendance/my` only accepts a
  whole calendar month (`month=YYYY-MM`), not an arbitrary `from`/`to`
  range. A user asking "my attendance from the 3rd to the 20th" gets the
  whole month back; the assistant should say so rather than imply it
  filtered. Supporting a real range would need a change to
  `attendanceController.myMonth`, out of scope here.

## task_details (added this round)

`GET /api/tasks/:taskId` did not exist before (only `PUT`/`DELETE`). Added
with the same tenant-isolation check as `updateTask`/`deleteTask`, plus a
visibility check: only the task's assigner, doer, helper doers, coordinator,
forward-chain members, or an Admin/superAdmin of the same tenant can read
it — everyone else gets `404`, never `403`, so the route never confirms a
task id exists to someone outside its reach. Covered by
`scripts/phase4-ai-assistant/test-task-details-regression.js`.

## Part 7: eval set + harness, and a real bug it caught

`tests/aiAssistant/eval-set.json` (80 cases, English/Hindi/Hinglish) and
`scripts/ai-eval.js` run against the fake model by default, or the real
model with `--real` when `ANTHROPIC_API_KEY` is already present in the
shell (never written anywhere; `--real` refuses outright if the key is
missing rather than quietly running the fake model under that flag).
Harness result: 72/72 scorable = 100%, 32/32 safety cases = 100%
(`memory_followup`'s 8 cases are not scorable against a scripted fake
model and are reported as such).

While building the `cross_company` runner, the harness caught a **real**
bug, not a test bug: `PUT /api/tasks/respond` (behind the `complete_task`
tool) had no tenant-isolation or ownership check at all — any
authenticated caller who had (or was told, including via the AI assistant
forwarding a user-supplied id) a `taskId` from a different company could
mark that company's task Completed/Verified. Fixed in
`controllers/taskController.js`'s `respondToTask` with the same
tenant + reach check `updateTask`/`deleteTask`/`getTaskById` already use.
Covered by `scripts/phase4-ai-assistant/test-respond-tenant-isolation-regression.js`
(13/13 pass), which also proves legitimate doers are unaffected.

Three test-authoring mistakes were found and corrected in the eval set
itself (never loosened to force a pass — each was simply wrong):
the typo case for "Anikeet" expected the resolved name as `Aniket`
instead of the roster's real `Aniket Kumar`; a `Priya`-typo case collided
with the `ambiguous_name` category's own seeded roster (which deliberately
has both `Priya Sharma` and `Priya Verma`), so a bare `"Priya"` query is
genuinely ambiguous there and the case was changed to a misspelling that
disambiguates to one specific name; a `no_result` case's query
(`Zzzznonexistent`) coincidentally shared a 3-character prefix with the
eval harness's own auto-generated tenant-admin name (the harness names its
throwaway tenants `zzz-eval-...`), tripping `resolve.js`'s real
3-character prefix-match threshold — changed to a token with no such
collision.

## Part 8: load and cost

- **Non-blocking**: `/ai-assistant/chat` has no synchronous/CPU-heavy work;
  every step (DB reads/writes, the model call, each self-call) is
  `await`ed async I/O. Confirmed concurrently: a slow in-flight chat
  request does not delay an unrelated request hitting the same process
  (`scripts/phase4-ai-assistant/test-part8-load-cost-regression.js`).
- **Timeouts**: the model call already had a 20s timeout
  (`utils/aiAssistant/provider.js`, `new Anthropic({ timeout: 20000 })`).
  The self-call executor (`utils/aiAssistant/executor.js`, every tool's
  HTTP round-trip back into this same backend) had **no timeout at all**
  before this round — fixed with an `AbortController`, default 15s,
  overridable via `AI_ASSISTANT_SELF_CALL_TIMEOUT_MS`; a timeout now
  returns a clean `504` with "nothing was changed" rather than hanging the
  request indefinitely. The multi-step lookup loop was already capped at
  `MAX_LOOKUP_STEPS = 4`.
- **Average tokens per request**: cannot be measured in this sandbox — no
  `ANTHROPIC_API_KEY` is present, so no real model call has ever been
  made here. Added `getTokenUsageStats()` to `utils/aiAssistant/provider.js`,
  which now records `resp.usage.{input_tokens,output_tokens}` from the SDK
  on every real call and reports the running average; it correctly reports
  zero calls / zero average right now rather than a fabricated estimate.
  Once a key is available, this will report real numbers with no further
  code change.
- **Server-memory-only state, audited**: the AI session/conversation
  history and any pending (unconfirmed) action are Mongo-backed
  (`AiChatSession`, from Part 2) — not memory-only. The per-company
  monthly usage counter is an atomic Mongo `$inc` (`checkAndBumpUsage`) —
  not memory-only. The only memory-only state is (a) the per-user rate
  limiter buckets (`rateBuckets` in `controllers/aiAssistantController.js`)
  and (b) the new token-usage running totals above — both are
  operational/cost metrics, not user data; losing either on a restart just
  resets a soft counter, never loses a conversation, a pending action, or
  usage billing accuracy.

## Unrelated issue noticed in passing (not fixed, out of scope)

`tenantController.loginEmployee` looks up the tenant with
`Tenant.findOne({ subdomain })` (exact match, no case-folding), while
`createTenant` lowercases the subdomain before saving it
(`subdomain.toLowerCase().trim()`). A login attempt with a differently-cased
subdomain than what was stored will fail with "Factory not found." even
though the company exists. Noticed while writing a test with a mixed-case
test subdomain; not touched, since it's unrelated to the AI assistant work
this branch is scoped to — flagging here for visibility.
