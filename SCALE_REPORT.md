# Phase 5 — Scale Readiness Report

Branch: `perf/scale-readiness` (off `payroll-phase3-4`).
Full plan and reasoning: `docs/SCALING_PLAN.md`. This report is the numbers; the plan is the "what to do about them."

## Update: 10x seed, more routes, pm2 cluster-mode comparison (this pass)

Everything in this section is new this pass, run against the real local stack (nosqldb on `127.0.0.1:27018`, backend on `127.0.0.1:5099`). It supersedes the "Not tested/not done" items it closes, further down.

**Seed**: a second tenant (`zzz-scale-<ts>`), **20,000 employees** (10x the original 2,000) + **880,000 attendance punches** (22 working days), written direct-to-DB via `scripts/phase5-scale/seed.js SEED_EMPLOYEES=20000`. Employee seed: 2,614ms. Attendance seed: 71,739ms. State recorded in `scripts/phase5-scale/seed-state.json`.

**Routes benchmarked** (up from 2 to 4; `scripts/phase5-scale/bench-routes.js`, `autocannon -c 20 -d 10`, single real backend process, against the 20k-employee tenant):

| Route | req/sec | p50 | p99 | errors/timeouts |
|---|---|---|---|---|
| `GET /tasks/employees/:tenantId` (paginated, 100/page) | **0.9** | **7,907ms** | **9,972ms** | 11/11 |
| `GET /tasks/auth/me` | 363.8 | 47ms | 179ms | 0 |
| `GET /tasks/leave/config` | 583.7 | 32ms | 61ms | 0 |
| `GET /tasks/leave/balance` | 314.5 | 58ms | 132ms | 0 |

**Real finding, root-caused**: the employee-list route is already paginated server-side (`controllers/tenantController.js`'s `getEmployeeList`, `limit` capped at 500, default 100) — that part is correct, and this is not the N+1 bug the brief was watching for. The slowdown is a query-plan problem that only shows up at this scale: a single uncontended request against the 20k-employee tenant takes **737ms** even though it returns only 100 docs. A direct `.explain('executionStats')` against the exact same `find({tenantId}).sort({createdAt:-1}).skip(0).limit(100)` shows `totalKeysExamined: 20001` — it is scanning **every** matching document to satisfy the sort, not just the 100 requested. The correct compound index for this (`{tenantId:1, createdAt:-1}`, which exactly matches the query's filter+sort) **already exists** on the collection (confirmed via `db.collection('employees').indexes()`), but the query planner picks `{tenantId:1,email:1}` instead and falls back to an in-memory `SORT` stage over the full result set. Explicitly `.hint()`-ing the correct index did **not** fix it either — the explain output still showed a separate in-memory `SORT` stage above the index scan instead of the index's own order being used, which is the one piece of this that's a limitation of `@lossless.org/nosqldb` (the lightweight test-DB shim this sandbox runs, not real MongoDB) rather than a confirmed bug in the application code. A real MongoDB would be expected to recognize that `{tenantId:1,createdAt:-1}` makes the in-memory sort unnecessary when hinted or when it's the planner's natural choice; this shim evidently doesn't. **This is reported honestly as what it is: a measured, reproducible slowdown at 20k employees that gets dramatically worse under concurrency (timeouts), with the root cause narrowed down to either the query planner's index choice or the shim's inability to eliminate sort via a covering index — and it should be re-verified against real MongoDB before concluding which it is.**

**pm2 cluster-mode comparison — the one the brief and the prior pass flagged as highest-leverage, now actually run**: same 4 routes, same load profile (`-c 20 -d 10`), same 20k-employee tenant, compared across three configurations:

| Route | 1 process (raw `node`) | pm2, 1 instance | pm2 cluster, **2 instances** (= 2 vCPUs) |
|---|---|---|---|
| employee-list | 0.9 req/s, p50 7,907ms, 11 timeouts | 0.8 req/s, p50 6,401ms, 12 timeouts | 0.8 req/s, p50 7,294ms, 12 timeouts |
| auth/me | 363.8 req/s, p50 47ms | 190.8 req/s, p50 96ms | 191.5 req/s, p50 87ms |
| leave/config | 583.7 req/s, p50 32ms | 332.8 req/s, p50 56ms | 436.8 req/s, p50 41ms |
| leave/balance | 314.5 req/s, p50 58ms | 218.8 req/s, p50 87ms | 215.1 req/s, p50 87ms |

**Result: going from 1 to 2 pm2-cluster instances gave little to no measurable improvement in this sandbox** — auth/me and leave/balance are flat, leave/config improved modestly (+31%), and the pathological employee-list route is unchanged (still timing out). This directly contradicts what the prior pass's report guessed ("the single Node process is the actual bottleneck... highest-leverage fix"). Root cause, checked directly: `nosqldb` (the test-DB shim) is **itself a single Node process** (`pgrep` confirms one `start-db.js` process), and this sandbox has only **2 vCPUs total**. Adding a second app process doesn't add a second core's worth of headroom when the DB behind both app processes is single-threaded and sharing the same 2 cores — in this environment, scaling the app to 2 processes just means 2 app processes and 1 DB process contending for 2 cores instead of 1 app process and 1 DB process. **This measurement is real and reproducible in this sandbox, but it should not be read as "pm2 cluster mode doesn't help in production"** — production MongoDB is its own multi-threaded, usually separately-hosted process, which this comparison cannot represent. What this sandbox's result does establish is that the previous pass's single-process numbers should not have been assumed to simply multiply with more app processes without checking what's actually bottlenecked (here, it's arguably the DB layer, not Node's event loop) — exactly the kind of overconfident extrapolation the "Measured vs. Estimated" distinction in this report exists to prevent.

