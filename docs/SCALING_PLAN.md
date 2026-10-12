# Scaling Plan (Phase 5)

## Scope actually run this session, and why it's smaller than the brief asked for

The brief asked for 50 companies / ~200k employees, k6/autocannon across ten routes, pm2 cluster-mode comparisons, and a full queue design/build. This sandbox has **2 vCPUs and ~8GB RAM**, and its local database is `@lossless.org/nosqldb`, a lightweight Mongo-wire-compatible **test** server, not real MongoDB — both are far from a production host or a real multi-node Mongo cluster. Seeding and hammering 200k documents here would mostly measure this sandbox's own ceiling and the test-DB shim's behavior, not the application's. So this session ran a **scaled-down, honestly-labeled** version: one tenant seeded with 2,000 employees and a month of attendance (88,000 punch records) written directly to the DB, then load-tested against the real running backend with `autocannon`. Every number below is marked **Measured** (really observed in this sandbox) or **Estimated** (extrapolated/reasoned, not measured) — see `SCALE_REPORT.md` for the full numbers and what wasn't run at all.

## What a real deployment needs, by the numbers

| Target | Employees | Approach |
|---|---|---|
| Current test | 2,000 (1 tenant) | **Measured** this session |
| Near-term (one large customer) | 20,000 | **Estimated** by extrapolation below |
| Platform-wide | 100,000+ across many tenants | **Estimated**, infra sketch only |

**Estimation method**: the one route actually measured under load (`GET /api/tasks/employees/:tenantId`, 2,000-employee tenant) showed the underlying Mongo query itself is fast and properly indexed (41ms, index scan on `{tenantId:1,email:1}`, see `SCALE_REPORT.md`), but end-to-end latency under concurrent load was much higher — which points at the single Node process's own CPU/event-loop ceiling (and, likely, the lightweight test-DB shim) rather than the query. **This means the 20k/100k estimates below are not a simple linear multiply of the 2k number** — they assume the two concrete fixes below (indexes already exist; the real lever is process concurrency) are in place, not a bigger single process.

- **20,000 employees, one company**: the employee-list/dashboard-style read paths are already indexed by `tenantId` (confirmed - see below), so a single such tenant's reads should remain fast; the risk at this size is write-heavy operations (a 20k-person payroll run, a bulk CSV import) which should be queued rather than run inline (see Queueing below). *Not measured this session - estimated from the architecture, not from a 20k seed.*
- **100,000+ across many tenants**: the system is already multi-tenant by `tenantId` on nearly every collection, so this is mostly "more of the same tenant isolation that already works," **provided** every hot query filters by `tenantId` first in its index (true for the ones checked - see below) and provided the process-level fixes below (cluster mode + a shared cache/rate-limit store) are made. *Not measured — estimated.*

## What was measured

- **Employee list** (`GET /api/tasks/employees/:tenantId`) against the seeded 2,000-employee tenant:
  - Raw Mongo query (via `.explain('executionStats')`): **41ms**, `IXSCAN` on the existing `{tenantId:1, email:1}` compound index, docs examined == docs returned (no over-fetching).
  - Under load (`autocannon -c 20 -d 10`, 20 concurrent connections, 10 seconds, single Node process, 2 vCPUs): **~15 requests/sec, p50 latency ≈1.23s, p99 ≈1.9s** — i.e. the database layer is fine, but the single Node process becomes the bottleneck well before the database does. This is the single clearest, most important measured finding this session: **the current single-process deployment is the limiting factor, not the queries**.
- **Attendance sheet** (`GET /api/tasks/attendance/sheet`) correctly refuses to run for more than 1,000 employees in one call without narrowing by department (`"Too many people. Narrow it down by department."`) — a deliberate guard rail, not a bug, and it means this particular route was not a useful thing to load-test at 2,000 employees in one tenant (it would always 400).
- **Seeding itself**: 2,000 employees in 267ms, 88,000 attendance punches in ~6.4s, direct-to-DB (bypassing the API), confirming bulk writes themselves are not the bottleneck.

