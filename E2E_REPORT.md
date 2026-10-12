# Phase 1 - End-to-end test report (payroll-phase3-4)

**Scope note, read first:** the brief for this job (five phases: full E2E, product
documentation, SuperAdmin testing, a built AI assistant, and a load-tested scaling plan)
is, done properly, several weeks of engineering work. This session covered Phase 1's
highest-value pieces to real, verified completion rather than giving every requested
item a thin, unverified pass. What was actually run is below; what was not is listed
plainly at the end. Nothing here is fabricated - every PASS/FAIL number comes from a
script's real output, re-run and pasted, not from reading code.

Environment: local backend (port 5099) against a local in-memory Mongo-compatible test
DB (`127.0.0.1:27018/workpilot_test`), local frontend (port 5173). No production system
was touched. WhatsApp sends are hard-blocked at this sandbox's network egress proxy
(`public.doubletick.io` / `api.maytapi.com` both return `connect_rejected`), confirmed
before any seeding, so no real messages could leave regardless of code paths taken.

## Bug found and fixed this phase

**`joiningDate` was accepted nowhere.** `addEmployee` and `updateEmployee` never read a
`joiningDate` field from the request body, so every employee's tenure silently defaulted
to `createdAt` (the day the HR record was made) with no way to correct it short of
writing to the database directly. Both payroll (pro-ration) and leave (accrual) depend on
this date. Fixed on `fix/e2e-findings` (commit `2362459`): both controllers now accept,
validate (real calendar date, not in the future), and store `joiningDate`; the Add/Edit
Employee form has a matching field. Regression test: `scripts/test-joining-date-live.js`
(10/10 pass against the live local server).

## Section B: permission matrix (code-generated, run live)

Generated directly from `utils/permissions.js`'s `CATALOG`/`SCOPES` (not hand-written):
for every module.action key and every scope, a disposable custom role granting **only**
that key@scope was created, assigned to a disposable employee with every built-in role
stripped, and a representative real HTTP route gated by that exact key was called with a
real login token. Expected allow/deny was computed from the route's own `minScope`
(taken verbatim from `routes/taskRoutes.js`), so this exercises the live
`requirePermission` -> `can()` -> `effectivePermissions()` chain end to end, not a mock.

**Result: 89 checks, 84 pass / 5 fail.**

All 5 failures are the same root cause: **`attendance.export` ("Download registers") is
defined in the permission catalog but enforced nowhere.** `routes/taskRoutes.js` has no
route gated by `attendance.export` - the only attendance download route
(`GET /attendance/sheet?export=1`) is gated by `attendance.view`. So a role built to grant
*only* export access gets 403 (correctly denied, since it lacks `view`), while anyone
with `attendance.view` can already export regardless of whether they were ever granted
`attendance.export`. This is a real design gap, not a test artifact - confirmed by
grepping the whole `routes/` and `controllers/` tree for the string `attendance.export`
and finding it used only inside the permission catalog itself.

This is listed under **Decisions needed** below rather than fixed, because the correct
fix depends on a product choice: either (a) gate the export query param with its own
`requirePermission('attendance.export')` check (making it a strictly narrower grant than
view), or (b) remove `attendance.export` from the catalog since view already covers it.
Guessing wrong here would change who can download data in production.

Other matrix checks covered and passing:
- Widest-scope-wins: two roles granting the same key at `self` and `company` scope -> the
  wider (`company`) scope applies.
- Live role change: removing the wider role mid-session narrows access on the very next
  request, with no re-login needed (`loadPermissions` reads from the DB, not the JWT).
- Negative control: a person with zero roles (roles explicitly set to `[]`, since
  `addEmployee` defaults an empty array to built-in `Doer` by design) is denied every
  representative route (403).
- Cross-tenant: an Admin token from a different company cannot fetch this tenant's
  employee salary by id (403/404).
- Deactivation: deleting an employee invalidates their still-unexpired JWT on the very
  next request.

Scripts: `scratchpad/perm-matrix.js` (generator + live runner),
`scratchpad/results-perm-matrix.json` (raw results).

## What else from the Phase 1 brief was planned but not run this session

Given the size of the remaining ask relative to what one session can verify honestly,
these were **not executed**, not "passed by reading code":

- **Section A** (full hire-to-exit lifecycle walk with the 25-person realistic company,
  branches/departments/mid-month joiner/leaver/notice-period person) - not seeded. The
  joining-date fix and permission matrix above used small throwaway tenants created
  per-test, not the full realistic company described in the brief.
- **Section C** (cross-module consistency: late leave approval after payroll draft,
  regularization after run approval, mid-month branch transfer, concurrent edits, etc.) -
  not run this session. A closely related check (two simultaneous approve calls racing
  on the same run) was verified in the *prior* payroll-only test round
  (`PAYROLL_LIVE_TEST_REPORT.md`) and is not repeated here.
- **Section D** (every Settings/module on-off combination) - not run.
- **Section E** (IDOR fuzzing, oversized/malformed input, formula-injection CSV cells,
  unicode names) across every id-taking route - not run, beyond the cross-tenant checks
  folded into the permission matrix above.
- **Section F** (200-person scale seed + timing + query counts) - not run.
- **Section G** (browser walk per role, phone width, dark/light, double-click guard) -
  not run this session. (A prior, narrower Playwright pass exists from the earlier
  payroll-only testing round and is not repeated here.)
- `joiningDate` fix: the **frontend form change was written but not exercised in a real
  browser** this session - only the backend API was tested live. Call this *not verified
  end to end* rather than passed.

## Decisions needed

1. **`attendance.export`**: should it be enforced as its own permission distinct from
   `attendance.view` (narrower grant possible), or removed from the catalog since view
   already covers every export path today? Either is a legitimate product choice; I did
   not guess.

## Not tested / not done (honest summary)

Sections A, C, D, E, F, G of the Phase 1 brief as written; Phase 2 (`PRODUCT_MAP.md`),
Phase 3 (SuperAdmin), Phase 4 (AI assistant), and Phase 5 (scale readiness) were not
started this session. See the final chat summary for why and what a realistic next step
looks like.
