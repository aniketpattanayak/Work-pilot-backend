# fix/respond-task-tenant-isolation — notes

This branch is a standalone security fix, independent of `feature/ai-layer-v2`,
built off the latest `origin/main`. It does not depend on and is not merged
with the AI-layer-v2 branch.

## The bug

`PUT /api/tasks/respond` (`taskController.respondToTask`) had no
tenant-isolation or ownership check at all: any authenticated caller who
knew (or was handed) a `taskId` from a different company, or any employee
unrelated to a task within their own company, could change its status
(`Completed`, `Verified`, etc.) via a direct API call. This was originally
found while building the AI-layer-v2 Part 7 eval harness, whose
`cross_company` test caught a tenant-A admin successfully completing a
tenant-B task.

## Who legitimately reaches this route today

Read both the backend routes/controller and the frontend call sites
(`TaskCard.jsx` — the doer's own view; `ManageTasks.jsx` — the
assigner/admin's view; `DoerChecklist.jsx` — the doer completing via the
checklist flow) to find every real caller:

- **The doer** (`task.doerId`) — accepts, requests revision, or completes
  their own task.
- **The assigner** (`task.assignerId`, normally an Admin) — verifies the
  work or sends it back for correction.
- **An Admin** acting as a manager override, whether or not they are the
  task's own assigner (the frontend's admin screens don't restrict this to
  the original assigner, and nothing should require tracking down the
  specific original assigner to act on a task within one's own company).

No current frontend screen calls this specific route as a coordinator,
helper doer, or forward-chain member — those roles exist on the
`DelegationTask` schema (`coordinatorId`, `helperDoers`, `forwardChain`)
and are used elsewhere (e.g. a separate `coordinator-force-done` route for
checklist-style tasks), but not through `/tasks/respond` today.

## The decision taken (no one to ask — safest reasonable reading)

Rather than narrowly allow only the two call sites found in the current
frontend, the permission check allows every role the task's own data model
already recognizes as having a stake in it: doer, assigner, coordinator,
helper doer, forward-chain member, or Admin/superAdmin. This mirrors the
exact same role set already used by `updateTask`/`deleteTask` and (on the
AI-layer-v2 branch) `getTaskById` elsewhere in this same file, so the
permission logic for "who can touch this task" stays consistent across
every route that touches it, rather than this one route having a narrower,
easy-to-drift-out-of-sync rule of its own. Everyone else — a same-company
bystander or any other company's employee — is blocked: 403 for a
same-company bystander (confirms the task exists, just not to them), 404
for a different company (never confirms the id exists at all).

This is a permissive-but-bounded reading: it does not newly expose
anything (none of these relationships could reach the route before either,
since there was no check at all), and it does not restrict any current,
working frontend flow (doer/assigner/admin all still work exactly as
before — proven by the regression test).

## Test coverage

`scripts/fix-respond-tenant-isolation/test-respond-roles-regression.js`
(13/13 pass): one case each for doer, assigner, a second Admin (manager
override, not the original assigner), coordinator, helper doer, and
forward-chain member succeeding, plus a same-company bystander blocked
(403) and a different company blocked (404, with no actual state change).

Full backend suite run on this branch (98/98 pass): the above plus every
other `scripts/**/test-*.js` regression suite already on `main`
(`phase4-ai-assistant`'s AI-assistant/complete-task/confirm-flow/
lookup-tools/usage-ratelimit suites, `release-security-fixes`'s suite).
`test-ai-assistant-real-model.js` was not run — it requires
`ANTHROPIC_API_KEY`, not present in this sandbox.
