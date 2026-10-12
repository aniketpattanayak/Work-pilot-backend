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

## Unrelated issue noticed in passing (not fixed, out of scope)

`tenantController.loginEmployee` looks up the tenant with
`Tenant.findOne({ subdomain })` (exact match, no case-folding), while
`createTenant` lowercases the subdomain before saving it
(`subdomain.toLowerCase().trim()`). A login attempt with a differently-cased
subdomain than what was stored will fail with "Factory not found." even
though the company exists. Noticed while writing a test with a mixed-case
test subdomain; not touched, since it's unrelated to the AI assistant work
this branch is scoped to — flagging here for visibility.