## Fix already confirmed in place (no change needed)

`employees`, and the `Punch` model used by attendance, both carry compound indexes **led by `tenantId`** (`{tenantId:1,email:1}`, `{tenantId:1,employeeId:1,date:1}`, etc.) — this is exactly the "indexes starting with tenant key" requirement the brief calls out, and it is already true for every index this session checked. No index fix was needed this session; this should still be re-verified against the full query set in a dedicated pass, since only 2 routes were checked.

## Process-level fix needed (the real lever, per the one measurement above)

The backend currently runs as a **single Node process** (`node index.js`, no pm2/cluster config found in the repo). Given the measured result above — the DB is fast, the process under concurrent load is not — **running in pm2 cluster mode across available CPU cores is the single highest-leverage fix available**, ahead of any query optimization. This was not benchmarked this session (no pm2 cluster-mode run was done, due to time) — doing that comparison (1 process vs. cluster mode, same load profile) is the top item for a follow-up session.

## Statelessness check (what's kept in server memory/disk)

| What | Where | Safe for 3-server + load balancer? | Fix |
|---|---|---|---|
| Permission cache (30s TTL) | `middleware/permission.js` | **No** — each server's cache can disagree with the others for up to 30s after a role change | Low risk as-is (bounded staleness, same behavior single-process or not); move to Redis only if 30s staleness becomes a real complaint |
| AI assistant per-user rate limit (Phase 4) | `controllers/aiAssistantController.js`, in-memory `Map` | **No** — a user hitting different servers behind a load balancer gets `N × limit`, not the intended limit | Move to a Redis-backed counter before any multi-process AI-assistant rollout (flagged already in `AI_ASSISTANT_REPORT.md`) |
| Cron jobs: daily report scheduler, FMS Google-Sheet sync (`* * * * *`), FMS2 notifier (3 separate cron schedules), per-tenant morning briefing | `jobs/cronScheduler.js`, `utils/fmsScheduler.js`, `utils/fmsNotifier.js`, `utils/briefingEngine.js` — all use in-process `node-cron` | **No** — every one of N server instances would run every one of these schedules, meaning N× duplicate reports, N× duplicate WhatsApp reminders/escalations, N× duplicate briefings | Needs a single-designated-runner pattern (a `PRIMARY_INSTANCE` env flag, or a lock in the DB/Redis that only one instance can hold at a time) before scaling past 1 process |
| Chat / real-time (`Socket.io`) | `utils/socketHandler.js` | **No** — no Redis (or other) adapter is configured, confirmed by grep; a user connected to server A cannot receive a message sent via server B | Add the official `socket.io-redis` adapter before multi-server chat is reliable |
| File uploads (local disk fallback) | multer destinations when S3 isn't configured (`⚠️ AWS S3 not configured` warning seen on every boot this session) | **No** — a file uploaded to server A's local disk is invisible to server B | Already has an escape hatch (S3) - just needs S3 actually configured in production, not a code change |
| Everything else checked (sessions, JWTs) | — | **Yes** — auth is stateless JWT, no server-side session store found | No fix needed |

Of these, the **cron-job duplication** and the **Socket.io adapter** are the two "hard" items from the brief's own framing (not fixable by a one-line env flag) — both are architecture decisions, not bugs, and are listed under Decisions Needed in `SCALE_REPORT.md` rather than patched speculatively this session.

## Rate limits, size limits, timeouts, export caps — current state