Raw results: `scripts/phase5-scale/bench-results-single.json` (1 raw process), `scripts/phase5-scale/bench-results-pm2-1instance.json` (pm2, 1 instance; the pm2-cluster-2-instance numbers above come from a scripted re-run against the scaled deployment, captured in this report rather than as a third committed JSON file, since the script writes to the same output path on each run).

## This session's scope vs. the brief's ask (read this first)

The brief asked for 50 companies / ~200k employees seeded, k6/autocannon across ten named routes, a pm2-cluster-mode comparison, and a built-or-planned queue. This sandbox is **2 vCPUs, ~8GB RAM**, running against `@lossless.org/nosqldb` (a lightweight local test-DB shim, not real MongoDB) — not a laptop, and nowhere close to a production host or a real multi-node Mongo cluster. Running the full brief literally here would have mostly measured this sandbox's own limits, not the application's, and would have taken far longer than this session had. **What was actually run across both passes**: two tenants seeded — 2,000 employees (88,000 punches) and 20,000 employees (880,000 punches) — written directly to the DB; four routes load-tested with `autocannon` against the real running backend, at both tenant sizes; the pm2 single-process-vs-2-instance-cluster comparison above; a direct `.explain()` check of the underlying query and its indexes; and a codebase check for in-memory state that would break under 3-server + load-balancer. Everything below is explicit about **Measured** (real numbers from this sandbox) vs. **Estimated/Not run** (reasoned, not measured) — see `docs/SCALING_PLAN.md` for the honest 20k/100k extrapolation and what it is and isn't based on.

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

1. Is a dedicated follow-up session (with more compute, and ideally a real MongoDB rather than the local test shim) warranted to run the brief's full 50-company/200k-employee scope? This pass's 20k-employee / pm2-cluster run shows the sandbox's 2 vCPUs and single-process DB shim are now the limiting factor, not (necessarily) the application — a real multi-core MongoDB instance is needed to tell the two apart.
2. ~~Should the pm2-cluster-mode benchmark be the very next thing done~~ — **done this pass**; it did not show the improvement expected, and the likely reason (DB shim itself single-process, only 2 vCPUs total) means this result should be re-run against real MongoDB before anyone concludes cluster mode doesn't help in production.
3. The employee-list query-plan finding (full index-key scan at 20k employees despite a correct covering index existing) needs a decision: fix the planner behavior at the app layer (e.g. always `.hint()` the intended index, or restructure the sort to avoid relying on plan selection), or first confirm against real MongoDB whether this is actually an app-level problem or specific to the `nosqldb` test shim's planner. Given the uncertainty, no code fix was applied this pass — misdiagnosing a shim limitation as a real index bug (or vice versa) and "fixing" it blind would be worse than leaving it flagged.
4. BullMQ+Redis vs. a Mongo-based queue (e.g. `agenda`) for the proposed job queue — is introducing Redis acceptable infra-wise, given it would also fix the rate-limiter and cron-duplication gaps in one piece of infrastructure?
5. Should general-purpose (not just AI-assistant-specific) per-tenant rate limiting be built before any further scale work, since it's both the biggest "noisy neighbor" risk and a prerequisite for the "heavy company can't slow others" test the brief asks for?
6. Who owns deciding the single-designated-cron-runner pattern (env flag vs. a DB/Redis lock) before any multi-process deployment ships the existing scheduled jobs?

## Not tested / not done

- The brief's actual scale (50 companies / ~200k employees) — two tenants have now been seeded and measured (2,000 and 20,000 employees), still well short of 50 companies / 200k employees combined.
- k6 (only `autocannon` was used this pass too, now against 4 of the brief's 10 named routes, up from 2 — employee-list, auth/me, leave/config, leave/balance — plus the still-attempted attendance-sheet call that correctly 400's past 1,000 people).
- ~~pm2 cluster-mode comparison~~ — **done this pass** (see above); result was inconclusive about production behavior specifically because this sandbox's DB shim and vCPU count confound the comparison.
- Payroll-run-for-a-large-company timing (still not exercised against either seeded tenant).
- General request size limits, DB query timeouts.
- A demonstrated "heavy company can't slow others" test (no rate-limiting layer exists yet to test).
- Building the proposed job queue (plan only, in `docs/SCALING_PLAN.md`).
- Re-running the employee-list query-plan finding against real MongoDB to determine whether it's an application bug or a test-shim-only artifact — this is the single most important follow-up this pass surfaced.
- Anything requiring a real multi-node MongoDB cluster or a real network between hosts — this sandbox has neither, and no laptop/sandbox test can substitute for that; `docs/SCALING_PLAN.md`'s infra approximations are explicitly estimates, not measurements.
