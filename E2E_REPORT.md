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

## Section E: security (IDOR + injection, partial)

Real HTTP checks between two freshly created tenants, admin tokens only:

| # | Check | Result |
|---|---|---|
| 1 | Create employee with `<script>alert(1)</script>` as the name | 201 - stored as-is server-side (correct: HTML-escaping is the renderer's job; React escapes by default, and this backend never uses `dangerouslySetInnerHTML` on employee names in the files reviewed for the CSV export below) |
| 2 | Create employee with a unicode name (`Ünïcödé Nâme 名前 🎉`) | 201 - stored and round-tripped correctly |
| 3 | Tenant B's admin requests tenant A's employee list by tenant A's id | 403 |
| 4 | Tenant B's admin tries to UPDATE a tenant A employee by id | 403 |
| 5 | Tenant B's admin tries to DELETE a tenant A employee by id | 403 |
| 6 | Malformed (non-ObjectId) id on an update route | 400, handled cleanly (no 500/crash) |
| 7 | 5,000-character id string on a GET route | 403, handled cleanly |
| 8 | Create employee with a formula-looking name (`=1+1`) | 201 - stored as typed |

All 8 pass. One of these (#8) led to checking the CSV export path specifically for
formula injection (a name like `=1+1` or `=cmd|...` opened in Excel can execute): read
`utils/payrollEngine.js`'s `csv()`/`csvCell()` helper (used by every payroll CSV export -
register, bank file) and confirmed any cell starting with `=`, `+`, `-`, `@` or a tab is
quoted and prefixed with a literal `'`, which neutralizes it in Excel/Sheets. This is a
code read, not a live export-and-reopen-in-Excel test, so it's marked as *code-verified*
rather than fully end-to-end.

This is a small slice of Section E (8 checks across 2 of the many id-taking routes), not
the full sweep across every route the brief asks for.

## Section F: scale check at 200 people (seeded directly into the DB, not via API)

200 employees + 200 salary structures + 10,400 punches (a full September 2026, weekdays
only) were bulk-inserted directly into the test DB with `insertMany` (bypassing the HTTP
API entirely, as instructed), then four real HTTP routes were timed against the running
local server:

| Route | Time | Notes |
|---|---|---|
| `GET /tasks/employees/:tenantId` (200-person list) | 90ms | |
| `GET /tasks/attendance/sheet?month=2026-09` (200 people x 26 working days) | 733ms | Slowest of the four. Worth a closer look if real companies this size report the dashboard feeling slow, though 733ms for a single admin-facing call isn't alarming on its own. |
| `GET /tasks/payroll/salaries` (200 people) | 46ms | |
| `POST /tasks/payroll/runs` (create a run for 200 people) | 976ms | |

**Honest correction on methodology:** the brief asks for a database query count per route.
My first attempt hooked `mongoose.set('debug', ...)` in the *test script's own* Node
process, which has its own separate connection from the running backend server process -
so it only ever saw its own seeding queries, not the server's. It reported "0 queries" for
every HTTP call, which is wrong, not good news, and I'm flagging it rather than letting a
clean-looking zero stand. **Query counts per route were not actually captured this
session.** Getting a real count needs either `mongoose.set('debug')` inside the server
process itself (restart with an env flag) or the Mongo profiler - both doable, just not
done here. The wall-clock timings above are real and were not affected by this mistake.

This is one scale point (200 people, one month of attendance, a single sequential run of
each route) - not the full Section F ask (query-count profiling, finding and fixing the
cause of anything slow, re-running after each fix).

## Section A + C: full lifecycle and cross-module consistency (28 checks, all pass)

`scripts/e2e-phase1/scenario-a-c.js`. Built one realistic 26-person company (2 locations
- Mumbai HQ / Pune Branch; 3 departments - Ops/Sales/Finance; an HR Head, an HR Exec, a
Finance person, 3 managers, 3 department heads, 14 regular employees, a mid-month
joiner, a leaver, and a notice-period person) and ran it through the real API:

**Section A (lifecycle)**: custom "Payroll Preparer" and "Payroll Approver" roles
created and assigned to two *different* people (Finance and HR Head); salary structures
set for everyone; leave applied and approved; a September 2026 payroll run prepared by
Finance, approved and released by HR Head; an account (the leaver) deleted after their
payslip had already been released; the deleted leaver confirmed unable to log in again.

**Section C (cross-module consistency)**, each as its own live check:
- A late attendance regularization filed for a past date **after** the run covering
  that month is already Approved - allowed, and does **not** silently recalculate the
  already-approved run (its status and numbers are unaffected).
- A holiday added to the calendar **after** attendance already exists for that date -
  allowed, does not error.
- An employee transferred to the other location mid-month - allowed.
- The Payroll Preparer role **removed from Finance after they already created a run**:
  the existing run stays fully valid and readable, but Finance can no longer create a
  *new* run - confirms permissions are re-checked live on every request, not cached from
  when the run was created.
- A salary change made **after** that employee's run is already Released - does not
  retroactively change the released run's already-paid numbers.
- The mid-month joiner (joined 2026-09-16, given attendance punches only after their
  join date) is paid **less** than a full-month employee with the identical salary and a
  full month of attendance - confirms pro-ration is really happening, not just that a
  number exists.
- Deleting an employee with an already-released payslip does not affect that payslip's
  retrievability for someone with `payroll.viewSalary` - confirmed by reading
  `PayrollRun.lines`, which snapshots `name`/`department` inline rather than depending on
  the live `Employee` document still existing.
- **"Notice period" / notice pay**: confirmed (by reading `payrollController.js` and the
  `Employee` model) that no such concept exists anywhere in the codebase - a person "on
  notice" is just a normal active employee with no special handling. This is one of the
  gaps the brief named as known and explicitly asked to be listed, not built.

No new bugs were found in this pass.

## Section D: module on/off combinations (all 8, live)

All 8 combinations of attendance/leave/payroll on-off were set via the real superadmin
API and checked against a live route per module. **27/32 checks pass; the other 5 are one
correct, deliberate product rule, not a bug:** `setModules` refuses to turn payroll on
unless attendance AND leave are turned on in the *same* call (`"Payroll needs Attendance
and Leave to be on first."`, HTTP 400), and when it refuses, it changes nothing -
confirmed atomic, no partial activation. My first test script wrongly treated the 3
module flags as independent and expected attendance/leave to switch on even when bundled
with a rejected payroll=true in the same request; once I accounted for the dependency
rule, all 5 "failures" are exactly that one rule firing as designed. The remaining 5
genuinely independent combinations (every combination that doesn't try to turn payroll on
without its prerequisites) all behave correctly: the view route for an off module is
refused (403) and for an on module is allowed (200), with no crashes either way.

This covers all 8 combinations as asked, but only one view route per module, not every
route in that module, and not the UI-hides-the-menu-item half of the requirement (only
that the API refuses it was checked).

## Section G: browser walk (partial, real browser + screenshots)

A fresh throwaway tenant was seeded (HR, Finance, and a plain employee role, salary set,
payroll module on) and walked with a real headless Chromium:

| # | Check | Result |
|---|---|---|
| 1 | HR, desktop (1440px), light theme: reach the Payroll page | Reached, no console/page errors |
| 2 | HR, phone width (390px): dashboard loads | No console/page errors |
| 3 | HR, phone width (390px): Payroll reachable via the nav/hamburger | **Inconclusive** - see correction below |
| 4 | Finance, desktop, **dark theme**: reach the Payroll page | Reached cleanly |
| 5 | Rahul (plain employee, no custom payroll role): what does the "Payroll" nav item do? | Leads to "My Payslips" (his own, empty since none released yet) - **no 4xx, no admin data, no crash**. My first pass scored this a FAIL on a wrong assumption ("he shouldn't see a Payroll link at all"); the real, correct behavior (already established in this session's permission-matrix testing) is that the Payroll module surfaces a self-service payslip view to everyone once the module is on, independent of having an admin payroll role - this is not a security issue, just a shared nav label. |
| 6 | Double-click guard on the create-run button | **Not meaningfully tested** - the heuristic button selector didn't match the real UI, so this did not run. The stronger version of this check (two simultaneous `approve` calls at the API level, exactly one succeeds) was already verified live in the prior payroll-only testing round. |

**Honest correction:** check #3's pass condition (`!page.url().includes('/login')`) is true
after any successful login regardless of whether the Payroll nav click actually worked -
it does not prove the hamburger menu was found or that Payroll was reached on phone
width. Screenshot `03-hr-phone-payroll.png` shows the actual resulting screen for manual
review; the test's own PASS verdict for that one line should not be trusted as written.

Not done: walking every key role (not just HR/Finance/plain employee), checking **light**
theme on top of dark (only dark was exercised for Finance), and a trustworthy double-click
check against the real Save/Approve/Release buttons by their actual selectors.

## What else from the Phase 1 brief was planned but not run this session

Given the size of the remaining ask relative to what one session can verify honestly,
these were **not executed**, not "passed by reading code":

- **Sections A and C are now done** (see the new section above, 28/28 checks) - the
  realistic 26-person company, full lifecycle, and the named cross-module consistency
  cases were all run live in a later pass this session. One Section C item from the
  brief's own list was **not** separately re-verified here: "concurrent edits" - a
  closely related check (two simultaneous approve calls racing on the same run) was
  verified in the *prior* payroll-only test round (`PAYROLL_LIVE_TEST_REPORT.md`) and
  is not repeated in this script.
- **Section D** - all 8 module combinations done at the API level only (see above); the
  "disappears from the menu" half of the requirement was not checked in the UI.
- **Section E** - only a small slice run (8 checks, see above): cross-tenant IDOR on
  employee update/delete, a malformed id, an oversized id, an HTML-ish name, a unicode
  name, and a formula-looking name, plus a code read confirming CSV formula-injection
  guarding. The full ask (fuzzing every id-taking route, oversized/malformed payloads on
  every write endpoint, exports actually re-opened in Excel) was not done.
- **Section F** - only a single scale point run (see above): 200 people, one month of
  attendance, four routes timed once each, no query-count profiling, no root-causing or
  fixing of the slowest route, no re-run after a fix.
- **Section G** - a partial, real-browser pass done (see above: 3 roles, phone width,
  dark theme, one inconclusive check honestly flagged). Not done: every key role, light
  theme side-by-side with dark, and a trustworthy double-click test against the real
  buttons.
- `joiningDate` fix: the **frontend form change was written but not exercised in a real
  browser** this session - only the backend API was tested live. Call this *not verified
  end to end* rather than passed.

## Decisions needed

1. **`attendance.export`**: should it be enforced as its own permission distinct from
   `attendance.view` (narrower grant possible), or removed from the catalog since view
   already covers every export path today? Either is a legitimate product choice; I did
   not guess.

## Not tested / not done (honest summary)

Sections A and C are now done (above). Sections D, E, F, G remain the partial slices
described above, not the full scope. "Concurrent edits" specifically (one named item
under Section C) was not re-verified this session beyond the prior round's single
race-condition check. Phases 2-5 are covered in their own reports
(`docs/PRODUCT_MAP.md`, `SUPERADMIN_REPORT.md`, `AI_ASSISTANT_REPORT.md`,
`SCALE_REPORT.md`), each with its own honest "not done" list.
