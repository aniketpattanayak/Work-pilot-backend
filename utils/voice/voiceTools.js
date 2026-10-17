// What the voice agent is allowed to DO. The agent (an LLM) only supplies arguments; who is
// calling (tenant, employee, roles) always comes from the VoiceCallLog row + a fresh gate check -
// never from anything the model or the caller says.
const mongoose = require('mongoose');
const VoiceCallLog = require('../../models/VoiceCallLog');
const taskController = require('../../controllers/taskController');
const { invokeController } = require('./invoke');
const { reqDbForTenant } = require('./voiceContext');
const { clampToCallingHours } = require('./phone');

const OPEN_STATUSES = ['Pending', 'Accepted', 'Revision Requested'];
const MIN_LEAD_MS = 5 * 60 * 1000;
const MAX_FUTURE_MS = 365 * 24 * 3600 * 1000;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const oid = (v) => (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null);
const liveRoles = (emp) => (Array.isArray(emp.roles) ? emp.roles : []);

// ── Tool definitions (JSON schema the model sees) ──────────────────────────────
const TOOL_SCHEMAS = {
  complete_task: {
    description: 'Mark ONE of the caller\'s tasks as completed. Call only after they clearly said it is finished.',
    parameters: { type: 'object', properties: { taskId: { type: 'string', description: 'taskId from the task list' } }, required: ['taskId'] },
  },
  log_blocker: {
    description: 'Record why a task is NOT finished, when the caller expects to finish it, and when to call back. Call after you have the reason and the new expected time.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string', description: 'One short sentence: what held the work up.' },
        expectedFinishAt: { type: 'string', description: 'New expected finish, ISO 8601 with +05:30 offset.' },
        callbackAt: { type: 'string', description: 'When to call back to follow up, ISO 8601 with +05:30. Within 10 AM-6 PM IST.' },
      },
      required: ['taskId', 'reason', 'expectedFinishAt'],
    },
  },
  find_employee: {
    description: 'Look up a colleague by the name the caller said. Returns up to 5 matches with employeeId.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  create_task: {
    description: 'Create a task. Only call after reading the details back and getting a clear yes; set confirmed=true.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        assigneeId: { type: 'string', description: 'employeeId returned by find_employee' },
        deadline: { type: 'string', description: 'ISO 8601 with +05:30 offset' },
        priority: { type: 'string', enum: ['Low', 'Medium', 'High', 'Urgent'] },
        confirmed: { type: 'boolean', description: 'true only if the caller said yes to your read-back' },
      },
      required: ['title', 'assigneeId', 'deadline', 'confirmed'],
    },
  },
  get_status_summary: {
    description: 'Current status for admins: pending, overdue, blockers, team updates.',
    parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['overall', 'overdue', 'blockers', 'team'] } }, required: [] },
  },
};

/** Which tools a given call may use - decided by purpose + the caller's roles, server-side. */
function allowedTools(log, employee) {
  if (log.purpose === 'doer_checkin') return ['complete_task', 'log_blocker'];
  const roles = liveRoles(employee);
  const out = [];
  if (roles.includes('Assigner') || roles.includes('Admin')) out.push('find_employee', 'create_task');
  if (roles.includes('Admin')) out.push('get_status_summary');
  return out;
}

// ── Handlers. Each returns a plain string the agent can speak from. ───────────
async function completeTask({ log, employee, tenant, args }) {
  const taskId = oid(args.taskId);
  if (!taskId || !log.taskIds.some((t) => String(t) === String(taskId))) return 'That task is not part of this call. Ask which task they mean.';
  const db = await reqDbForTenant(tenant._id);
  const r = await invokeController(taskController.respondToTask, {
    user: { id: String(employee._id), roles: liveRoles(employee), tenantId: String(tenant._id) },
    body: { taskId: String(taskId), status: 'Completed', remarks: 'Marked complete during a WorkPilot voice check-in.', doerId: String(employee._id) },
    db,
  });
  if (r.status !== 200) return `Could not mark it complete (${r.body?.message || 'error'}). Tell them you will flag it and they can mark it in the app.`;
  const title = r.body?.task?.title;
  await VoiceCallLog.updateOne({ _id: log._id }, { $push: { taskOutcomes: { taskId, taskTitle: title, finished: true } } });
  return 'Done. The task is now marked completed.';
}

