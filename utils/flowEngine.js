/**
 * flowEngine.js
 * The core brain of the FMS.
 * Handles: deadline calculation, node routing, step activation.
 * All data lives in MongoDB — no sheet reads or writes here.
 */

const FlowInstance = require('../models/FlowInstance');
const Employee     = require('../models/Employee');

// ─── DEADLINE CALCULATOR ──────────────────────────────────────────────────────

/**
 * Add working hours to a date, skipping outside working hours.
 * Equivalent to your plannedwwh formula.
 * @param {Date} from - start datetime
 * @param {number} hours - hours to add
 * @param {{open:number, close:number, workDays:number[]}} wh - working hours config
 * @returns {Date}
 */
function addWorkingHours(from, hours, wh) {
  let result = new Date(from);
  let remaining = hours * 60; // work in minutes

  // If the start time is outside working hours, snap to next opening
  result = snapToWorkingHours(result, wh);

  while (remaining > 0) {
    const dayOfWeek = result.getDay();
    if (!wh.workDays.includes(dayOfWeek)) {
      // Skip non-working day — jump to next day at opening time
      result = nextWorkingDayOpen(result, wh);
      continue;
    }

    const closeTime = new Date(result);
    closeTime.setHours(wh.close, 0, 0, 0);

    const minutesUntilClose = Math.max(0, (closeTime - result) / 60000);

    if (remaining <= minutesUntilClose) {
      result = new Date(result.getTime() + remaining * 60000);
      remaining = 0;
    } else {
      remaining -= minutesUntilClose;
      result = nextWorkingDayOpen(result, wh);
    }
  }

  return result;
}

/**
 * Add N working days to a date.
 * Equivalent to your plannedindays formula.
 */
function addWorkingDays(from, days, wh) {
  let result = new Date(from);
  let added = 0;

  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (wh.workDays.includes(result.getDay())) {
      added++;
    }
  }

  return result;
}

/**
 * T-N before a date in the sheet row.
 * Equivalent to your plannedlead formula.
 * @param {string} dateStr - the date value from rawSheetData
 * @param {number} daysBefore - how many days before that date
 */
function daysBeforeDate(dateStr, daysBefore) {
  const target = new Date(dateStr);
  if (isNaN(target)) return null;
  target.setDate(target.getDate() - daysBefore);
  return target;
}

/**
 * Fixed time of day, N working days after from.
 * Equivalent to your specificTime formula.
 * @param {Date} from
 * @param {number} days - working days to add
 * @param {number} timeOfDay - hour of day e.g. 15 = 3pm
 * @param {{workDays:number[]}} wh
 */
function specificTime(from, days, timeOfDay, wh) {
  let result = new Date(from);
  let added = 0;

  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (wh.workDays.includes(result.getDay())) added++;
  }

  result.setHours(timeOfDay, 0, 0, 0);
  return result;
}

function snapToWorkingHours(date, wh) {
  const d = new Date(date);
  const hour = d.getHours();

  // Not a working day — jump to next working day
  if (!wh.workDays.includes(d.getDay())) {
    return nextWorkingDayOpen(d, wh);
  }

  // Before opening — snap to opening
  if (hour < wh.open) {
    d.setHours(wh.open, 0, 0, 0);
    return d;
  }

  // After closing — jump to next working day opening
  if (hour >= wh.close) {
    return nextWorkingDayOpen(d, wh);
  }

  return d;
}

function nextWorkingDayOpen(date, wh) {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  d.setHours(wh.open, 0, 0, 0);

  // Keep skipping until we hit a work day
  while (!wh.workDays.includes(d.getDay())) {
    d.setDate(d.getDate() + 1);
  }

  return d;
}

/**
 * Calculate the deadline for a node.
 * @param {Object} node - the node config from FlowTemplate
 * @param {Date} prevCompletedAt - when the previous step was completed
 * @param {Object} rawSheetData - full order snapshot
 * @param {Object} wh - working hours config
 * @returns {Date|null}
 */
function calculateDeadline(node, prevCompletedAt, rawSheetData, wh) {
  if (!node.deadline || !node.deadline.mode) return null;

  const { mode, value, timeOfDay, dateColumn, unit } = node.deadline;
  const from = prevCompletedAt || new Date();

  try {
    // Convert value to hours if unit is specified
    let valueInHours = value;
    if (unit === 'mins')  valueInHours = value / 60;
    if (unit === 'days')  valueInHours = value * (wh.close - wh.open); // working hours per day

    switch (mode) {
      case 'wwh':
        return addWorkingHours(from, valueInHours, wh);

      case 'wwh2':
        // Same as wwh — the snap logic handles both cases
        return addWorkingHours(from, valueInHours, wh);

      case 'days':
        return addWorkingDays(from, value, wh);

      case 'lead':
        if (!dateColumn || !rawSheetData[dateColumn]) return null;
        return daysBeforeDate(rawSheetData[dateColumn], value);

      case 'specific':
        return specificTime(from, value, timeOfDay || wh.open, wh);

      default:
        return null;
    }
  } catch (err) {
    console.error('[FlowEngine] Deadline calc error:', err.message);
    return null;
  }
}


