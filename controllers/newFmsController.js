const FlowTemplate = require('../models/FlowTemplate');
const FlowInstance = require('../models/FlowInstance');
const Employee     = require('../models/Employee');
const axios        = require('axios');
const { completeStep, startInstance } = require('../utils/flowEngine');

// ─── TEMPLATE MANAGEMENT ──────────────────────────────────────────────────────

/**
 * POST /api/fms2/templates
 * Admin creates a new flow blueprint.
 */
exports.createTemplate = async (req, res) => {
  try {
    const {
      name, googleSheetId, scriptUrl, tabName, uniqueIdColumn,
      workingHours, startNodeId, nodes,
      dataSource, linkedFormId, deadlineColumn, assignColumn,
    } = req.body;

    const tenantId = req.user?.tenantId || req.body.tenantId;

    const src = dataSource || 'sheet';
    if (!name) {
      return res.status(400).json({ message: 'Flow name is required' });
    }
    if (!startNodeId || !nodes?.length) {
      return res.status(400).json({ message: 'Please add nodes and connect them before deploying' });
    }
    if (src === 'sheet' && (!googleSheetId || !scriptUrl)) {
      return res.status(400).json({ message: 'Google Sheet ID and Script URL are required for Sheet source' });
    }

    // Validate all node ids are unique
    const ids = nodes.map(n => n.id);
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ message: 'Duplicate node IDs found' });
    }

    // Validate startNodeId exists
    if (!nodes.find(n => n.id === startNodeId)) {
      return res.status(400).json({ message: 'startNodeId does not match any node' });
    }

    const template = await FlowTemplate.create({
      tenantId,
      name,
      dataSource:    src,
      linkedFormId:  linkedFormId || null,
      deadlineColumn: deadlineColumn || '',
      assignColumn:   assignColumn || '',
      googleSheetId: (googleSheetId || '').trim(),
      scriptUrl:     (scriptUrl || '').trim(),
      tabName: tabName?.trim() || 'Sheet1',
      uniqueIdColumn: uniqueIdColumn?.trim() || 'Order ID',
      workingHours: workingHours || { open: 9, close: 18, workDays: [1,2,3,4,5] },
      startNodeId,
      nodes,
    });

    res.status(201).json({ message: 'Flow template created', template });
  } catch (err) {
    console.error('[FMS] createTemplate error:', err.message);
    res.status(500).json({ message: 'Failed to create template', error: err.message });
  }
};

/**
 * GET /api/fms2/templates/:tenantId
 * Get all flow templates for a tenant.
 */
exports.getTemplates = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const templates = await FlowTemplate.find({ tenantId, isActive: true }).sort({ createdAt: -1 });
    res.json(templates);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch templates', error: err.message });
  }
};

/**
 * GET /api/fms2/templates/detail/:templateId
 * Get a single template with full node detail.
 */
exports.getTemplateById = async (req, res) => {
  try {
    const template = await FlowTemplate.findById(req.params.templateId);
    if (!template) return res.status(404).json({ message: 'Template not found' });
    res.json(template);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch template', error: err.message });
  }
};

/**
 * PUT /api/fms2/templates/:templateId
 * Update a template. Edits now apply live to all active instances of this
 * flow — we no longer block the save just because instances are in-flight.
 * completeStep() always re-fetches the template fresh from the DB on every
 * step completion, so any active instance automatically picks up the new
 * routing / deadlines / assignees / input fields the next time it moves.
 *
 * The one real risk: if the edit DELETES the node an instance is CURRENTLY
 * sitting on, that instance has nothing to resolve back to when it's
 * completed. We don't block for this either (per requirement), but we
 * detect it and report which orders are affected so the admin can act
 * (e.g. manually reassign/cancel just those), and flowEngine.completeStep
 * now fails that step gracefully instead of throwing a hard 500.
 */
