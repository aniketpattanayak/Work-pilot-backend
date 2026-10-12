# WorkPilot — Product Map

*Researched directly from `/tmp/wpb` (backend) and `/tmp/wpf` (frontend) on 2026-10-12. All paths are repo-relative to `/tmp/wpb` unless noted.*

## How routing is wired

`index.js` mounts:

| Mount prefix | Router file |
|---|---|
| `/api/tenants` | `routes/tenantRoutes.js` |
| `/api/fms` | `routes/fmsRoutes.js` (legacy FMS) |
| `/api/fms2` | `routes/newFmsRoutes.js` **and** `routes/orderFormRoutes.js` (both mounted on the same prefix) |
| `/api/chat` | `routes/chatRoutes.js` |
| `/api/superadmin` | `routes/superAdminRoutes.js` |
| `/api/tickets` | `routes/ticketRoutes.js` |
| `/api/reports` | `routes/reportRoutes.js` |
| `/api/tasks` | `routes/taskRoutes.js` |

Common middleware chain: `authMiddleware` (JWT) → `subscriptionGuard` (blocks paused tenants) → `tenantDbMiddleware` (switches to a tenant's dedicated Mongo URI if configured) → `sameTenantOnly` (IDOR guard) → `requirePermission`/`requireAnyPermission` (fine-grained RBAC, HR modules only) or ad-hoc role checks.

The permission **CATALOG** (`utils/permissions.js`) only defines four modules: `access`, `attendance`, `leave`, `payroll`. Tasks, Checklist, FMS, Chat, Tickets, Orders, Reports, Rewards have **no catalog entries** — they are gated only by `Employee.roles` (`Admin/Assigner/Doer/Coordinator/Viewer`) checked ad-hoc in controllers/middleware, or not gated at all beyond "logged in to this tenant."

---

## 1. Tasks (Delegation)

**Purpose:** One-off work delegated from an Assigner to a Doer (optionally via a Coordinator and an onward-forwarding chain), tracked to completion with revision requests, evidence uploads, and a points/badges engine.

**Routes:** Implemented once in `controllers/taskController.js` but exposed through **two separate routers** mounted at different prefixes:
- `/api/tasks/*` (`routes/taskRoutes.js`) — the router the frontend actually uses.
- `/api/tenants/*` (`routes/tenantRoutes.js`) — a near-duplicate mount, used only by `SuperAdmin.jsx` for `master-login`/`create-company`.

Key paths (via `/api/tasks`): `POST /create-task`, `PUT /respond`, `PUT /handle-revision`, `POST /assign-onward`, `DELETE /:taskId`, `PUT /:taskId`, `GET /doer/:doerId`, `GET /assigner/:assignerId`, `GET /coordinator/:coordinatorId`, `POST /coordinator-force-done`, `GET /employee-score/:employeeId`, `GET /employee-deep-dive/:employeeId`, `GET /global-performance/:tenantId`, `GET /user-dashboard/:employeeId`, `PUT /update-weekly-target`, `POST /send-whatsapp-reminder`.

**Permissions/middleware:** `authMiddleware, subscriptionGuard, tenantDbMiddleware` only. No permission-catalog key and **no role check** — any authenticated employee of the tenant can create/assign/delete/edit any task (e.g. there's nothing stopping a `Doer` from hitting `POST /create-task` directly). Role gating (`Admin`/`Assigner` can see "Manage Tasks") is enforced only in the frontend `Sidebar.jsx`.

**Screens:** `ManageTasks.jsx`, `CreateTask.jsx`, `Dashboard.jsx`, `UserDashboard.jsx`, `CoordinatorDashboard.jsx`, `RevisionPanel.jsx`, `TaskCard.jsx`, `GlobalView.jsx` (review analytics), `ScoreBadge.jsx`.

**Cross-module connections:**
- Leave: `leaveController.decideRequest` → `syncLeaveStatus` sets `Employee.leaveStatus` (onLeave/buddyId), which the task-reassignment/buddy-substitution logic in `taskController` reads.
- Rewards: completing/verifying a task inside `respondToTask` runs the points/badge engine against `Tenant.pointSettings`/`badgeLibrary` and writes to `Employee.totalPoints`/`earnedBadges` — i.e. "Rewards" has no dedicated controller, it's embedded in Tasks.
- Review Meeting / Reports: `getReviewAnalytics` and `reportController.generateDetailedReport` read `DelegationTask` + `ChecklistTask` (+ `FlowInstance` for review analytics) directly.
- Chat: `getOrCreateTaskThread` links a chat conversation to a `DelegationTask` id.
- WhatsApp: task creation/response fires templated notifications via `utils/notify.js`.

---

## 2. Attendance

**Purpose:** Shift-based punch in/out with geofencing and optional face-match, regularization requests, manager review of flagged punches, and shift/site configuration.

**Routes:** All under `/api/tasks/attendance/*` (`taskRoutes.js`), backed by `controllers/attendanceController.js`. Examples: `POST /punch`, `GET /today`, `GET /my`, `GET /sheet`, `GET /live`, `POST /regularizations`, `PUT /regularizations/:id/decision`, `GET /review`, `PUT /punches/:id/review`, `POST /manual`, `POST /shifts`, `POST /sites`, `PUT /assignments/:employeeId`, `POST /face/enrol`, `PUT /face/:employeeId/decision`.

**Permission keys:** `attendance.view`, `attendance.punch`, `attendance.edit`, `attendance.approve`, `attendance.export`, `attendance.configure` (unscoped). Requires `requirePermission`/`requireAnyPermission` on every route. **Known gap (Phase 1 finding): `attendance.export` is defined in the catalog but enforced nowhere in the codebase** — no route gates on it.

**Screens:** `AttendancePage.jsx`, `AttendanceSetup.jsx`, `FaceCaptureModal.jsx`.

**Cross-module connections:**
- Payroll reads Attendance via `utils/attendanceEngine.js` (`AE`) and `controllers/attendanceController.js` (`att`) inside `payrollController.buildLines` to compute worked/LOP days.
- Entirely gated behind `Tenant.hrModules.attendance` (off by default for every company).

---

## 3. Leave

**Purpose:** Leave-type configuration, balance tracking/accrual, applying for leave, approval workflow, manual balance adjustments, and a leave calendar.

**Routes:** `/api/tasks/leave/*`, backed by `controllers/leaveController.js`: `GET/POST /types`, `GET/PUT /config`, `GET /balance`, `POST /requests`, `GET /requests`, `PUT /requests/:id/decision`, `PUT /requests/:id/cancel`, `POST /adjust`, `GET /calendar`, `GET /people`, `PUT /employees/:id/joining-date`.

**Permission keys:** `leave.view`, `leave.apply`, `leave.approve`, `leave.adjust`, `leave.configure` (unscoped).

**Screens:** `LeavePage.jsx`, `LeaveSetup.jsx`.

**Cross-module connections:**
- Approving leave (`decideRequest`) syncs `Employee.leaveStatus` → feeds Tasks' buddy-substitution logic.
- Payroll reads **approved + paid** `LeaveRequest` rows directly (`payrollController.js` line 219) to exclude paid-leave days from LOP.
- Gated behind `Tenant.hrModules.leave`.

---

## 4. Payroll

**Purpose:** Salary structures, tax declarations, and the monthly payroll run lifecycle (Draft → Approved → Released), including statutory (PF/ESI/PT) and TDS computation and payslip/CSV export.

**Routes:** `/api/tasks/payroll/*`, backed by `controllers/payrollController.js`: `GET/PUT /config`, `GET /salaries`, `PUT /salaries/:employeeId`, `GET/PUT /declarations/:employeeId`, `POST /runs` (create/prepare), `POST /runs/:id/recalculate`, `PUT /runs/:id/lines/:employeeId`, `PUT /runs/:id/approve`, `PUT /runs/:id/reopen`, `PUT /runs/:id/release`, `GET /runs/:id/export`, `GET /my-payslips`, `GET /payslip/:runId/:employeeId`.

**Permission keys:** `payroll.viewSalary`, `payroll.prepare`, `payroll.approve`, `payroll.release`, `payroll.export`, `payroll.configure`. This module is marked `sensitive: true` in the catalog — **Admin gets none of these automatically**; they must be explicitly granted via a custom role. `approve`/`release`/`configure` require `company`-level scope on several routes (`requirePermission('payroll.prepare','company')`, etc.), and self-approval of a run one prepared is blocked unless `payrollConfig.allowSelfApproval` or the approver also holds `payroll.configure` at company scope.

**Screens:** `PayrollPage.jsx`, `PayrollSetup.jsx`, `PayrollSalaries.jsx`, `PayrollRuns.jsx`, `PayrollReview.jsx`, `PayslipModal.jsx`.

**Cross-module connections:** Directly reads `attendanceEngine`/`attendanceController` (worked days) and `LeaveRequest` (paid leave) to build each run's lines (`buildLines`); uses `statutoryEngine.js`/`tdsEngine.js` for PF/ESI/PT/TDS. `accessController.setModules` enforces a hard dependency: **Payroll cannot be switched on unless Attendance and Leave are already on.**

**Known fix this session:** `addEmployee`/`updateEmployee` previously had no way to set `joiningDate` via the API (and the Add/Edit Employee form had no field for it) — relevant to payroll pro-ration for mid-month joiners. Fixed in `controllers/tenantController.js` (commit `2362459`) with validation (must not be a future date) and a corresponding frontend field in `AddEmployee.jsx` (local commit `985123e`, not yet pushed — see "Decisions needed" in `E2E_REPORT.md`).

---

## 5. Employees / Mapping

**Purpose:** Onboarding and managing employee records (roles, department, manager/coordinator relationships) and the "who reports to whom" mapping used by Tasks/Attendance/Payroll reach calculations.

**Routes:** `/api/tasks/employees`, `/api/tasks/employees/:tenantId`, `POST /add-employee`, `POST /bulk-employees`, `PUT /employees/:id`, `DELETE /employees/:id`, `PUT /update-mapping`, `PUT /assign-coordinator`, `GET /mapping-overview/:tenantId` (`tenantController.js`/`taskController.js`). Duplicated again under `/api/tenants/*`.

**Permission/middleware:** `adminOfSameCompany` — hard-coded check that `req.user.roles` includes `'Admin'` (not the permission catalog). No fine-grained scoping; it's all-or-nothing per tenant.

**Required fields (add employee):** `tenantId, name, email, department, whatsappNumber, roles[], password`; `joiningDate` optional but validated not-in-future.

**Screens:** `AddEmployee.jsx`, `RegisteredEmployees.jsx`, `EmployeeTable.jsx`, `CoordinatorMapping.jsx`, `BulkUpload.jsx`.

**Cross-module connections:** `managedDoers`/`managedAssigners` on `Employee` drive the `team` scope in `effectivePermissions`/`reachIds` for Attendance/Leave/Payroll; `accessRoleKeys` on `Employee` is the join to the Roles & Access module.

---

## 6. Roles & Access (RBAC)

**Purpose:** Lets a tenant Admin define custom roles (named sets of `module.action` + scope permissions from the CATALOG) and assign them to employees, on top of the fixed `Employee.roles` enum.

**Routes:** `/api/tasks/access/*` (`accessController.js`): `GET /catalog` (public-to-tenant), `GET /me`, `GET/POST/PUT/DELETE /roles`, `PUT /assign`, `PUT /modules/:tenantId` (`superAdminOnly` — turns `hrModules.attendance/leave/payroll` on/off).

**Permission key:** `access.manage` (unscoped, company-wide only) gates create/update/delete/assign-roles; `sensitive: false` so Admin gets it automatically (`BUILTIN.Admin` grants every non-sensitive key at `company` scope).

**Required fields:** createRole `{name (2-40 chars), description(<=200), permissions:[{key,scope}]}` (max 100 permissions, max 50 roles/tenant); assignRoles `{employeeId, roleKeys[]}` (max 5 roles/person).

**Screens:** `AccessRolesPanel.jsx`.

**Cross-module connections:** This is the engine behind every `requirePermission` check in Attendance/Leave/Payroll. `middleware/permission.js` caches `Tenant.accessRoles`/`hrModules` for 30s per tenant and recomputes `effectivePermissions()` from `Employee.roles` (builtin) + `Employee.accessRoleKeys` (custom) on every request.

---

## 7. Settings / Modules

**Purpose:** Company-wide configuration: office hours/weekends/holidays, branding (logo), sectors/locations lists, review-meeting weights/thresholds, point-system brackets/badges, report email schedule — plus the two independent "turn a feature on/off" systems described below.

**Routes:** `PUT /api/tasks/update-settings`, `PUT /api/tasks/update-branding`, `GET /api/tasks/settings/:tenantId` (`tenantController.updateSettings`/`updateBranding`); `GET/POST /api/reports/settings...`.

**Permission/middleware:** `authMiddleware, subscriptionGuard` only (no role/permission check on `update-settings`/`update-branding` — **any logged-in employee of the tenant can change company-wide settings**, not just Admins).

**Screens:** `Settings.jsx`.

**Two separate module-toggle systems (notable duplication — see Risks):**
1. `Tenant.hrModules.{attendance,leave,payroll}` — toggled by `accessController.setModules` (`superAdminOnly`), read by `middleware/permission.js` to zero out permissions for an off module, and by `Sidebar.jsx` via `hrKey`.
2. `Tenant.superAdmin.features.{tasks,checklist,fms,chat,whatsapp,tracking,reviewMeeting,employees,mapping,orderForms,newOrder,reports,rewards,settings}` — toggled by `superAdminController.updateFeatures` (`/api/superadmin/tenants/:tenantId/features`), read **only by the frontend Sidebar** (`featureKey`) to hide nav items. No backend route enforces these flags — confirmed directly in Phase 1 Section D of `E2E_REPORT.md`.

---

## 8. Chat

**Purpose:** Real-time 1:1 DMs, task-linked threads, and company-wide announcements, with file attachments and read receipts; messages auto-expire after 30 days.

**Routes:** `/api/chat/*` (`chatRoutes.js` → `chatController.js`): `GET /conversations`, `POST /dm`, `POST /task-thread`, `POST /announcement`, `GET /:conversationId/messages`, `POST /:conversationId/messages`, `POST /:conversationId/read`, `DELETE /:conversationId`, `POST /upload`.

**Permission/middleware:** `authMiddleware, tenantDbMiddleware` — **no `subscriptionGuard`** (unlike every other module's router), meaning a paused tenant can still use chat.

**Screens:** `ChatPage.jsx`, `FloatingChat.jsx`, `components/useChat.js`.

**Cross-module connections:** `Conversation.taskId`/`taskType` links to `DelegationTask` or `FlowInstance`; real-time delivery via `utils/socketHandler.js` (there is also a stale `socketHandler.js.bak` and `chatController.js.bak`/`chatRoutes.js.bak` in the repo).

---

## 9. Order Forms / New Order

**Purpose:** Lets non-technical staff submit structured orders (header + line items) through an admin-designed form instead of a Google Sheet; each submitted line item spawns a FlowInstance in the **new** FMS2 engine.

**Routes:** `/api/fms2/forms*`, `/api/fms2/submissions*` (`orderFormRoutes.js` → `orderFormController.js`): `POST /forms` (upsert), `GET /forms/:tenantId`, `GET /forms/template/:templateId`, `DELETE /forms/:formId`, `POST /forms/submit`, `GET /submissions/:tenantId`, `GET /submissions/detail/:submissionId`.

**Permission/middleware:** `authMiddleware, subscriptionGuard` only — **no `tenantDbMiddleware`**, so tenants with a dedicated Mongo URI have their Order Forms/Submissions always written to the shared DB, inconsistent with FMS2/Tasks/Leave/Attendance/Payroll which all use `tenantDbMiddleware`. No role/permission check either (any logged-in employee can design/delete a form).

**Screens:** `OrderFormsPage.jsx`, `NewOrderPage.jsx`, `FlowFormTab.jsx`, `DataSourceWizard.jsx`.

**Cross-module connections:** `OrderForm.templateId` and `OrderSubmission.templateId` link to `FlowTemplate` (FMS2); each `OrderSubmission.lineItems[].instanceId` points to the `FlowInstance` it spawned.

---

## 10. Flow Management — Legacy FMS (`/api/fms`) and FMS2 (`/api/fms2`)

Two parallel, independently-modeled flow engines coexist in production.

### Legacy FMS (`routes/fmsRoutes.js` + `controllers/fmsController.js`)
**Purpose:** Google-Sheet-triggered multi-step process tracking (`FmsTemplate`/`FmsInstance`/`FmsHistory`/`FmsSheetData`), still actively used by `FmsDashboard.jsx`.
**Routes:** `POST /create-template`, `GET /templates/:tenantId`, `DELETE /template/:templateId`, `POST /start-flow`, `PUT /execute-step/:instanceId`, `GET /instances/:tenantId`, `GET /sync/:templateId`, `GET /history/flow/:templateId`, `GET /history/:instanceId`, `GET /my-missions/:email`.
**Permission/middleware:** `authMiddleware, subscriptionGuard` + `sameTenantOnly` on tenant-list routes only. **No `tenantDbMiddleware` anywhere in this router** — legacy FMS data for custom-DB tenants always lands in the shared DB, unlike every other module. `FmsHistory` has **no `tenantId` field at all**; tenant ownership for history routes is reconstructed by looking up the parent `FmsInstance`/`FmsTemplate`.

**Fixed this session (security bug found during this research pass, commit `c15db7c` on `fix/e2e-findings`):** `GET /history/flow/:templateId` and `GET /history/:instanceId` previously had **no `authMiddleware` at all** — unlike every sibling route in the file — and the controller did no tenant check either, so anyone (logged in or not, from any company) could read another tenant's flow/instance history by guessing an id. Fixed by adding `authMiddleware, subscriptionGuard` to both routes and having both controller functions verify the owning `FmsInstance`/`FmsTemplate`'s `tenantId` matches `req.user.tenantId` before querying `FmsHistory`, returning 404 on mismatch. Regression test `scripts/test-fms-history-auth.js` (5/5 pass): unauthenticated → 401/403; a different tenant's valid token → 404; the owning tenant's own token → 200.

### FMS2 (`routes/newFmsRoutes.js` + `controllers/newFmsController.js`)
**Purpose:** Visual flow-builder engine (`FlowTemplate`/`FlowInstance` with typed nodes: action/yesno/input/start/end, per-node deadline modes, input fields, Sheet- or Form-sourced data) that replaces legacy FMS; used by `FlowBuilder.jsx`/`FlowMonitor.jsx`/`FlowMyTasks.jsx`.
**Routes:** `POST /templates`, `GET /templates/:tenantId`, `PUT/DELETE /templates/:templateId`, `GET /sheet-columns/:templateId`, `POST /push-sync` (no auth — `templateId` is treated as a shared secret for the Apps-Script webhook), `POST /manual-sync/:templateId`, `POST /complete-step/:instanceId`, `GET /instances/:tenantId`, `GET /monitor-stats/:tenantId`, `DELETE /instance/:instanceId`, `GET /my-tasks/:employeeId`, `GET /my-tasks-full/:employeeId`, plus **unguarded-by-`subscriptionGuard`/`tenantDbMiddleware` admin-repair endpoints**: `POST /repair-assignees/:tenantId`, `POST /fix-assignees/:tenantId`, `POST /instance/:instanceId/reassign` (only `authMiddleware`).
**Permission/middleware:** `authMiddleware, subscriptionGuard, tenantDbMiddleware` on normal routes; step completion is authorized by `completeStep`'s own logic (assignee, Admin/SuperAdmin, or the assignee's coordinator).

**Screens:** `FmsDashboard.jsx` (legacy), `FlowBuilder.jsx`, `FlowMonitor.jsx`, `FlowMyTasks.jsx`, `FlowManagement.jsx`, `DataSourceWizard.jsx` (FMS2).

**Cross-module connections:** FMS2 `FlowInstance` feeds Review Meeting (`getReviewAnalytics`) and Chat (task-threads can reference a flow instance); legacy FMS feeds only its own dashboard and WhatsApp notifications (`fmsNotifier.js` is written for FMS2's `FlowInstance`, not legacy `FmsInstance`).

---

## 11. Review Meeting

**Purpose:** A dense, period-based (Daily/Weekly/TwiceMonthly/Monthly/Quarterly, or custom range) scorecard per employee combining on-time % across Delegation Tasks, Checklists, and FMS2 flow steps, with configurable weights/thresholds/drift bands, used in actual review meetings. Admins get edit controls (late-target, delete); Viewer-only accounts get the same screen read-only.

**Routes:** `GET /api/tasks/review-analytics/:tenantId`, `PUT /api/tasks/update-weekly-target`, `GET /api/tasks/employee-deep-dive/:employeeId` (all `taskController.js`).

**Permission/middleware:** `authMiddleware, subscriptionGuard, tenantDbMiddleware` only; the frontend (`ReviewMeeting.jsx`) itself gates on `user.roles.includes('Admin')` or Viewer — **not enforced server-side**, so any authenticated non-Admin employee could still call these endpoints directly.

**Screens:** `ReviewMeeting.jsx` (wraps `GlobalView.jsx` with `mode='review'`), `GlobalView.jsx` (also used stand-alone for the Viewer role), `ScoreBadge.jsx`.

**Cross-module connections:** Reads `DelegationTask`, `ChecklistTask`, `FlowInstance` (FMS2 — **not** legacy FMS) and `Tenant.reviewConfig`.

---

## 12. Rewards

**Purpose:** Points-and-badges gamification layer: configurable duration "brackets" award/penalize points for early/late task completion, badges unlock at point thresholds, and an assigner gets a 10% kickback when their doer earns points.

**Routes:** No dedicated controller/routes. Logic lives inside `taskController.respondToTask` (awards points on `Completed`/`Verified`) and is driven entirely by `Tenant.pointSettings`/`badgeLibrary`. The "Rewards Log" screen reads plain task lists: `GET /api/tasks/doer/:id`, `GET /api/tasks/assigner/:id`.

**Permission/middleware:** Whatever gates Tasks (effectively none beyond login) — there is no separate Rewards permission.

**Screens:** `RewardsLog.jsx`, badge/point display in `Sidebar.jsx` and `ScoreBadge.jsx`.

**Cross-module connections:** Writes `Employee.totalPoints`/`earnedBadges`; reads `Tenant.pointSettings`/`badgeLibrary` configured via Settings.

---

## 13. Tickets

**Purpose:** Internal support-ticket system for employees to report issues (with media) and for SuperAdmin to resolve them with proof.

**Routes:** `/api/tickets/*` (`ticketRoutes.js` → `ticketController.js`): `POST /create`, `GET /all` (**SuperAdmin only — no tenant Admin view of their own company's tickets exists anywhere**), `GET /user/:reporterId`, `PUT /resolve` (SuperAdmin only), `PUT/DELETE /:ticketId`.

**Permission/middleware:** `authMiddleware` + either `subscriptionGuard` or `superAdminOnly` depending on route. Note: a Viewer-only account is explicitly allow-listed to `POST /create` even though `isViewerOnly` otherwise blocks all non-GET requests (`middleware/auth.js` `VIEWER_WRITE_ALLOWLIST`). `getAllTickets` queries `SupportTicket.find()` with **no tenant filter at all** — intentional (it's the platform-wide SuperAdmin queue) but worth knowing since it's otherwise the only global, cross-tenant read in the ticket model.

**Required fields:** `createTicket` needs `title`, `description` (non-empty); `category`/`priority` optional with defaults.

**Screens:** `RaiseTicket.jsx`.

**Cross-module connections:** `resolveTicket` sends a WhatsApp notification via `notifyTenant`, but passes a **raw string** instead of the `{templateName, variables}` shape every other caller uses — see Risks.

---

## 14. Reports

**Purpose:** Per-company CSV/email reporting (weekly/monthly) and an activity-log export, scoped to Tasks + Checklists only.

**Routes:** `/api/reports/*` (`reportRoutes.js` → `reportController.js` / `activityReport.js`): `GET/POST /settings[/:tenantId]`, `GET /download/:tenantId`, `GET /activity/:tenantId`, `GET /activity/:tenantId/download`, `POST /send-test`.

**Permission/middleware:** `authMiddleware, subscriptionGuard` + `sameTenantOnly` on most; the `POST /settings` route checks tenant ownership **inline in the handler** instead of via `sameTenantOnly` middleware (inconsistent pattern vs. the sibling `GET /settings/:tenantId`).

**Required fields:** save settings needs `tenantId`; `reportEmail`/`weeklyReportDay`/`monthlyReportDate` optional.

**Screens:** `ReportsTab.jsx`, `ActivityLogPanel.jsx`.

**Cross-module connections:** `generateDetailedReport`/`activityReport.getActivityLog` read `DelegationTask` + `ChecklistTask` (+ `FlowInstance` for the activity log only) — **Leave, Attendance, Payroll, and legacy/new FMS order data are not part of the unified Reports Hub**; those modules each have their own separate export endpoints (`payroll/runs/:id/export`, `attendance/sheet`, `leave/calendar`).

---

## 15. Superadmin

**Purpose:** Platform-owner console: tenant directory/detail, pause/resume (immediate or scheduled), per-tenant employee/WhatsApp limits, `superAdmin.features` flags, billing/plan notes, admin-password reset, custom Mongo URI / custom WhatsApp key assignment, platform-wide activity feed.

**Routes:** `/api/superadmin/*` (`superAdminRoutes.js` → `superAdminController.js`): `GET /dashboard`, `GET /tenants`, `GET /tenants/:tenantId`, `GET /feed`, `POST /tenants/:tenantId/pause`, `POST /tenants/:tenantId/resume`, `PUT /tenants/:tenantId/limits`, `PUT /tenants/:tenantId/features`, `PUT /tenants/:tenantId/billing`, `PUT /tenants/:tenantId/note`, `POST /tenants/:tenantId/reset-password`, `GET /tenants/:tenantId/logs`, `POST /process-schedules`, `PUT /tenants/:tenantId/custom-db`, `PUT /tenants/:tenantId/custom-whatsapp`.

**Permission/middleware:** every route is `authMiddleware, superAdminOnly` (checks `req.user.isSuperAdmin` from the JWT).

**Screens:** `SuperAdmin.jsx` (master-login/create-company), `SuperAdminPanel.jsx`.

**Cross-module connections:** Writes `Tenant.superAdmin.*` (status, features, customMongoUri, customWhatsappKey) which every other module's middleware (`subscriptionGuard`, `tenantDbMiddleware`, `notify.js`) reads at request time. This is the module Phase 3 of this project is scoped to test.

---

## 16. Notifications

**Purpose:** WhatsApp push notifications (task assignment/reminders, leave/attendance events, FMS2 step assignment/reminder/overdue, welcome message, ticket resolution) plus a daily "morning briefing" digest, all per-tenant-overridable.

**Not a user-facing module/route** — it's a cross-cutting utility layer: `utils/notify.js` (`notifyTenant` — resolves `Tenant.superAdmin.customWhatsappKey` or `Tenant.whatsappConfig.apiKey`, else falls back to the global key), `utils/whatsappNotify.js` (DoubleTick + Maytapi template rendering, **hard-codes a fallback DoubleTick API key as a literal string in source**), `utils/fmsNotifier.js` (cron-based FMS2 assignment/reminder/overdue/manager-escalation notifications), `utils/briefingEngine.js` (per-tenant-scheduled morning briefing via an aggregation over `DelegationTask`), `utils/fmsScheduler.js` (legacy FMS Google-Sheet sync loop).

**Cross-module connections:** Called from Tasks (`createTask`, `respondToTask`, `sendWhatsAppReminder`), Employees (`addEmployee` welcome message), Tickets (`resolveTicket`), legacy FMS and FMS2 (step lifecycle), and the two tenant-routes `send-whatsapp-reminder` endpoints. **Note:** the sandbox's egress proxy blocks the real WhatsApp provider endpoints (`public.doubletick.io`/`api.maytapi.com`), so no actual WhatsApp message could be or was sent during any testing this session.

---

## Key user actions → route → permission → required fields

| Action | Route | Required permission / middleware | Required fields |
|---|---|---|---|
| Create employee | `POST /api/tasks/add-employee` | `adminOfSameCompany` (role must include `Admin`) | `tenantId, name, email, department, whatsappNumber, roles[], password` (`joiningDate` optional, validated) |
| Apply leave | `POST /api/tasks/leave/requests` | `leave.apply` (self) | `leaveTypeId, fromDate, toDate (or same as from), halfDay?, reason (if type.requiresReason)` |
| Approve leave | `PUT /api/tasks/leave/requests/:id/decision` | `leave.approve` (reach must cover the employee; cannot self-approve unless `leaveConfig.allowSelfApproval`) | `decision: 'Approved'|'Rejected', note?` |
| Run payroll (prepare) | `POST /api/tasks/payroll/runs` | `payroll.prepare` at `company` scope | `month: 'YYYY-MM'` (fails if a non-cancelled run already exists for that month, or no one has a salary structure) |
| Approve payroll | `PUT /api/tasks/payroll/runs/:id/approve` | `payroll.approve`; blocked if preparer === approver and no self-approval allowance; blocked if any line has negative net pay not on hold; blocked if `requireReview` is on and no "Reviewed" sign-off exists | `note?` |
| Release payroll | `PUT /api/tasks/payroll/runs/:id/release` | `payroll.release`; run must be `Approved` | — |
| Create task | `POST /api/tasks/create-task` | **none beyond login** (`authMiddleware, subscriptionGuard, tenantDbMiddleware`) | `title, assignerId, doerId, deadline` (+ optional `coordinatorId, coworkers[], helperDoers[], priority, isRevisionAllowed, maxExtensionDays, files[]`) |
| Complete task | `PUT /api/tasks/respond` | **none beyond login**; evidence file via multipart | `taskId, status: 'Completed'|'Verified'|...`, `evidence` file as applicable |
| Create role | `POST /api/tasks/access/roles` | `access.manage` (company scope; Admin has it by default) | `name (2-40 chars), description? (<=200), permissions:[{key,scope}]` (max 100 entries; max 50 roles/tenant; unique name) |
| Assign role | `PUT /api/tasks/access/assign` | `access.manage` | `employeeId, roleKeys[]` (max 5 roles/person; all keys must exist) |
| Switch HR module on/off | `PUT /api/tasks/access/modules/:tenantId` | `superAdminOnly` | `modules: {attendance?, leave?, payroll?}` (rejects turning on `payroll` unless `attendance` and `leave` are both on) |
| Switch feature flag on/off (fms/chat/reports/etc.) | `PUT /api/superadmin/tenants/:tenantId/features` | `superAdminOnly` | `features: {...}` (see `Tenant.superAdmin.features` keys) — **note: this only hides the nav link in the frontend; no backend route currently enforces these flags (see Risk #5)** |

---

## Notable duplication, inconsistency, and risk (for the next engineer)

1. **`tenantRoutes.js` vs `taskRoutes.js` — nearly-identical duplicate router with drifted middleware.** Both wrap the *same* controllers (`tenantController`, `taskController`, `accessController`) but are mounted at different prefixes (`/api/tenants` vs `/api/tasks`) with different middleware stacks. In `tenantRoutes.js`, the Task/Checklist routes are **missing `tenantDbMiddleware`** entirely, while the equivalent routes in `taskRoutes.js` have it. Frontend code almost exclusively calls `/api/tasks/*`; only `SuperAdmin.jsx` calls `/api/tenants/master-login` and `/api/tenants/create-company`. A fix applied to one router can easily be missed in the other.

2. **Legacy FMS (`/api/fms`) never uses `tenantDbMiddleware`; Order Forms doesn't either, even though it shares the `/api/fms2` mount with `newFmsRoutes.js`, which does.** Data for a tenant with a dedicated Mongo URI lands in the *shared* database regardless of tenant configuration for these two routers — a real "where is my data" trap for support/debugging.

3. **`FmsHistory` (legacy FMS) has no `tenantId` field.** Tenant ownership has to be reconstructed by looking up the parent `FmsInstance`/`FmsTemplate` on every history read. This was the root cause of the unauthenticated/cross-tenant IDOR fixed this session (commit `c15db7c`); any new history-reading endpoint added later must remember to do the same lookup or it reopens the hole.

4. **`taskController.js` defines `exports.handleRevision` twice** (the second definition silently shadows the first — dead code). Same shape of problem in `fmsController.js`, which defines `exports.getMyMissions` twice.

5. **Two independent "turn a module off" systems that don't talk to each other.** `Tenant.hrModules.{attendance,leave,payroll}` is enforced server-side (zeroes out permissions in `middleware/permission.js`). `Tenant.superAdmin.features.{fms,chat,reports,rewards,orderForms,...}` is **only checked by the frontend `Sidebar.jsx`** — no middleware anywhere checks `superAdmin.features`, so a tenant with `features.fms = false` only loses the nav link; their FMS2/legacy-FMS API routes remain fully callable. Confirmed directly against the running API in Phase 1 Section D testing this session.

6. **Tasks, Checklist, legacy FMS, FMS2, Order Forms, Chat, and Settings have no entries in the permission CATALOG at all.** Authorization for these modules is either a hard-coded `roles.includes('Admin')` check, a bespoke in-handler check, or **nothing** (Task create/respond, `update-settings`/`update-branding`, Order Forms design/delete). Any authenticated employee of a tenant can currently rewrite company Settings or branding, or create/delete tasks for anyone.

7. **Subscription-pause inconsistency between login and every other call.** `tenantController.loginEmployee` only checks the *old* `tenant.subscription.status === 'paused'` field. `middleware/subscriptionGuard.js` checks **both** `tenant.superAdmin.status` and `tenant.subscription.status`. Since `superAdminController.pauseTenant`/`resumeTenant` only ever write `tenant.superAdmin.*`, a tenant paused through the current SuperAdmin UI can still log in successfully and only discover they're paused when the *next* API call 403s.

8. **Tickets: no tenant-level Admin visibility.** `GET /api/tickets/all` is `superAdminOnly`; there is no route letting a company's own Admin see all tickets raised inside their own tenant.

9. **`ticketController.resolveTicket` sends a malformed WhatsApp notification** — passes a raw string where every other call site passes `{templateName, variables}`, which will likely render incorrectly or fail against a real WhatsApp Business template whitelist.

10. **Hard-coded fallback secret in source.** `utils/whatsappNotify.js` hard-codes a literal DoubleTick API key as the default when `process.env.DOUBLETICK_API_KEY` is unset. Worth rotating and removing.

11. **`/api/fms2` exposes admin repair tools with only `authMiddleware`** (`repair-assignees`, `fix-assignees`, `instance/:id/reassign`) — no `subscriptionGuard`, no `tenantDbMiddleware`, no `sameTenantOnly`, no role check. Any logged-in employee of *any* tenant can call these for a different tenant's `:tenantId`.

12. **Reports Hub is scoped to Tasks + Checklists only** — Attendance/Leave/Payroll/FMS numbers are not there; those modules each have their own separate export endpoint.

13. **Dead/backup files left in the tree**: `routes/chatRoutes.js.bak`, `routes/taskRoutes.js.bak`, `controllers/chatController.js.bak`, `utils/socketHandler.js.bak`, `controllers/temp.txt`, `patch-fms.js`, `resume-fix.js`. None are referenced by `index.js`'s `require()` graph, but their presence makes it easy to edit the wrong (non-live) copy of chat/task code.

14. **Chat is the only tenant module without `subscriptionGuard`.** A paused tenant's employees can still send messages/announcements/DMs after every other module has locked them out.

---

*Compiled as the Phase 2 deliverable of the ongoing WorkPilot QA/hardening project. See `E2E_REPORT.md` for Phase 1 test results (including the `attendance.export` gap referenced above), `SUPERADMIN_REPORT.md`/`AI_ASSISTANT_REPORT.md`/`SCALE_REPORT.md` for later phases.*