- **Per-user/per-company rate limiting**: none exists anywhere in the general API (confirmed by a codebase-wide grep for `rate-limit`/`rateLimit` during the Phase 2 research pass) — only the Phase 4 AI assistant has one, and it's in-memory/per-process (see above). **This is the single biggest "a heavy company could slow others" risk** on this list, since nothing stops one tenant's traffic pattern from consuming all of a shared process's capacity.
- **Request size limits**: not checked this session for the general API; worth a dedicated pass (file upload size caps specifically, since `multer` is in use).
- **DB query timeouts**: not checked this session.
- **Export size cap**: the payroll CSV export (`payroll/runs/:id/export`) and attendance sheet (`attendance/sheet`, capped at 1,000 employees per call as noted above) have their own ad hoc limits; no single project-wide export cap exists.
- **"Heavy company can't slow others" test**: **not run this session** (would need the general rate-limiting layer above to exist first — there's nothing to test yet).

## Proposed queue design (not built this session)

Candidates to move out of the request/response cycle, in priority order based on what this session actually found to be slow or risky:
1. **Payroll run creation/recalculation for a large company** — already a multi-step computation (`buildLines` pulling attendance + leave + statutory + TDS per employee); should become a queued job with a polling/webhook status rather than a synchronous request once a company's employee count makes it slow (not measured at a size where it was actually slow this session — the seeded tenant's payroll was not exercised, see "Not tested" below).
2. **Exports** (payroll CSV, attendance sheet, activity log) — same reasoning, lower priority since these already have ad hoc size caps.
3. **WhatsApp/notification sends** — already fire-and-forget-ish via `utils/notify.js`, but still run inline within the request; low risk since the sandbox's own egress proxy blocks the real WhatsApp endpoints anyway (confirmed in Phase 1), so this was never actually exercised end-to-end.
4. **AI assistant calls** — already a separate endpoint; could be queued if real-model latency becomes a problem once a key is configured (see `AI_ASSISTANT_REPORT.md`).

**Recommendation, not built**: BullMQ + Redis (Redis is already implied as needed for the rate-limiter and cron-lock fixes above, so it isn't an extra piece of infrastructure to introduce — it's the same piece doing double duty). A Mongo-based queue (e.g. `agenda`) would avoid adding Redis at all, at the cost of being slower and less battle-tested for this kind of fan-out work; worth a short discussion before committing to either, since there is no existing production dependency pulling the decision one way yet.

## Infra approximations (estimated, not measured)

- **20k concurrent users, single company**: given the 2k-employee single-process result above (DB fine, process the bottleneck), a realistic starting point is **pm2 cluster mode across all available cores on one host**, plus the Redis-backed rate limiter/cron-lock fixes above, before even considering a second host. A concrete node-count/instance-size recommendation would need the cluster-mode benchmark this session didn't get to.
- **100k+ concurrent across many tenants**: 2-3 application hosts behind a load balancer (now meaningful once the statelessness fixes above are in), a managed MongoDB cluster (Atlas or equivalent) sized for the combined working set, Redis for rate limiting/cron-locking/BullMQ, and the per-tenant `customMongoUri` escape hatch already in the codebase for any one customer who outgrows the shared cluster.

## The 5 production monitoring numbers

Given everything above, the five numbers worth a dashboard/alert from day one of a real rollout:
1. **p95 request latency**, overall and broken out for the payroll-run and attendance-sheet routes specifically (the two already known to be either slow-at-scale or deliberately capped).
2. **Requests/sec vs. error rate**, per process — the measured result this session (DB fine, process saturates) means this is the number that will first show "we need more processes/cores," not DB metrics.
3. **MongoDB connection pool utilization / queued operations** — the earliest warning sign before query latency itself degrades.
4. **Cron job duplicate-run count** — once running multi-process, a simple counter per cron job per boot would immediately reveal the duplication risk flagged above before it causes a customer-visible incident (duplicate WhatsApp messages, duplicate reports).
5. **AI assistant monthly-usage-cap hits and rate-limit hits**, per tenant — both direct proxies for "is a company actually using this, and is the cap right," and (via the per-process rate-limiter caveat above) an early signal that the in-memory limiter needs replacing once seen misbehaving across instances.
