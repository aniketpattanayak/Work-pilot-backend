# Phase 5 — Scale Readiness Report

Branch: `perf/scale-readiness` (off `payroll-phase3-4`).
Full plan and reasoning: `docs/SCALING_PLAN.md`. This report is the numbers; the plan is the "what to do about them."

## This session's scope vs. the brief's ask (read this first)

The brief asked for 50 companies / ~200k employees seeded, k6/autocannon across ten named routes, a pm2-cluster-mode comparison, and a built-or-planned queue. This sandbox is **2 vCPUs, ~8GB RAM**, running against `@lossless.org/nosqldb` (a lightweight local test-DB shim, not real MongoDB) — not a laptop, and nowhere close to a production host or a real multi-node Mongo cluster. Running the full brief literally here would have mostly measured this sandbox's own limits, not the application's, and would have taken far longer than this session had. **What was actually run**: one tenant seeded with 2,000 employees + a month of attendance (88,000 punch records), written directly to the DB; two routes load-tested with `autocannon` against the real running backend; a direct `.explain()` check of the underlying query and its indexes; and a codebase check for in-memory state that would break under 3-server + load-balancer. Everything below is explicit about **Measured** (real numbers from this sandbox) vs. **Estimated/Not run** (reasoned, not measured) — see `docs/SCALING_PLAN.md` for the honest 20k/100k extrapolation and what it is and isn't based on.

## Headline measured numbers

| Metric | Value | Measured how |
|---|---|---|
| Seed: 2,000 employees | 267ms | direct-to-DB bulk insert, bypassing the API |
| Seed: 88,000 attendance punches (22 working days × 2,000 employees) | ~6.4s | direct-to-DB bulk insert |
| `GET /employees/:tenantId` raw Mongo query (2,000-doc tenant) | **41ms**, `IXSCAN` on `{tenantId:1,email:1}`, 0 wasted doc scans | `.explain('executionStats')` |
| Same route under load, single process, 2 vCPUs, 20 concurrent connections, 10s | **~15 req/sec, p50 ≈1.23s, p99 ≈1.9s** | `autocannon -c 20 -d 10` |

**The one finding that matters most**: the database query is fast and properly indexed; the single Node process is the actual bottleneck under concurrency. This reframes the rest of the scaling work — it's a process/concurrency problem first, a query-optimization problem second (see `docs/SCALING_PLAN.md`'s "process-level fix" section).

## Indexes

Checked `employees` and `Punch` (attendance) collections directly: both already have compound indexes **led by `tenantId`** (`{tenantId:1,email:1}`, `{tenantId:1,createdAt:-1}`, `{tenantId:1,whatsappNumber:1}` on employees; `{tenantId:1,employeeId:1,date:1}`, `{tenantId:1,reviewStatus:1}` on Punch) — exactly the pattern the brief asks indexes to follow. **No index fix was needed** on the two routes checked. This is not a full audit of every route's query shape — only 2 were checked this session.

## N+1 check

Read `attendanceController.js`'s `buildDays()` (the function behind both the attendance sheet and the live/today view) end to end: it does **one** bulk `$in` query for all requested employees' punches, not one query per employee. This is a genuine positive finding, not a gap — worth noting precisely because the opposite (a per-person loop) was what Phase 1's scale slice was specifically watching for.

## A deliberate, correct guard rail (not a bug)

`GET /attendance/sheet` refuses to run for more than 1,000 employees in a single un-narrowed call (`"Too many people. Narrow it down by department."`). This meant the 2,000-employee seeded tenant could not be used to load-test this specific route without first filtering by department — recorded here rather than worked around, since it's existing, sensible behavior.

## Statelessness: what's unsafe for 3-server + load balancer

Full table and reasoning in `docs/SCALING_PLAN.md`. Summary: **JWT auth is already stateless** (no fix needed). Four things are not:
1. The 30s permission cache (`middleware/permission.js`) — low-risk bounded staleness, same with or without multiple servers.
2. The Phase 4 AI assistant's in-memory per-user rate limiter — already flagged in `AI_ASSISTANT_REPORT.md`; needs Redis before a multi-process AI-assistant rollout.
3. **Four separate in-process cron schedules** (daily report scheduler, FMS Google-Sheet sync running every minute, FMS2 notifier on 3 schedules, per-tenant morning briefing) — every one of N server instances would run every one of these, meaning N× duplicate reports/reminders/escalations/briefings. This is a real architectural gap, not patched this session (needs a single-designated-runner lock).
4. **Socket.io has no Redis (or other) adapter** — confirmed by grep; chat/real-time delivery would silently fail to cross server boundaries in a multi-server deployment. Not patched this session.

