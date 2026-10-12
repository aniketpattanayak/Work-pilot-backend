# Phase 3 — SuperAdmin Panel Report

Branch: `fix/superadmin-findings` (off `payroll-phase3-4`, carries all of `fix/e2e-findings`'s commits too since it was branched after Phase 2).
Test harness: `scripts/phase3-superadmin/test-superadmin.js`, run live against the local test server (port 5099) and local test Mongo (nosqldb, port 27018). **Never pointed at any real/production instance.**

## Scope actually covered this session

Given the overall project's size, Phase 3 this session focused on the API layer (`/api/superadmin/*` + `/api/tenants/master-login`), which is where the real authorization and data-correctness risk lives, rather than a full Playwright UI walk of `SuperAdmin.jsx`/`SuperAdminPanel`. See "Not tested" below for what a full Phase 3 pass would still need.

## Result: 56/56 automated checks pass (after 1 real bug fixed)

### Bug found and fixed

**`resetAdminPassword` was a silent no-op.** `PUT /api/superadmin/tenants/:tenantId/reset-password` hashed the new password and wrote it to `Tenant.password` — a field the actual employee-login code (`loginEmployee`) never reads. Employee login checks `Employee.password` on the tenant's Admin employee record instead. The endpoint always returned `200 "Admin password reset successfully"`, giving a superadmin (and anyone using this feature to help a locked-out customer) false confidence that the password had changed, while the real credential was completely untouched and the old password kept working indefinitely.

Fixed in commit `168c913` on `fix/superadmin-findings`: the handler now looks up the tenant's actual Admin `Employee` record (checking the tenant's own dedicated database first, for tenants on `customMongoUri`, exactly the same lookup pattern `loginEmployee` already uses — then falling back to the shared database) and updates that record's password hash. Verified live: after the fix, the admin can log in with the new password and can no longer log in with the old one.

### What was tested and passed (56 checks)

- **Superadmin login:** correct credentials succeed; wrong password and unknown username are both rejected with a generic message that doesn't reveal which field was wrong (no username/password-enumeration leak).
- **Every one of the 15 `/api/superadmin/*` routes** (`dashboard`, `tenants`, `tenants/:id`, `feed`, `pause`, `resume`, `limits`, `features`, `billing`, `note`, `reset-password`, `logs`, `process-schedules`, `custom-db`, `custom-whatsapp`) rejects both a completely unauthenticated request and a normal (non-superadmin) tenant-admin's valid token — confirmed with 30 live HTTP calls, 2 per route.
- **Cross-tenant isolation:** the tenant list correctly includes both freshly-created test tenants; a tenant-A detail fetch does not leak any tenant-B data in the response body.
- **Module/feature switches, limits, and plan/billing updates** all persist correctly and independently per tenant (updating tenant B's limits does not affect tenant A's).
- **Pause → resume lifecycle:** before pause, the tenant admin's token works normally; immediately after pause, that same (still otherwise-valid) token is rejected everywhere with `403 SUBSCRIPTION_PAUSED` via `subscriptionGuard`; after resume, it works again.
- **Admin password reset** (after the fix): old password stops working, new password works.
- **Activity log** fetch for a tenant succeeds for the superadmin.

### Known gaps re-confirmed live (already documented in `docs/PRODUCT_MAP.md`, not new bugs fixed this phase — listed under Decisions needed)

- A tenant can still **log in successfully while paused** — `loginEmployee` only checks the legacy `tenant.subscription.status` field, never `tenant.superAdmin.status`, which is the field pause/resume actually writes. The employee only discovers they're paused on their *next* API call. Confirmed live: `POST /tenants/login-employee` returns `200` for a paused tenant.
- **Chat has no `subscriptionGuard`** — a paused tenant can still send/receive chat messages. Confirmed live.
- **An invalid `plan` value on `PUT /billing` causes a 500**, not a 400 — an unhandled Mongoose enum `ValidationError` from `Billing.create`. Minor robustness gap (the real frontend only ever sends a valid lowercase value from a `<select>`, so this isn't user-reachable today, but a direct API caller or a future UI bug could hit it).

### Not applicable this session

- **Impersonation audit logging** — the brief asked to confirm impersonation is audit-logged and non-leaking. A full-codebase search (`grep -rn "impersonat"`) found **zero matches** anywhere in the backend: there is no impersonation feature at all (no route, no controller, no audit-log entry type for it). Recorded here as "doesn't exist" rather than silently skipped, so it isn't mistaken for a tested-and-passing feature.
- **Company CRUD** — create (`/api/tenants/create-company`) and read (`/api/superadmin/tenants[/:id]`) exist and were exercised; pause/resume exist and were exercised. **There is no delete-company route anywhere** — only pause/resume, not deletion. If "CRUD" is a hard requirement, delete is the missing piece.

### Minor oddity noted, not a live bug

`/tmp/wpf/src/pages/SuperAdminPanel.jsx` contains stray backend Node.js controller code (literally starts with `require('../models/Tenant')`, etc.) instead of a React component — this is checked into the frontend repo's `main` branch, predating this session's work. It is **not imported or referenced anywhere** (`grep -rn "SuperAdminPanel" src` shows it's only referenced as a function *name* defined inside the real, working `SuperAdmin.jsx`, which is what's actually used) — so it doesn't break the build or any live page. Worth deleting as dead/confusing debris, but intentionally not touched this session since it isn't wired into anything and removing files from the frontend wasn't asked for.

## What a full Phase 3 pass would still need (not done this session)

- A real-browser Playwright walk of the SuperAdmin UI (`SuperAdmin.jsx`) itself — desktop and 390px phone width, dark/light theme — covering company create/pause/resume/billing/features from the actual screens rather than only the API underneath them.
- Verifying what a suspended company's own UI (not just its API) shows a logged-in user mid-session.
- The same Phase 1 Section E data-safety checks (IDOR, oversized/malformed input, CSV injection) specifically against every superadmin route's own input fields (e.g. `customMongoUri`, `customWhatsappKey`, `note`) — this session's superadmin tests focused on authorization and correctness, not the full security sweep.
- Rate-limiting on `master-login` — confirmed (via the Phase 2 codebase-wide grep for `rate-limit`/`rateLimit`) that **no rate-limiting middleware exists anywhere in this codebase**, so `master-login` has no brute-force throttling. This is a real gap worth fixing platform-wide, but is a bigger change (needs a rate-limit store, likely Redis-backed for multi-process deployments) than this phase's scope — recorded as a "Decision needed" rather than patched with an ad hoc counter.

## Decisions needed

1. Should `loginEmployee` also check `tenant.superAdmin.status`, so a paused tenant is blocked at login instead of on the first subsequent API call?
2. Should `chatRoutes.js` get `subscriptionGuard` like every other tenant module?
3. Is a delete-company (not just pause) capability actually required for "company CRUD", or is pause/resume the intended permanent design?
4. Should `master-login` (and ideally all auth endpoints) get rate-limiting? If so, what store — in-memory (breaks under Phase 5's multi-process/cluster plan) or Redis?
5. Is the dead `src/pages/SuperAdminPanel.jsx` file (frontend repo) safe to delete, or was it intentionally left as a stub for a planned rewrite?