// ─── EMPLOYEE CACHE ───────────────────────────────────────────────────────────
// Caches employees by ID so repeated DB lookups don't fail due to
// connection timing issues or Mongoose model registration order.
const _empCache = {};

async function preCacheEmployees(template) {
  const ids = (template.nodes || [])
    .map(n => n.assignedTo?.value)
    .filter(v => v && v.trim() && v.length === 24);

  const unique = [...new Set(ids)];
  if (unique.length === 0) return;

  try {
    const emps = await Employee.find({ _id: { $in: unique } }).select('_id name').lean();
    emps.forEach(e => {
      _empCache[e._id.toString()] = e.name;
    });
    console.log(`[EmpCache] Cached ${emps.length} employees:`, emps.map(e => e.name).join(', '));
  } catch(err) {
    console.error('[EmpCache] Failed to pre-cache employees:', err.message);
  }
}

// ─── RESOLVE ASSIGNEE ─────────────────────────────────────────────────────────

async function resolveAssignee(node, rawSheetData) {
  // Safety check — if assignedTo is missing entirely
  if (!node.assignedTo) {
    console.warn('[resolveAssignee] node.assignedTo is undefined for node:', node.name);
    return { id: null, name: 'Unassigned' };
  }

  const type  = node.assignedTo.type  || 'employee';
  const value = node.assignedTo.value || '';

  console.log(`[resolveAssignee] Resolving for node "${node.name}": type=${type} value=${value}`);

  if (type === 'sheetColumn') {
    const raw = rawSheetData?.[value];
    if (!raw) return { id: null, name: 'Unassigned' };
    const emp = await Employee.findOne({ $or: [{ email: raw }, { name: raw }] }).select('_id name').lean();
    if (emp) return { id: emp._id.toString(), name: emp.name };
    return { id: null, name: String(raw) };
  }

  // type === 'employee' — value is a MongoDB ObjectId string
  if (value && value.trim()) {
    const trimmed = value.trim();

    // Method 0: check pre-cache first (fastest, most reliable)
    if (_empCache[trimmed]) {
      console.log(`[resolveAssignee] ✅ Found in cache: "${_empCache[trimmed]}"`);
      return { id: trimmed, name: _empCache[trimmed] };
    }

    // Method 1: findById
    try {
      const mongoose = require('mongoose');
      if (mongoose.Types.ObjectId.isValid(trimmed)) {
        const emp = await Employee.findById(trimmed).select('_id name').lean();
        if (emp) {
          _empCache[trimmed] = emp.name; // store in cache
          console.log(`[resolveAssignee] ✅ Found by ID: "${emp.name}" (${emp._id})`);
          return { id: emp._id.toString(), name: emp.name };
        }
        console.warn(`[resolveAssignee] ⚠️ findById returned null for: ${trimmed}`);
      }
    } catch(e) {
      console.error('[resolveAssignee] findById error:', e.message);
    }

    // Method 2: findOne with _id as string comparison
    try {
      const emp = await Employee.findOne({ _id: value }).select('_id name').lean();
      if (emp) {
        console.log(`[resolveAssignee] ✅ Found by findOne _id: "${emp.name}"`);
        return { id: emp._id.toString(), name: emp.name };
      }
    } catch(e) {}

    // Method 3: by name if value looks like a name
    try {
      const emp = await Employee.findOne({ name: new RegExp(trimmed, 'i') }).select('_id name').lean();
      if (emp) {
        console.log(`[resolveAssignee] ✅ Found by name: "${emp.name}"`);
        return { id: emp._id.toString(), name: emp.name };
      }
    } catch(e) {}

    console.error(`[resolveAssignee] ❌ All methods failed for value: "${value}"`);
  }

  return { id: null, name: 'Unassigned' };
}

// ─── ACTIVATE NEXT NODE ───────────────────────────────────────────────────────

/**
 * Given a completed step decision, find the next node and activate it.
 * This is the core routing function.
 *
 * @param {Object} instance - FlowInstance document
 * @param {Object} template - FlowTemplate document
 * @param {string} decision - 'done' | 'yes' | 'no'
 * @param {Object} completedNode - the node that was just completed
 * @param {Date} completedAt - when it was completed
 */