exports.updateTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;

    const newNodeIds = new Set((req.body.nodes || []).map(n => n.id));

    // Instances currently active on this template
    const activeInstances = await FlowInstance.find(
      { templateId, status: 'active' },
      { orderIdentifier: 1, 'activeStep.nodeId': 1, 'activeStep.nodeName': 1 }
    );

    // Of those, which ones are sitting on a node that this edit is about to remove
    const orphaned = activeInstances.filter(
      inst => inst.activeStep?.nodeId && !newNodeIds.has(inst.activeStep.nodeId)
    );

    const updated = await FlowTemplate.findByIdAndUpdate(templateId, req.body, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Template not found' });

    res.json({
      message: activeInstances.length > 0
        ? `Template updated — now live for ${activeInstances.length} active instance(s).`
        : 'Template updated',
      template: updated,
      activeInstanceCount: activeInstances.length,
      orphanedInstances: orphaned.map(o => ({
        instanceId: o._id,
        orderIdentifier: o.orderIdentifier,
        currentStep: o.activeStep?.nodeName,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update template', error: err.message });
  }
};

/**
 * DELETE /api/fms2/templates/:templateId
 * Soft-delete a template.
 */
exports.deleteTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;

    const activeCount = await FlowInstance.countDocuments({ templateId, status: 'active' });
    if (activeCount > 0) {
      return res.status(409).json({ message: `${activeCount} active orders are using this flow. Cannot delete.` });
    }

    await FlowTemplate.findByIdAndUpdate(templateId, { isActive: false });
    res.json({ message: 'Template deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete template', error: err.message });
  }
};

// ─── SHEET INTEGRATION ────────────────────────────────────────────────────────

/**
 * GET /api/fms2/sheet-columns/:templateId
 * Fetch column headers from the sheet so admin can map them in the builder.
 * This is the ONLY time WorkPilot reads from the sheet.
 */
exports.getSheetColumns = async (req, res) => {
  try {
    const template = await FlowTemplate.findById(req.params.templateId);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const url = `${template.scriptUrl}?operation=readSheet&sheetId=${template.googleSheetId}&tabName=${encodeURIComponent(template.tabName)}&limit=1`;
    const response = await axios.get(url, { timeout: 15000 });

    const rows = response.data;
    if (!rows || !rows.length) {
      return res.json({ columns: [] });
    }

    const columns = Object.keys(rows[0]);
    res.json({ columns });
  } catch (err) {
    console.error('[FMS] getSheetColumns error:', err.message);
    res.status(500).json({ message: 'Failed to read sheet columns', error: err.message });
  }
};

/**
 * POST /api/fms2/push-sync
 * Called by the Google Apps Script onEdit trigger when a new row is added.
 * Creates a FlowInstance and starts the flow.
 * No auth required — the templateId acts as the shared secret.
 */
exports.pushSync = async (req, res) => {
  try {
    const { templateId, rowData } = req.body;

    if (!templateId || !rowData) {
      return res.status(400).json({ message: 'Missing templateId or rowData' });
    }

    const template = await FlowTemplate.findById(templateId);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    // Extract the Order ID
    const orderId = String(rowData[template.uniqueIdColumn] || '').trim();
    if (!orderId || orderId.length < 2) {
      return res.status(400).json({ message: `Could not find Order ID in column "${template.uniqueIdColumn}"` });
    }

    // Skip if already tracked
    const existing = await FlowInstance.findOne({ templateId, orderIdentifier: orderId });
    if (existing) {
      return res.status(200).json({ message: 'Order already tracked', orderId });
    }

    // Create instance — store the full row snapshot
    const instance = await FlowInstance.create({
      tenantId:        template.tenantId,
      templateId:      template._id,
      templateName:    template.name,
      orderIdentifier: orderId,
      rawSheetData:    rowData,
      status:          'active',
    });

    // Start the flow — activate first step
    const result = await startInstance(instance, template);

    console.log(`[FMS] New instance started: ${orderId} in "${template.name}"`);

    res.status(201).json({
      message: 'Flow started',
      orderId,
      firstStep: result ? result.firstNode.name : 'Flow completed immediately',
    });
  } catch (err) {
    console.error('[FMS] pushSync error:', err.message);
    res.status(500).json({ message: 'Push sync failed', error: err.message });
  }
};

/**
 * POST /api/fms2/manual-sync/:templateId
 * Admin manually pulls all rows from the sheet and creates instances for any new orders.
 */
exports.manualSync = async (req, res) => {
  try {
    const template = await FlowTemplate.findById(req.params.templateId);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    // Read all rows from sheet
    const url = `${template.scriptUrl}?operation=readSheet&sheetId=${template.googleSheetId}&tabName=${encodeURIComponent(template.tabName)}`;
    const response = await axios.get(url, { timeout: 30000 });
    const rows = response.data || [];

    let created = 0;
    let skipped = 0;

    for (const row of rows) {
      const orderId = String(row[template.uniqueIdColumn] || '').trim();
      if (!orderId || orderId.length < 2) { skipped++; continue; }

      const existing = await FlowInstance.findOne({ templateId: template._id, orderIdentifier: orderId });
      if (existing) { skipped++; continue; }

      const instance = await FlowInstance.create({
        tenantId:        template.tenantId,
        templateId:      template._id,
        templateName:    template.name,
        orderIdentifier: orderId,
        rawSheetData:    row,
        status:          'active',
      });

      await startInstance(instance, template);
      created++;
    }

    res.json({ message: 'Manual sync complete', created, skipped, total: rows.length });
  } catch (err) {
    console.error('[FMS] manualSync error:', err.message);
    res.status(500).json({ message: 'Manual sync failed', error: err.message });
  }
};

// ─── STEP COMPLETION ──────────────────────────────────────────────────────────

/**
 * POST /api/fms2/complete-step/:instanceId
 * Employee completes their current step.
 * Body: { decision: 'done'|'yes'|'no', inputs: { fieldId: value } }
 */
exports.completeStep = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { decision, inputs } = req.body;
    const employeeId   = req.user?.id;
    const employeeName = req.user?.name || 'Unknown';

    if (!['done', 'yes', 'no'].includes(decision)) {
      return res.status(400).json({ message: 'decision must be "done", "yes", or "no"' });
    }

    const instance = await FlowInstance.findById(instanceId);
    if (!instance) return res.status(404).json({ message: 'Instance not found' });

    // Security: employee can only complete their own assigned step
    if (instance.activeStep?.assignedToId &&
        instance.activeStep.assignedToId !== employeeId &&
        !req.user?.isSuperAdmin &&
        !req.user?.roles?.includes('Admin')) {
      return res.status(403).json({ message: 'This step is not assigned to you' });
    }

    const template = await FlowTemplate.findById(instance.templateId);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const { instance: updated, next } = await completeStep(
      instanceId, employeeId, employeeName, decision, inputs || {}, template
    );

    res.json({
      message:   'Step completed',
      completed: instance.activeStep?.nodeName,
      nextStep:  next?.nextNode?.name || (updated.status === 'completed' ? 'Flow complete' : null),
      status:    updated.status,
    });
  } catch (err) {
    console.error('[FMS] completeStep error:', err.message);
    if (err.code === 'NODE_ORPHANED') {
      return res.status(409).json({ message: err.message, code: err.code });
    }
    res.status(500).json({ message: 'Failed to complete step', error: err.message });
  }
};