function resolveCallbackAt(callbackAt, expectedFinishAt, now = new Date()) {
  let cb = asDate(callbackAt);
  if (!cb || cb.getTime() < now.getTime() + MIN_LEAD_MS) {
    // no usable callback time: check in shortly after the expected finish, never sooner than 2 hours from now
    const base = new Date(Math.max(expectedFinishAt.getTime() + 30 * 60000, now.getTime() + 2 * 3600000));
    cb = base;
  }
  if (cb.getTime() > now.getTime() + 30 * 24 * 3600000) cb = new Date(now.getTime() + 30 * 24 * 3600000);
  return clampToCallingHours(cb);
}

async function logBlocker({ log, args }) {
  const taskId = oid(args.taskId);
  if (!taskId || !log.taskIds.some((t) => String(t) === String(taskId))) return 'That task is not part of this call. Ask which task they mean.';
  const reason = String(args.reason || '').trim().slice(0, 500);
  if (!reason) return 'I need the reason first. Ask what held the work up.';
  const now = new Date();
  const finish = asDate(args.expectedFinishAt);
  if (!finish || finish.getTime() < now.getTime() - 3600000 || finish.getTime() > now.getTime() + 180 * 24 * 3600000) {
    return 'That finish time does not look right. Ask again when they expect to finish, with a day and a time.';
  }
  const callbackAt = resolveCallbackAt(args.callbackAt, finish, now);
  const fresh = await VoiceCallLog.findById(log._id);
  const task = fresh.taskOutcomes.find((o) => String(o.taskId) === String(taskId));
  if (task) { task.finished = false; task.blockerReason = reason; task.expectedFinishAt = finish; }
  else fresh.taskOutcomes.push({ taskId, finished: false, blockerReason: reason, expectedFinishAt: finish });
  if (!fresh.blockerReason) fresh.blockerReason = reason;
  fresh.expectedFinishAt = finish;
  // One follow-up per call: the earliest requested callback wins.
  if (!fresh.callbackAt || fresh.callbackStatus !== 'pending' || callbackAt < fresh.callbackAt) fresh.callbackAt = callbackAt;
  fresh.callbackStatus = 'pending';
  await fresh.save();
  return `Noted. Expected finish saved, and a follow-up call is scheduled for ${callbackAt.toISOString()} (use natural words, not that format).`;
}

async function findEmployee({ employee, tenant, M, args }) {
  const name = String(args.name || '').trim();
  if (name.length < 2) return 'I need at least a couple of letters of the name.';
  const rows = await M.Employee.find({ tenantId: tenant._id, name: new RegExp(esc(name), 'i') }).select('name department').limit(5);
  if (!rows.length) return 'No one by that name. Ask them to repeat it.';
  return JSON.stringify(rows.map((e) => ({ employeeId: String(e._id), name: e.name, department: e.department || '' })));
}

async function createTask({ log, employee, tenant, M, toolCallId, args }) {
  if (args.confirmed !== true) return 'Not confirmed yet. Read the details back and ask if you should go ahead.';
  const title = String(args.title || '').trim();
  if (title.length < 3 || title.length > 200) return 'The task title needs to be a few words. Ask them for a short title.';
  const assigneeId = oid(args.assigneeId);
  const assignee = assigneeId ? await M.Employee.findOne({ _id: assigneeId, tenantId: tenant._id }) : null;
  if (!assignee) return 'I could not find that person. Use find_employee again.';
  const now = new Date();
  const deadline = asDate(args.deadline);
  if (!deadline || deadline.getTime() < now.getTime() + MIN_LEAD_MS || deadline.getTime() > now.getTime() + 2 * MAX_FUTURE_MS) {
    return 'That deadline is not in the future. Ask for a day and time again.';
  }
  const priority = ['Low', 'Medium', 'High', 'Urgent'].includes(args.priority) ? args.priority : 'Medium';

  // A provider may retry the same tool call, and a model may repeat itself: never create twice.
  const fresh = await VoiceCallLog.findById(log._id);
  if (toolCallId && fresh.handledToolCalls.includes(`create_task:${toolCallId}`)) return 'That task was already created a moment ago.';
  if (fresh.createdTaskIds.length) {
    const dup = await M.DelegationTask.findOne({ _id: { $in: fresh.createdTaskIds }, title, doerId: assignee._id });
    if (dup) return 'That task was already created on this call.';
  }

  const db = await reqDbForTenant(tenant._id);
  const r = await invokeController(taskController.createTask, {
    user: { id: String(employee._id), roles: liveRoles(employee), tenantId: String(tenant._id) },
    body: {
      title, description: String(args.description || '').slice(0, 1000) || `Created by voice call from ${employee.name}.`,
      assignerId: String(employee._id), doerId: String(assignee._id), tenantId: String(tenant._id),
      deadline: deadline.toISOString(), priority,
    },
    db,
  });
  if (r.status !== 201) return `The task could not be created (${r.body?.message || 'error'}). Tell them it did not go through and to try the app.`;
  await VoiceCallLog.updateOne({ _id: log._id }, { $push: { createdTaskIds: r.body.task._id, handledToolCalls: `create_task:${toolCallId || r.body.task._id}` } });
  return `Task created and assigned to ${assignee.name}. They will be notified.`;
}

