const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const { notifyTenant } = require('../utils/notify');

function safeModel(db, name, fallback) {
  if (!db) return fallback;
  try { return db.model(name); } catch (e) { return fallback; }
}

function getModels(req) {
  const db = req?.db || null;
  return {
    DelegationTask: safeModel(db, 'DelegationTask', require('../models/DelegationTask')),
    Employee: safeModel(db, 'Employee', require('../models/Employee')),
    ChecklistTask: safeModel(db, 'ChecklistTask', require('../models/ChecklistTask')),
    FlowInstance: safeModel(db, 'FlowInstance', require('../models/FlowInstance')),
  };
}

/**
 * POST /tasks/sub-task
 * Splits an existing task (Delegation, Checklist, or FMS) by creating a sub task
 * pointing to it.
 */
exports.createSubTask = async (req, res) => {
  try {
    const { DelegationTask, Employee, ChecklistTask, FlowInstance } = getModels(req);
    const { parentType, parentId, title, description, receiverId, deadline, priority, customFields } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: 'Please write the sub task name.' });
    }
    if (!receiverId || !mongoose.Types.ObjectId.isValid(receiverId)) {
      return res.status(400).json({ message: 'Please choose who gets this sub task.' });
    }
    if (!deadline || isNaN(new Date(deadline).getTime())) {
      return res.status(400).json({ message: 'Please choose a valid deadline.' });
    }
    if (!parentType || !parentId) {
      return res.status(400).json({ message: 'Parent task information is required.' });
    }

    const tenantId = req.user?.tenantId;
    const assignerId = req.user?.id || req.user?._id;

    // Verify receiver belongs to tenant
    const receiver = await Employee.findById(receiverId).select('name whatsappNumber tenantId').lean();
    if (!receiver) {
      return res.status(404).json({ message: 'The assigned person was not found.' });
    }
    if (receiver.tenantId && String(receiver.tenantId) !== String(tenantId)) {
      return res.status(403).json({ message: 'Not allowed.' });
    }

    // Resolve parent task details
    let parentTitle = '';
    let parentDeadline = null;
    let parentAssigner = null;

    if (parentType === 'Delegation' && mongoose.Types.ObjectId.isValid(parentId)) {
      const parentDoc = await DelegationTask.findById(parentId).populate('assignerId', 'name whatsappNumber').lean();
      if (parentDoc) {
        parentTitle = parentDoc.title || '';
        parentDeadline = parentDoc.deadline;
        parentAssigner = parentDoc.assignerId;
      }
    } else if (parentType === 'Checklist' && mongoose.Types.ObjectId.isValid(parentId)) {
      const parentDoc = await ChecklistTask.findById(parentId).populate('createdBy', 'name whatsappNumber').populate('assignerId', 'name whatsappNumber').lean();
      if (parentDoc) {
        parentTitle = parentDoc.taskName || '';
        parentDeadline = parentDoc.nextDueDate;
        parentAssigner = parentDoc.createdBy || parentDoc.assignerId;
      }
    } else if (parentType === 'FMS') {
      const parentDoc = await FlowInstance.findById(parentId).lean().catch(() => null);
      if (parentDoc) {
        parentTitle = `${parentDoc.templateName || 'FMS'} #${parentDoc.orderIdentifier || ''}`.trim();
        parentDeadline = parentDoc.activeStep?.plannedDeadline || null;
      }
    }

    const warnings = [];
    if (parentDeadline && new Date(deadline).getTime() > new Date(parentDeadline).getTime()) {
      warnings.push(`Heads up: this sub task ends after the main task.`);
    }

    const subTask = new DelegationTask({
      tenantId,
      title: String(title).trim(),
      description: description || '',
      assignerId,
      doerId: receiverId,
      deadline: new Date(deadline),
      priority: priority || 'Medium',
      status: 'Pending',
      customFields: customFields || {},
      parentTask: {
        type: parentType,
        taskId: String(parentId),
        title: parentTitle,
      },
      history: [{
        action: 'Task Created',
        performedBy: assignerId,
        timestamp: new Date(),
        remarks: `Sub task created under ${parentType} task${parentTitle ? ` "${parentTitle}"` : ''}`
      }]
    });

    await subTask.save();

    // Notify receiver and main task assigner asynchronously via WhatsApp
    (async () => {
      try {
        const tenant = await Tenant.findById(tenantId).lean();
        const loginLink = `https://${tenant?.subdomain || 'portal'}.lrbcloud.ai/dashboard/my-tasks`;
        if (receiver.whatsappNumber) {
          await notifyTenant(
            tenantId,
            receiver.whatsappNumber,
            `📌 *New Sub Task Assigned*\n\nHi ${receiver.name}, you have been assigned a sub task: *${subTask.title}*${parentTitle ? ` (Part of: ${parentTitle})` : ''}.\n*Deadline:* ${new Date(deadline).toLocaleString('en-GB')}\n\n*Link:* ${loginLink}`
          );
        }
        if (parentAssigner?.whatsappNumber && String(parentAssigner._id) !== String(assignerId)) {
          await notifyTenant(
            tenantId,
            parentAssigner.whatsappNumber,
            `ℹ️ *Sub Task Created Under Your Task*\n\nA sub task *"${subTask.title}"* was assigned to ${receiver.name} under *"${parentTitle}"*.\n\n*Link:* ${loginLink}`
          );
        }
      } catch (waErr) {
        console.error('[subTaskController] WhatsApp notification error:', waErr.message);
      }
    })();

    res.status(201).json({
      message: 'Sub task created.',
      subTask,
      warnings
    });
  } catch (error) {
    console.error('[subTaskController] createSubTask error:', error);
    res.status(500).json({ message: 'Could not create the sub task.', error: error.message });
  }
};