// ─── MONITOR & ANALYTICS ──────────────────────────────────────────────────────

/**
 * GET /api/fms2/instances/:tenantId
 * All active instances for the live monitor.
 */
exports.getInstances = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { status = 'active', templateId, page = 1, limit = 50 } = req.query;

    const filter = { tenantId };
    if (status !== 'all') filter.status = status;
    if (templateId) filter.templateId = templateId;

    const skip = (Number(page) - 1) * Number(limit);

    const [instances, total] = await Promise.all([
      FlowInstance.find(filter)
        .sort({ 'activeStep.plannedDeadline': 1, startedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      FlowInstance.countDocuments(filter),
    ]);

    // Enrich with delay status
    const now = new Date();
    const enriched = instances.map(inst => ({
      ...inst,
      isOverdue: inst.activeStep?.plannedDeadline
        ? new Date(inst.activeStep.plannedDeadline) < now
        : false,
      delayMinutes: inst.activeStep?.plannedDeadline
        ? Math.round((now - new Date(inst.activeStep.plannedDeadline)) / 60000)
        : 0,
    }));

    res.json({
      instances: enriched,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch instances', error: err.message });
  }
};

/**
 * GET /api/fms2/monitor-stats/:tenantId
 * Quick stat counts for the monitor dashboard.
 */
exports.getMonitorStats = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const now = new Date();

    const [active, completed, overdue] = await Promise.all([
      FlowInstance.countDocuments({ tenantId, status: 'active' }),
      FlowInstance.countDocuments({ tenantId, status: 'completed' }),
      FlowInstance.countDocuments({
        tenantId,
        status: 'active',
        'activeStep.plannedDeadline': { $lt: now, $ne: null },
      }),
    ]);

    res.json({ active, completed, overdue, onTrack: active - overdue });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch stats', error: err.message });
  }
};