async function statusSummary({ tenant, M, args }) {
  const now = new Date();
  const scope = ['overall', 'overdue', 'blockers', 'team'].includes(args.scope) ? args.scope : 'overall';
  const base = { tenantId: tenant._id };
  const open = { ...base, status: { $in: OPEN_STATUSES } };
  const out = { scope };
  const names = async (ids) => {
    const emps = await M.Employee.find({ _id: { $in: ids } }).select('name');
    return Object.fromEntries(emps.map((e) => [String(e._id), e.name]));
  };

  if (scope === 'overall' || scope === 'overdue') {
    const overdue = await M.DelegationTask.find({ ...open, deadline: { $lt: now } }).sort({ deadline: 1 }).limit(5).select('title doerId deadline');
    const n = await names(overdue.map((t) => t.doerId));
    out.pendingCount = await M.DelegationTask.countDocuments(open);
    out.overdueCount = await M.DelegationTask.countDocuments({ ...open, deadline: { $lt: now } });
    out.topOverdue = overdue.map((t) => ({ title: t.title, doer: n[String(t.doerId)] || 'someone', daysLate: Math.max(1, Math.floor((now - t.deadline) / 86400000)) }));
  }
  if (scope === 'overall' || scope === 'blockers') {
    const since = new Date(now.getTime() - 3 * 86400000);
    const logs = await VoiceCallLog.find({ tenantId: tenant._id, createdAt: { $gte: since }, 'taskOutcomes.finished': false }).sort({ createdAt: -1 }).limit(10);
    const rows = [];
    logs.forEach((l) => l.taskOutcomes.filter((o) => !o.finished && o.blockerReason).forEach((o) => rows.push({ person: l.employeeName, task: o.taskTitle || '', blocker: o.blockerReason, expectedFinish: o.expectedFinishAt })));
    out.recentBlockers = rows.slice(0, 5);
  }
  if (scope === 'overall' || scope === 'team') {
    const since = new Date(now.getTime() - 24 * 3600000);
    const done = await M.DelegationTask.find({ ...base, status: { $in: ['Completed', 'Verified'] }, 'history.timestamp': { $gte: since } }).select('title doerId history').limit(50);
    const recent = done.filter((t) => t.history.some((h) => ['Completed', 'Verified'].includes(h.action) && h.timestamp >= since));
    const n = await names(recent.map((t) => t.doerId));
    out.completedLast24h = recent.length;
    out.completedBy = [...new Set(recent.map((t) => n[String(t.doerId)]).filter(Boolean))].slice(0, 5);
  }
  return JSON.stringify(out);
}

const HANDLERS = { complete_task: completeTask, log_blocker: logBlocker, find_employee: findEmployee, create_task: createTask, get_status_summary: statusSummary };

/** Runs one tool call after the allow-list check. Never throws. */
async function runTool(name, ctx) {
  const allowed = allowedTools(ctx.log, ctx.employee);
  if (!HANDLERS[name] || !allowed.includes(name)) return 'You are not able to do that on this call.';
  try { return await HANDLERS[name](ctx); }
  catch (err) { console.error(`[Voice] tool ${name} failed:`, err.message); return 'Something went wrong on my side. Tell them you could not do that just now.'; }
}

module.exports = { TOOL_SCHEMAS, allowedTools, runTool, resolveCallbackAt, OPEN_STATUSES };
