// server/utils/followerValidation.js
//
// Pure-ish helper for validating a task's "followers" list (DelegationTask.coworkers).
// Followers are WATCH ONLY: they must never be the doer or the assigner of the
// task (that would be meaningless - they're already on it in an active role),
// must belong to the same tenant as the task, must be real Employee records,
// and the list is capped and de-duplicated so it can't be grown unbounded.
//
// SECURITY: this is the single place create/update task flows should run
// follower input through, so a tenant-mismatched or doer/assigner id can
// never be smuggled into coworkers via the API.

const MAX_FOLLOWERS = 20;

/**
 * @param {Object} opts
 * @param {Array}  opts.rawFollowers - raw input (array of ids, or id/ObjectId strings)
 * @param {String} opts.doerId
 * @param {String} opts.assignerId
 * @param {String} opts.tenantId
 * @param {Object} opts.Employee - the tenant-scoped Employee model (from getModels(req))
 * @returns {Promise<{ followers: string[], errors: string[] }>}
 *   followers: the cleaned, validated list of Employee _id strings (<= MAX_FOLLOWERS, deduped)
 *   errors: human-readable problems found (callers may choose to 400 on these, or silently drop)
 */
async function validateFollowers({ rawFollowers, doerId, assignerId, tenantId, Employee }) {
  const errors = [];
  if (!Array.isArray(rawFollowers) || rawFollowers.length === 0) {
    return { followers: [], errors };
  }

  const doer = String(doerId || '');
  const assigner = String(assignerId || '');

  // De-duplicate and drop the doer/assigner before we even hit the DB.
  const seen = new Set();
  const candidateIds = [];
  for (const raw of rawFollowers) {
    const id = String((raw && raw._id) || raw || '').trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    if (id === doer) {
      errors.push('The doer cannot also be a follower.');
      continue;
    }
    if (id === assigner) {
      errors.push('The assigner cannot also be a follower.');
      continue;
    }
    seen.add(id);
    candidateIds.push(id);
  }

  if (candidateIds.length === 0) return { followers: [], errors };

  // SECURITY: only accept ids that are real Employee records in the SAME tenant
  // as the task - otherwise a caller could add an employee from another
  // tenant (or a garbage id) as a "follower" and leak task visibility across
  // tenant boundaries.
  const found = await Employee.find({ _id: { $in: candidateIds }, tenantId }).select('_id');
  const validSet = new Set(found.map(e => String(e._id)));

  const followers = [];
  for (const id of candidateIds) {
    if (validSet.has(id)) {
      followers.push(id);
    } else {
      errors.push(`Employee ${id} is not a valid employee in this company and was not added as a follower.`);
    }
  }

  if (followers.length > MAX_FOLLOWERS) {
    errors.push(`A task can have at most ${MAX_FOLLOWERS} followers; extra followers were dropped.`);
  }

  return { followers: followers.slice(0, MAX_FOLLOWERS), errors };
}

module.exports = { validateFollowers, MAX_FOLLOWERS };