async function activateNextNode(instance, template, decision, completedNode, completedAt) {
  // Determine which node comes next based on the decision
  let nextNodeId;

  if (completedNode.type === 'yesno') {
    nextNodeId = decision === 'yes'
      ? completedNode.yesNextNodeId
      : completedNode.noNextNodeId;
  } else {
    nextNodeId = completedNode.nextNodeId;
  }

  // No next node → flow is complete
  if (!nextNodeId) {
    instance.status      = 'completed';
    instance.completedAt = completedAt;
    instance.activeStep  = null;
    await instance.save();
    console.log(`[FlowEngine] Flow complete: ${instance.orderIdentifier}`);
    return null;
  }

  const nextNode = template.nodes.find(n => n.id === nextNodeId);

  if (!nextNode) {
    console.error(`[FlowEngine] Next node "${nextNodeId}" not found in template`);
    return null;
  }

  // End node → mark complete
  if (nextNode.type === 'end') {
    instance.status      = 'completed';
    instance.completedAt = completedAt;
    instance.activeStep  = null;
    await instance.save();
    return null;
  }

  // Calculate deadline for the new step
  const deadline = calculateDeadline(
    nextNode,
    completedAt,
    instance.rawSheetData,
    template.workingHours
  );

  // Ensure employee cache is warm before resolving
  await preCacheEmployees(template);

  // Resolve who is assigned
  const assignee = await resolveAssignee(nextNode, instance.rawSheetData);

  // Set the new active step
  instance.activeStep = {
    nodeId:          nextNode.id,
    nodeName:        nextNode.name,
    nodeType:        nextNode.type,
    assignedToId:    assignee.id,
    assignedToName:  assignee.name,
    activatedAt:     completedAt,
    plannedDeadline: deadline,
    notified:        false,
    reminderSent:    false,
  };

  await instance.save();

  console.log(`[FlowEngine] Activated "${nextNode.name}" for ${instance.orderIdentifier} → assigned to ${assignee.name}, deadline: ${deadline}`);

  return { nextNode, assignee, deadline };
}

// ─── COMPLETE A STEP ─────────────────────────────────────────────────────────

/**
 * Called when an employee completes their step.
 * Records the history entry and activates the next node.
 *
 * @param {string} instanceId
 * @param {string} employeeId
 * @param {string} employeeName
 * @param {string} decision - 'done' | 'yes' | 'no'
 * @param {Object} inputs - { fieldId: value } collected from input fields
 * @param {Object} template - FlowTemplate document
 * @returns {{ instance, nextNode, assignee, deadline }}
 */
async function completeStep(instanceId, employeeId, employeeName, decision, inputs, template) {
  const instance = await FlowInstance.findById(instanceId);
  if (!instance) throw new Error('Instance not found');
  if (instance.status !== 'active') throw new Error('Instance is not active');

  const active = instance.activeStep;
  if (!active) throw new Error('No active step on this instance');

  const completedAt = new Date();

  // Calculate delay
  let delayMinutes = 0;
  let onTime = true;
  if (active.plannedDeadline) {
    delayMinutes = Math.round((completedAt - active.plannedDeadline) / 60000);
    onTime = delayMinutes <= 0;
  }

  // Push history entry
  instance.nodeHistory.push({
    nodeId:          active.nodeId,
    nodeName:        active.nodeName,
    nodeType:        active.nodeType,
    assignedToId:    active.assignedToId,
    assignedToName:  active.assignedToName,
    completedById:   employeeId,
    completedByName: employeeName,
    activatedAt:     active.activatedAt,
    plannedDeadline: active.plannedDeadline,
    completedAt,
    decision:        decision || 'done',
    inputs:          inputs || {},
    onTime,
    delayMinutes,
  });

  // Find the completed node in the template
  const completedNode = template.nodes.find(n => n.id === active.nodeId);
  if (!completedNode) {
    // The flow was edited and the node this instance was sitting on was
    // removed. Don't crash the request — surface a clear, actionable error
    // instead of an opaque 500 so the admin knows exactly which order needs
    // manual attention (reassign to a valid node, or cancel the instance).
    const err = new Error(
      `This order's current step ("${active.nodeName}") was removed in a recent flow edit. ` +
      `Ask an admin to reassign or cancel this instance.`
    );
    err.code = 'NODE_ORPHANED';
    throw err;
  }

  // Route to next node
  const next = await activateNextNode(instance, template, decision, completedNode, completedAt);

  return { instance, next };
}

// ─── START A FLOW INSTANCE ────────────────────────────────────────────────────

/**
 * Activates the first step of a newly created FlowInstance.
 * Called immediately after FlowInstance is created from a sheet push.
 */
async function startInstance(instance, template) {
  const startNode = template.nodes.find(n => n.id === template.startNodeId);
  if (!startNode) throw new Error('Start node not found in template');

  // Pre-cache all employee IDs from the template nodes so resolveAssignee never fails
  await preCacheEmployees(template);

  // Start node itself has no deadline or assignee — immediately activate its next node
  const firstNodeId = startNode.nextNodeId;
  if (!firstNodeId) {
    instance.status = 'completed';
    await instance.save();
    return null;
  }

  const firstNode = template.nodes.find(n => n.id === firstNodeId);
  if (!firstNode) throw new Error(`First node "${firstNodeId}" not found`);

  const deadline = calculateDeadline(firstNode, new Date(), instance.rawSheetData, template.workingHours);
  const assignee = await resolveAssignee(firstNode, instance.rawSheetData);

  instance.activeStep = {
    nodeId:          firstNode.id,
    nodeName:        firstNode.name,
    nodeType:        firstNode.type,
    assignedToId:    assignee.id,
    assignedToName:  assignee.name,
    activatedAt:     new Date(),
    plannedDeadline: deadline,
    notified:        false,
    reminderSent:    false,
  };

  await instance.save();
  return { firstNode, assignee, deadline };
}

module.exports = { completeStep, startInstance, calculateDeadline };