/**
 * GET /api/fms2/instance/:instanceId
 * Full detail for one order — used for the history modal.
 */
exports.getInstanceDetail = async (req, res) => {
  try {
    const instance = await FlowInstance.findById(req.params.instanceId).lean();
    if (!instance) return res.status(404).json({ message: 'Instance not found' });

    const template = await FlowTemplate.findById(instance.templateId).lean();

    res.json({ instance, template });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch instance', error: err.message });
  }
};

/**
 * GET /api/fms2/my-tasks/:employeeId
 * All active steps assigned to a specific employee — for the employee task view.
 */
exports.getMyTasks = async (req, res) => {
  try {
    const { employeeId } = req.params;

    const tasks = await FlowInstance.find({
      status: 'active',
      'activeStep.assignedToId': employeeId,
    })
    .sort({ 'activeStep.plannedDeadline': 1 })
    .lean();

    const now = new Date();
    const enriched = tasks.map(inst => {
      const node = null; // node details come from template — fetched client-side if needed
      return {
        instanceId:      inst._id,
        templateName:    inst.templateName,
        orderIdentifier: inst.orderIdentifier,
        rawSheetData:    inst.rawSheetData,
        activeStep:      inst.activeStep,
        isOverdue:       inst.activeStep?.plannedDeadline
                           ? new Date(inst.activeStep.plannedDeadline) < now
                           : false,
        delayMinutes:    inst.activeStep?.plannedDeadline
                           ? Math.round((now - new Date(inst.activeStep.plannedDeadline)) / 60000)
                           : 0,
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch tasks', error: err.message });
  }
};

/**
 * GET /api/fms2/my-tasks-with-nodes/:employeeId
 * Same as getMyTasks but also includes the node config (input fields, columns to show etc.)
 * Used by the employee task view to render the right UI.
 */
exports.getMyTasksWithNodes = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const now = new Date();

    // Also get the employee's name for name-based fallback matching
    const Employee = require('../models/Employee');
    const empDoc = await Employee.findById(employeeId).select('name').lean();
    const empName = empDoc?.name || '';

    // Match by ID or by name (fallback for old instances where ID wasn't resolved)
    const tasks = await FlowInstance.find({
      status: 'active',
      $or: [
        { 'activeStep.assignedToId': employeeId },
        { 'activeStep.assignedToId': employeeId.toString() },
        ...(empName ? [{ 'activeStep.assignedToName': empName }] : []),
      ],
    })
    .sort({ 'activeStep.plannedDeadline': 1 })
    .lean();

    // Batch fetch all unique templates
    const templateIds = [...new Set(tasks.map(t => t.templateId.toString()))];
    const templates   = await FlowTemplate.find({ _id: { $in: templateIds } }).lean();
    const templateMap = Object.fromEntries(templates.map(t => [t._id.toString(), t]));

    const enriched = tasks.map(inst => {
      const template = templateMap[inst.templateId.toString()];
      const node     = template?.nodes.find(n => n.id === inst.activeStep?.nodeId);
      const currentNodeId = inst.activeStep?.nodeId;

      // Find all collected field values from previous steps that are visible to current step
      const visibleCollectedData = [];
      if (template?.nodes && inst.nodeHistory?.length > 0) {
        for (const histEntry of inst.nodeHistory) {
          const histNode = template.nodes.find(n => n.id === histEntry.nodeId);
          if (!histNode?.inputFields?.length) continue;
          for (const field of histNode.inputFields) {
            // Check if this field is marked as visible to the current step
            if ((field.visibleToSteps || []).includes(currentNodeId)) {
              const value = histEntry.inputs?.[field.id] || histEntry.inputs?.[field.label];
              if (value !== undefined && value !== '') {
                visibleCollectedData.push({
                  fromStep:   histEntry.nodeName,
                  fieldLabel: field.label,
                  value,
                });
              }
            }
          }
        }
      }

      return {
        instanceId:          inst._id,
        templateName:        inst.templateName,
        orderIdentifier:     inst.orderIdentifier,
        rawSheetData:        inst.rawSheetData,
        activeStep:          inst.activeStep,
        visibleCollectedData,  // ← collected data from previous steps shared with this step
        nodeConfig:          node ? {
          type:              node.type,
          question:          node.question,
          howToComplete:     node.howToComplete || '',
          inputFields:       node.inputFields   || [],
          sheetColumnsToShow:node.sheetColumnsToShow || [],
        } : null,
        isOverdue:  inst.activeStep?.plannedDeadline
                      ? new Date(inst.activeStep.plannedDeadline) < now : false,
        delayMinutes: inst.activeStep?.plannedDeadline
                      ? Math.round((now - new Date(inst.activeStep.plannedDeadline)) / 60000) : 0,
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch tasks with nodes', error: err.message });
  }
};

/**
 * DELETE /api/fms2/instance/:instanceId
 * Cancel an active instance.
 */
exports.cancelInstance = async (req, res) => {
  try {
    const instance = await FlowInstance.findById(req.params.instanceId);
    if (!instance) return res.status(404).json({ message: 'Instance not found' });

    instance.status     = 'cancelled';
    instance.activeStep = null;
    await instance.save();

    res.json({ message: 'Instance cancelled' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to cancel instance', error: err.message });
  }
};

/**
 * POST /api/fms2/repair-assignees/:tenantId
 * One-time fix: resolves null assignedToId by matching employee names in DB
 */
exports.fixInstanceAssignee = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { employeeId, employeeName } = req.body;

    // Find all active instances with Unassigned and fix them using the first node's assignee
    const templates = await FlowTemplate.find({ tenantId }).lean();
    const instances = await FlowInstance.find({ tenantId, status: 'active', 'activeStep.assignedToId': null }).lean();

    let fixed = 0;
    for (const inst of instances) {
      const template = templates.find(t => t._id.toString() === inst.templateId?.toString());
      if (!template) continue;

      // Find the node that matches the current active step
      const activeNode = template.nodes?.find(n => n.id === inst.activeStep?.nodeId);
      if (!activeNode) continue;

      const empId = activeNode.assignedTo?.value;
      if (!empId) continue;

      // Look up employee
      const emp = await Employee.findById(empId).select('_id name').lean();
      if (!emp) continue;

      await FlowInstance.updateOne(
        { _id: inst._id },
        { $set: { 'activeStep.assignedToId': emp._id.toString(), 'activeStep.assignedToName': emp.name } }
      );
      console.log(`[Fix] ${inst.orderIdentifier} → ${emp.name} (${emp._id})`);
      fixed++;
    }

    res.json({ message: `Fixed ${fixed} instances`, fixed });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.repairAssignees = async (req, res) => {
  try {
    const { tenantId } = req.params;

    // Find ALL active instances — not just null assignedToId
    const instances = await FlowInstance.find({
      tenantId,
      status: 'active',
    }).lean();

    console.log(`[Repair] Found ${instances.length} active instances for tenant ${tenantId}`);

    // Log what we find for debugging
    instances.forEach(i => {
      console.log(`[Repair] Instance ${i.orderIdentifier}: assignedToName="${i.activeStep?.assignedToName}" assignedToId="${i.activeStep?.assignedToId}"`);
    });

    // Get all employees for this tenant
    const allEmployees = await Employee.find({ tenantId }).select('_id name').lean();
    console.log(`[Repair] Employees in DB:`, allEmployees.map(e => `${e.name} (${e._id})`));

    let fixed = 0;
    for (const inst of instances) {
      const name = inst.activeStep?.assignedToName;
      const currentId = inst.activeStep?.assignedToId;
      if (!name || name === 'Unassigned') continue;

      // Find employee by name (case insensitive, partial match)
      const emp = allEmployees.find(e =>
        e.name.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(e.name.toLowerCase())
      );

      if (emp && emp._id.toString() !== currentId) {
        await FlowInstance.updateOne(
          { _id: inst._id },
          { $set: { 'activeStep.assignedToId': emp._id.toString() } }
        );
        console.log(`[Repair] Fixed ${inst.orderIdentifier}: "${name}" → ${emp._id}`);
        fixed++;
      }
    }

    const toFix = instances.filter(i => i.activeStep?.assignedToName && i.activeStep.assignedToName !== 'Unassigned').length;
    res.json({
      message: `Fixed ${fixed} of ${toFix} instances`,
      fixed, total: instances.length,
      employees: allEmployees.map(e => ({ id: e._id, name: e.name })),
      instances: instances.map(i => ({ order: i.orderIdentifier, name: i.activeStep?.assignedToName, id: i.activeStep?.assignedToId }))
    });
  } catch (err) {
    console.error('[Repair] Error:', err.message);
    res.status(500).json({ message: 'Repair failed', error: err.message });
  }
};

/**
 * POST /api/fms2/instance/:instanceId/reassign
 * Directly set assignedToId/Name on an active instance's current step
 */
exports.reassignInstance = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { assignedToId, assignedToName } = req.body;
    if (!assignedToId) return res.status(400).json({ message: 'assignedToId required' });

    const result = await FlowInstance.updateOne(
      { _id: instanceId },
      { $set: { 'activeStep.assignedToId': assignedToId, 'activeStep.assignedToName': assignedToName || '' } }
    );
    res.json({ message: 'Reassigned', modified: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── GET COMPLETED FMS TASKS FOR COORDINATOR ─────────────────────────────────
exports.getCompletedTasksForCoordinator = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const tenantId = req.user.tenantId;

    // Get all completed flow instances for this tenant
    const instances = await FlowInstance.find({
      tenantId,
      status: { $in: ['completed', 'Completed'] },
    }).sort({ completedAt: -1 }).limit(100).lean();

    const enriched = instances.map(inst => ({
      instanceId: inst._id,
      orderIdentifier: inst.orderIdentifier,
      templateName: inst.templateName,
      status: 'Completed',
      completedAt: inst.completedAt,
      activeStep: inst.activeStep,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('[FMS] getCompletedTasksForCoordinator error:', err.message);
    res.status(500).json({ message: 'Failed to fetch completed tasks' });
  }
};

// ─── GET FMS TASKS FOR COORDINATOR (all mapped doers) ────────────────────────
exports.getFmsTasksForCoordinator = async (req, res) => {
  try {
    const { coordinatorId } = req.params;
    const tenantId = req.user.tenantId;

    // Get coordinator's mapped doers
    const Employee = require('../models/Employee');
    const coordinator = await Employee.findById(coordinatorId).lean();
    if (!coordinator) return res.status(404).json({ message: 'Coordinator not found' });

    // Get all doer IDs mapped to this coordinator
    const doerIds = coordinator.managedDoers || [];
    // Include coordinator themselves
    const allIds = [...doerIds.map(id => id.toString()), coordinatorId.toString()];

    const now = new Date();

    // Get active FMS tasks for all mapped doers
    const tasks = await FlowInstance.find({
      tenantId,
      status: 'active',
      'activeStep.assignedToId': { $in: allIds },
    }).sort({ 'activeStep.plannedDeadline': 1 }).lean();

    const enriched = tasks.map(inst => ({
      instanceId:      inst._id,
      templateName:    inst.templateName,
      orderIdentifier: inst.orderIdentifier,
      rawSheetData:    inst.rawSheetData,
      activeStep:      inst.activeStep,
      isOverdue:       inst.activeStep?.plannedDeadline
                         ? new Date(inst.activeStep.plannedDeadline) < now
                         : false,
      delayMinutes:    inst.activeStep?.plannedDeadline
                         ? Math.round((now - new Date(inst.activeStep.plannedDeadline)) / 60000)
                         : 0,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('[FMS] getFmsTasksForCoordinator error:', err.message);
    res.status(500).json({ message: 'Failed to fetch coordinator FMS tasks' });
  }
};

// ─── GET COMPLETED FMS TASKS FOR COORDINATOR (all mapped doers) ──────────────
exports.getCompletedFmsForCoordinator = async (req, res) => {
  try {
    const { coordinatorId } = req.params;
    const tenantId = req.user.tenantId;

    const Employee = require('../models/Employee');
    const coordinator = await Employee.findById(coordinatorId).lean();
    if (!coordinator) return res.status(404).json({ message: 'Coordinator not found' });

    const doerIds = (coordinator.managedDoers || []).map(id => id.toString());
    doerIds.push(coordinatorId.toString());

    const instances = await FlowInstance.find({
      tenantId,
      status: { $in: ['completed', 'Completed'] },
    }).sort({ completedAt: -1 }).limit(100).lean();

    const enriched = instances.map(inst => ({
      instanceId:      inst._id,
      orderIdentifier: inst.orderIdentifier,
      templateName:    inst.templateName,
      status:          'Completed',
      completedAt:     inst.completedAt,
      activeStep:      inst.activeStep,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('[FMS] getCompletedFmsForCoordinator error:', err.message);
    res.status(500).json({ message: 'Failed to fetch completed FMS tasks' });
  }
};