// Pure, DB-free helpers for scoping FMS instance visibility to a
// coordinator's Mapping tab (managedDoers + managedAssigners) - the same
// set controllers/taskController.js:getCoordinatorTasks already uses to
// scope delegation and checklist tasks. Kept dependency-free of Mongoose
// so the scoping rules themselves can be unit tested without a database.
//
// "Involved" in an FMS instance (models/FlowInstance.js) means one of:
//   - assigned the current active step (activeStep.assignedToId), or
//   - assigned or completed any past step recorded in nodeHistory
//     (nodeHistory[].assignedToId / nodeHistory[].completedById).
// FlowInstance has no "who started it" field at all - there is no
// createdBy/startedBy anywhere in the schema, so "who started it" cannot
// be part of this definition; it simply isn't recorded. This definition
// is applied uniformly everywhere an instance's "involved" people matter.

const { isViewerOnly } = require('../middleware/auth');

/**
 * True when this caller is unrestricted - sees every FMS instance in the
 * tenant, exactly as getInstances behaved before this fix. Mirrors the
 * Admin-or-viewer-only bypass controllers/taskController.js:getCoordinatorTasks
 * uses for delegation/checklist.
 */
function isUnrestrictedFmsViewer(user) {
  return !!(
    user &&
    (user.isSuperAdmin ||
      (Array.isArray(user.roles) && user.roles.includes('Admin')) ||
      isViewerOnly(user))
  );
}

/**
 * The set of person ids a coordinator's Mapping tab covers: managedDoers +
 * managedAssigners. Does NOT include the coordinator's own id - this
 * matches getCoordinatorTasks's monitoredStaffIds exactly, so "the mapping
 * is empty" means the same thing in both places.
 */
function buildMappingIds(employee) {
  const doers = Array.isArray(employee && employee.managedDoers) ? employee.managedDoers : [];
  const assigners = Array.isArray(employee && employee.managedAssigners) ? employee.managedAssigners : [];
  return [...doers, ...assigners];
}

/**
 * Mongo filter fragment ($or array) for "instance involves any of idList",
 * covering both schema shapes used in FlowInstance (assignedToId is a
 * String path in both activeStep and nodeHistory; completedById is an
 * ObjectId path, only in nodeHistory). Returns null when idList is empty,
 * so callers can short-circuit to "no instances" instead of sending Mongo
 * an empty $in.
 */
function buildInvolvedOrClause(idList) {
  if (!Array.isArray(idList) || idList.length === 0) return null;
  const stringIds = idList.map((id) => String(id));
  return [
    { 'activeStep.assignedToId': { $in: stringIds } },
    { 'nodeHistory.assignedToId': { $in: stringIds } },
    { 'nodeHistory.completedById': { $in: idList } },
  ];
}

/**
 * Pure predicate form of the same rule, usable without a database: does
 * this plain (e.g. .lean()'d) FlowInstance-shaped object involve any id
 * in idList?
 */
function instanceInvolvesAnyOf(instance, idList) {
  if (!instance || !Array.isArray(idList) || idList.length === 0) return false;
  const ids = new Set(idList.map((id) => String(id)));
  if (instance.activeStep && ids.has(String(instance.activeStep.assignedToId))) return true;
  const history = Array.isArray(instance.nodeHistory) ? instance.nodeHistory : [];
  return history.some((h) => ids.has(String(h.assignedToId)) || ids.has(String(h.completedById)));
}

/**
 * True when `callerUser` (req.user, the caller) is allowed to ask the
 * subject-scoped FMS endpoints (getFmsTasksForCoordinator,
 * getCompletedFmsForCoordinator, getCompletedTasksForCoordinator,
 * getMyTasks, getMyTasksWithNodes) about `subjectId`, a route param
 * (coordinatorId/employeeId) naming the person whose tasks are requested.
 *
 * These endpoints decide WHAT to return by looking up `subjectId`'s own
 * mapping/role (unchanged, existing behaviour) - the bug this closes is
 * that they never checked WHO is allowed to ask for `subjectId` in the
 * first place, so any authenticated employee could pass any other
 * employee's id and read their task list. Admin, viewer-only and
 * superAdmin callers may ask about anyone (unrestricted, same bypass as
 * isUnrestrictedFmsViewer); everyone else may only ask about themselves.
 */
function canQuerySubject(callerUser, subjectId) {
  if (isUnrestrictedFmsViewer(callerUser)) return true;
  return !!callerUser && String(callerUser.id) === String(subjectId);
}

module.exports = {
  isUnrestrictedFmsViewer,
  buildMappingIds,
  buildInvolvedOrClause,
  instanceInvolvesAnyOf,
  canQuerySubject,
};