Local-disk file uploads (the S3 fallback) are also unsafe multi-server but already have a configuration-only fix (set the S3 env vars) — not a code change.

## Rate limits / size limits / timeouts / export caps

- **No general-purpose rate limiting exists anywhere in the API** (re-confirmed via grep this session; this was first found during the Phase 2 product-mapping pass) — only Phase 4's AI assistant has one, and it's per-process. This is the biggest concrete risk for "one heavy company slowing everyone else," and there is currently nothing to test, since the mechanism doesn't exist yet.
- Request size limits and DB query timeouts were **not checked** this session (time).
- Export size caps exist ad hoc per-feature (attendance sheet's 1,000-person cap above); no project-wide cap.
- **"A heavy company can't slow others" demonstration test: not run** — correctly scoped as not possible until the rate-limiting layer above exists. Listed under Not Tested rather than faked.

## Queue design

Not built this session. `docs/SCALING_PLAN.md` proposes BullMQ+Redis (reusing the same Redis the rate-limiter and cron-lock fixes above would need anyway) over a Mongo-based queue, with payroll-run-for-a-large-company as the top candidate to move off the request/response cycle — but this was never actually measured as slow this session (the seeded tenant's payroll was not exercised; see Not Tested), so that priority is based on the code's shape (multi-step `buildLines` computation per employee), not a measured number.

## Re-running earlier test suites after changes

No code changes were made to any existing route during this phase (only new seed/test scripts were added), so there was nothing that required re-running Phase 1-4's regression suites for a regression check. If the process-level fix (pm2 cluster mode) or any rate-limiting middleware is added in a follow-up, Phases 1-4's regression scripts should all be re-run afterward, since cluster mode in particular can surface the exact in-memory-state bugs flagged above (e.g. the AI assistant's rate limiter and monthly-cap counter would need to move to Redis first, or a follow-up test would legitimately fail under cluster mode in a way that isn't a regression in the code, just a known architecture gap).

## Decisions needed

1. Is a dedicated follow-up session (with more compute, and ideally a real MongoDB rather than the local test shim) warranted to run the brief's full 50-company/200k-employee scope, now that this session has identified where the real bottleneck likely is (process concurrency, not queries)?
2. Should the pm2-cluster-mode benchmark (1 process vs. cluster across available cores, same load profile as the one route measured here) be the very next thing done, given it's the highest-leverage fix identified and wasn't benchmarked this session?
3. BullMQ+Redis vs. a Mongo-based queue (e.g. `agenda`) for the proposed job queue — is introducing Redis acceptable infra-wise, given it would also fix the rate-limiter and cron-duplication gaps in one piece of infrastructure?
4. Should general-purpose (not just AI-assistant-specific) per-tenant rate limiting be built before any further scale work, since it's both the biggest "noisy neighbor" risk and a prerequisite for the "heavy company can't slow others" test the brief asks for?
5. Who owns deciding the single-designated-cron-runner pattern (env flag vs. a DB/Redis lock) before any multi-process deployment ships the existing scheduled jobs?

## Not tested / not done

- The brief's actual scale (50 companies / ~200k employees) — only 1 tenant / 2,000 employees was seeded and measured.
- k6 (only `autocannon` was used, and only against 2 of the brief's 10 named routes: employee-list and an attempted attendance-sheet call that correctly 400'd).
- pm2 cluster-mode comparison.
- Payroll-run-for-a-large-company timing (not exercised against the seeded tenant at all).
- General request size limits, DB query timeouts.
- A demonstrated "heavy company can't slow others" test (no rate-limiting layer exists yet to test).
- Building the proposed job queue (plan only, in `docs/SCALING_PLAN.md`).
- Anything requiring a real multi-node MongoDB cluster or a real network between hosts — this sandbox has neither, and no laptop/sandbox test can substitute for that; `docs/SCALING_PLAN.md`'s infra approximations are explicitly estimates, not measurements.