/**
 * GET /tasks/sub-tasks
 * Lists sub tasks belonging to a parent task.
 */
exports.listSubTasks = async (req, res) => {
  try {
    const { DelegationTask } = getModels(req);
    const { parentType, parentId } = req.query;

    if (!parentType || !parentId) {
      return res.status(400).json({ message: 'parentType and parentId are required.' });
    }

    const tenantId = req.user?.tenantId;
    const subTasks = await DelegationTask.find({
      tenantId,
      'parentTask.type': parentType,
      'parentTask.taskId': String(parentId)
    })
      .populate('doerId', 'name')
      .populate('assignerId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    const rows = subTasks.map(t => ({
      _id: t._id,
      title: t.title,
      status: t.status,
      deadline: t.deadline,
      doer: t.doerId?.name || '-',
      assigner: t.assignerId?.name || '-',
      priority: t.priority
    }));

    res.status(200).json({ subTasks: rows });
  } catch (error) {
    console.error('[subTaskController] listSubTasks error:', error);
    res.status(500).json({ message: 'Could not load the sub tasks.', error: error.message });
  }
};

/**
 * POST /tasks/sub-tasks/summary
 * Returns counts of sub tasks ({ total, done }) for a batch of parent task IDs.
 */
exports.summary = async (req, res) => {
  try {
    const { DelegationTask } = getModels(req);
    const { parentType, ids } = req.body || {};

    if (!parentType || !Array.isArray(ids) || !ids.length) {
      return res.status(200).json({ summary: {} });
    }

    const tenantId = req.user?.tenantId;
    const stringIds = ids.map(String);

    const tasks = await DelegationTask.find({
      tenantId,
      'parentTask.type': parentType,
      'parentTask.taskId': { $in: stringIds }
    }).select('parentTask status').lean();

    const summary = {};
    stringIds.forEach(id => {
      summary[id] = { total: 0, done: 0 };
    });

    tasks.forEach(t => {
      const pId = t.parentTask?.taskId;
      if (pId && summary[pId]) {
        summary[pId].total += 1;
        if (['Completed', 'Verified'].includes(t.status)) {
          summary[pId].done += 1;
        }
      }
    });

    res.status(200).json({ summary });
  } catch (error) {
    console.error('[subTaskController] summary error:', error);
    res.status(500).json({ message: 'Could not load sub task summary.', error: error.message });
  }
};

