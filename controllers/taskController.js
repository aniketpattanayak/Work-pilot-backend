// server/controllers/taskController.js
const DelegationTask = require('../models/DelegationTask');
const Employee = require('../models/Employee'); // Ensure you import the Employee model
const Tenant = require('../models/Tenant');
const mongoose = require('mongoose');
const sendWhatsAppMessage = require('../utils/whatsappNotify');
const moment = require('moment');

const ChecklistTask = require('../models/ChecklistTask'); // The Model
const { calculateNextDate } = require('../utils/scheduler'); // The Math


exports.getDoerTasks = async (req, res) => {
  try {
    const { doerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(doerId)) {
      return res.status(400).json({ message: "Invalid ID format" });
    }

    /**
     * 1. IDENTIFY SUBSTITUTION SCOPE
     */
    const requester = await Employee.findById(doerId);

    const staffWhoAssignedMeAsBuddy = await Employee.find({
      'leaveStatus.buddyId': doerId
    }).select('_id name leaveStatus');

    const buddyForIds = staffWhoAssignedMeAsBuddy.map(s => s._id);

    /**
     * 2. UPDATED QUERY:
     * Find tasks where the user is the Lead Doer OR a Follower (Helper)
     * OR where the user is a Buddy for someone on leave.
     */
    const tasks = await DelegationTask.find({
      $or: [
        { doerId: doerId },
        { "helperDoers.helperId": doerId },
        { doerId: { $in: buddyForIds } }
      ]
    })
      .populate('assignerId', 'name email shadowName')
      .populate('doerId', 'name leaveStatus') // Populate leaveStatus to check per-task
      .populate('coordinatorId', 'name')
      .populate('history.performedBy', 'name')
      .sort({ createdAt: -1 });

    /**
     * 3. ROBUST LEAVE FILTERING
     */
    const getIsOnLeave = (emp, dateValue) => {
      const lstatus = emp?.leaveStatus;
      if (!lstatus) return false;
      if (lstatus.startDate && lstatus.endDate) {
        const d = new Date(dateValue).setHours(0, 0, 0, 0);
        const s = new Date(lstatus.startDate).setHours(0, 0, 0, 0);
        const e = new Date(lstatus.endDate).setHours(23, 59, 59, 999);
        return d >= s && d <= e;
      }
      return lstatus.onLeave || false;
    };

    const filteredTasks = tasks.filter(task => {
      const taskOwner = task.doerId;
      if (!taskOwner) return true;

      const isOwner = taskOwner._id.toString() === doerId;
      const isBuddySlot = buddyForIds.some(id => id.toString() === taskOwner._id.toString());

      const ownerOnLeave = getIsOnLeave(taskOwner, task.deadline);
      const requesterOnLeave = getIsOnLeave(requester, task.deadline);

      // If requester is on leave, they shouldn't see anything for this deadline
      if (requesterOnLeave) return false;

      if (ownerOnLeave) {
        if (isOwner) return false; // Hide from owner during leave
        if (isBuddySlot) return true;  // Show to buddy during leave
      } else {
        if (isBuddySlot && !isOwner) return false; // Hide from buddy outside leave
      }

      return true;
    });

    res.status(200).json(filteredTasks);
  } catch (error) {
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
};
exports.getAuthorizedStaff = async (req, res) => {
  try {
    const { id } = req.params;

    const requester = await Employee.findById(id)
      .populate('managedDoers', 'name roles department')
      .populate('managedAssigners', 'name roles department');

    if (!requester) return res.status(404).json({ message: "User not found" });

    // LOGIC: Admins AND Managers now see everyone in their factory
    if (requester.roles.includes('Admin') || requester.roles.includes('Manager')) {
      const allStaff = await Employee.find({ tenantId: requester.tenantId })
        .select('name roles department');
      return res.status(200).json({ doers: allStaff });
    }

    // Logic: Others see only their specifically mapped team
    const myTeam = requester.managedDoers || [];
    res.status(200).json({ doers: myTeam });
  } catch (error) {
    console.error("Auth Staff Error:", error);
    res.status(500).json({ message: "Error loading team members" });
  }
};

exports.getAssignerTasks = async (req, res) => {
  try {
    const { assignerId } = req.params;

    // Validation: Ensure the ID is a valid MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(assignerId)) {
      return res.status(400).json({ message: "Invalid Assigner ID format provided." });
    }

    const tasks = await DelegationTask.find({ assignerId: assignerId })
      .populate('doerId', 'name department roles email') // Populate Doer info
      .populate('coordinatorId', 'name')                 // Populate Coordinator info
      .populate('assignerId', 'name')                    // Populate Assigner info
      .populate('history.performedBy', 'name')           // FIXED: Converts IDs to names in Audit Log
      .sort({ createdAt: -1 });

    // If for some reason the array is empty, return a clean empty array
    res.status(200).json(tasks || []);
  } catch (error) {
    console.error("❌ Error in getAssignerTasks:", error.message);
    res.status(500).json({
      message: "Error fetching assigner tasks",
      error: error.message
    });
  }
};
exports.getTaskOverview = async (req, res) => {
  try {
    const { tenantId } = req.params;

    // If DelegationTask is not imported at the top, this line crashes
    const delegationCount = await DelegationTask.countDocuments({ tenantId });
    const checklistCount = await ChecklistTask.countDocuments({ tenantId });

    res.status(200).json({
      delegationCount,
      checklistCount
    });
  } catch (error) {
    // This is where your console error "DelegationTask is not defined" comes from
    console.error("Overview Fetch Error:", error.message);
    res.status(500).json({ message: error.message });
  }
};
exports.getCompanyOverview = async (req, res) => {
  try {
    const { tenantId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(tenantId)) {
      return res.status(400).json({ message: "Invalid Factory ID format" });
    }

    // This line was crashing because DelegationTask wasn't "seen" by the code
    const [employees, delegationTasks, checklistTasks] = await Promise.all([
      Employee.find({ tenantId }).select('name roles role department email managedDoers managedAssigners'),
      DelegationTask.find({ tenantId }).populate('assignerId', 'name').populate('doerId', 'name'),
      ChecklistTask.find({ tenantId }).populate('doerId', 'name')
    ]);

    res.status(200).json({
      employees: employees || [],
      delegationTasks: delegationTasks || [],
      checklistTasks: checklistTasks || []
    });

  } catch (error) {
    console.error("CRASH REPORT (Overview):", error.message);
    res.status(500).json({ message: "Backend Crash", error: error.message });
  }
};
exports.getEmployeeScore = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { range = 'Monthly' } = req.query; // Accepts: 'Daily', 'Weekly', 'Monthly'

    // --- PERSISTENCE: MODEL IMPORTS ---
    const Employee = require('../models/Employee');
    const employee = await Employee.findById(employeeId);

    const now = new Date();
    let startDate = new Date();

    // 1. CALCULATE TEMPORAL BOUNDARIES
    if (range === 'Daily') {
      startDate.setHours(0, 0, 0, 0);
    } else if (range === 'Weekly') {
      startDate.setDate(now.getDate() - 7);
    } else if (range === 'Monthly') {
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
    }

    /**
     * 2. DATA ACQUISITION: UNIFIED ANALYTICS
     * Fetching DelegationTasks and Checklist entries within the specified range.
     */
    const [delegations, checklists] = await Promise.all([
      DelegationTask.find({
        doerId: employeeId,
        $or: [
          { createdAt: { $gte: startDate } },
          { deadline: { $gte: startDate } },
          { "history.timestamp": { $gte: startDate } }
        ]
      }),
      ChecklistTask.find({
        doerId: employeeId,
        $or: [
          { lastCompleted: { $gte: startDate } },
          { nextDueDate: { $gte: startDate } }
        ]
      })
    ]);

    let stats = {
      onTime: 0,
      late: 0,
      missed: 0,
      total: 0
    };

    // 3. LOGIC: DELEGATION TASK PROCESSING
    delegations.forEach(task => {
      const completion = task.history.find(h => h.action === 'Completed' || h.action === 'Verified');

      if (completion) {
        stats.total++;
        if (new Date(completion.timestamp) <= new Date(task.deadline)) {
          stats.onTime++;
        } else {
          stats.late++;
        }
      } else if (new Date(task.deadline) < now) {
        // Task expired without completion
        stats.total++;
        stats.missed++;
      }
    });

    // 4. LOGIC: CHECKLIST TASK PROCESSING
    checklists.forEach(task => {
      const rangeHistory = task.history.filter(h =>
        (h.action === 'Completed' || h.action === 'Administrative Completion') &&
        new Date(h.timestamp) >= startDate
      );

      // Routine Logic: Every scheduled occurrence in range counts toward total
      // This counts how many times they actually did it vs missed it
      stats.onTime += rangeHistory.length;
      stats.total += rangeHistory.length;

      // Check if current routine is missed
      if (!rangeHistory.some(h => new Date(h.timestamp).toDateString() === now.toDateString()) &&
        new Date(task.nextDueDate) < now) {
        stats.missed++;
        stats.total++;
      }
    });

    const total = stats.total || 0;

    // --- UPDATED RESPONSE OBJECT ---
    // Preserves all existing fields for your Efficiency % and Top Scoreboard.
    res.status(200).json({
      range,
      totalTasks: total,
      onTimeTasks: stats.onTime,

      // Calculations for the Rewards Log Analytics
      onTimePercentage: total > 0 ? ((stats.onTime / total) * 100).toFixed(2) : 0,
      latePercentage: total > 0 ? ((stats.late / total) * 100).toFixed(2) : 0,
      missedPercentage: total > 0 ? ((stats.missed / total) * 100).toFixed(2) : 0,

      // Existing Scoreboard Logic
      score: total > 0 ? ((stats.onTime / total) * 100).toFixed(2) : 0,
      totalPoints: employee ? employee.totalPoints : 0,
      earnedBadges: employee ? employee.earnedBadges : [],

      notDoneOnTime: stats.late + stats.missed
    });
  } catch (error) {
    console.error("Performance Analytics Error:", error.message);
    res.status(500).json({ message: "Analytics calculation failed", error: error.message });
  }
};


exports.getGlobalPerformance = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { range = 'Daily' } = req.query;
    const now = new Date();
    let startDate = new Date();

    if (range === 'Daily') startDate.setHours(0, 0, 0, 0);
    else if (range === 'Weekly') startDate.setDate(now.getDate() - 7);
    else startDate.setDate(1);

    /**
     * UNIFIED AGGREGATION:
     * Fetch all tasks for the factory within the time range.
     */
    const [delegations, checklists] = await Promise.all([
      DelegationTask.find({ tenantId, createdAt: { $gte: startDate } }),
      ChecklistTask.find({ tenantId, "history.timestamp": { $gte: startDate } })
    ]);

    let globalStats = { onTime: 0, late: 0, missed: 0 };

    delegations.forEach(t => {
      const done = t.history.find(h => h.action === 'Completed' || h.action === 'Verified');
      if (done) {
        if (new Date(done.timestamp) <= new Date(t.deadline)) globalStats.onTime++;
        else globalStats.late++;
      } else if (new Date(t.deadline) < now) globalStats.missed++;
    });

    // Add checklist history entries to onTime counts
    checklists.forEach(t => {
      const count = t.history.filter(h => new Date(h.timestamp) >= startDate).length;
      globalStats.onTime += count;
    });

    const grandTotal = globalStats.onTime + globalStats.late + globalStats.missed;

    res.status(200).json({
      range,
      totalActiveItems: grandTotal,
      onTimePercentage: grandTotal > 0 ? ((globalStats.onTime / grandTotal) * 100).toFixed(0) : 0,
      latePercentage: grandTotal > 0 ? ((globalStats.late / grandTotal) * 100).toFixed(0) : 0,
      missedPercentage: grandTotal > 0 ? ((globalStats.missed / grandTotal) * 100).toFixed(0) : 0
    });
  } catch (error) {
    res.status(500).json({ message: "Global Analytics Error", error: error.message });
  }
};
exports.deleteTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    await DelegationTask.findByIdAndDelete(taskId);
    res.status(200).json({ message: "Task cancelled successfully" });
  } catch (error) {
    res.status(500).json({ message: "Delete failed", error: error.message });
  }
};

exports.completeChecklistTask = async (req, res) => {
  try {
    /**
     * 1. Extract data from the Multi-part Form Body
     */
    const { checklistId, remarks, completedBy, instanceDate } = req.body;

    // CRITICAL: Populate doerId to include the performer's name in notifications
    const task = await ChecklistTask.findById(checklistId).populate('doerId');

    if (!task) return res.status(404).json({ message: "Task not found" });

    const now = new Date();

    /**
     * TACTICAL INSTANCE TARGETING
     * Normalizing target date to start of day for accurate comparison.
     */
    const targetDate = instanceDate ? new Date(instanceDate) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    // 2. Fetch Factory/Tenant settings for scheduling logic
    const tenant = await Tenant.findById(task.tenantId);
    const holidays = tenant ? tenant.holidays : [];

    // 3. Update core tracking fields
    task.lastCompleted = now;

    // 4. Update the Audit History Log with Instance precision
    if (!task.history) task.history = [];

    task.history.push({
      action: "Completed",
      timestamp: now, 
      instanceDate: new Date(targetDate), 
      remarks: remarks || (instanceDate ? `Backlog catch-up for ${targetDate.toDateString()}` : "Daily routine finished."),
      attachmentUrl: req.file ? (req.file.location || req.file.path) : null,
      completedBy: completedBy || task.doerId
    });

    /**
     * 5. SMART POINTER ADVANCEMENT
     * Logic: advance pointer if current card is finished, stay put if backlog is finished.
     */
    const currentNextDue = new Date(task.nextDueDate);
    currentNextDue.setHours(0, 0, 0, 0);

    if (targetDate.toDateString() === currentNextDue.toDateString()) {
      task.nextDueDate = calculateNextDate(
        task.frequency,
        task.frequencyConfig || {},
        holidays,
        new Date(targetDate),
        false,
        tenant.weekends || [0] 
      );
    }

    await task.save();
    console.log(`✅ Checklist "${task.taskName}" for ${targetDate.toDateString()} completed.`);

    // --- UPDATED: WHATSAPP TEMPLATE NOTIFICATIONS (checklist_entry_saved) ---
    try {
      if (tenant?.whatsappConfig?.isActive) {
        const companySubdomain = tenant?.subdomain || "portal";
        //const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;
        const loginLink = `https://${companySubdomain}.lrbcloud.ai/dashboard/checklist-monitor`;

        /**
         * TEMPLATE MAPPING (Based on Screenshot):
         * {{1}} - Task Name
         * {{2}} - Entry Date (DD MMM YYYY)
         * {{3}} - Done By (Staff Name)
         * {{4}} - Exact Timestamp (hh:mm A)
         * {{5}} - Evidence/Remarks
         * {{6}} - Registry Link
         */
        const payload = {
          templateName: "checklist_entry_saved", // Matches your screenshot
          variables: [
            task.taskName,                                // {{1}}
            moment(targetDate).format('DD MMM YYYY'),      // {{2}}
            task.doerId?.name || "Staff",                 // {{3}}
            moment(now).format('hh:mm A'),                 // {{4}}
            req.file ? "Image Attached" : (remarks || "Verified"), // {{5}}
            loginLink                                     // {{6}}
          ]
        };

        // A. Notify the Primary Doer (Confirmation)
        if (task.doerId?.whatsappNumber) {
          await sendWhatsAppMessage(task.doerId.whatsappNumber, payload);
        }

        // B. Notify the Admin (Factory Manager)
        const admin = await Employee.findOne({ tenantId: tenant._id, roles: 'Admin' });
        if (admin?.whatsappNumber) {
          await sendWhatsAppMessage(admin.whatsappNumber, payload);
        }
        
        // C. Notify Quality Coordinator (If Assigned)
        if (task.coordinatorId) {
          const coordinator = await Employee.findById(task.coordinatorId);
          if (coordinator?.whatsappNumber) {
            await sendWhatsAppMessage(coordinator.whatsappNumber, payload);
          }
        }
      }
    } catch (waError) {
      console.error("⚠️ Checklist WhatsApp Dispatch Failed:", waError.message);
    }

    // 6. Final Confirmation
    res.status(200).json({
      message: `Instance for ${targetDate.toLocaleDateString()} submitted successfully!`,
      nextDue: task.nextDueDate,
      fileUrl: req.file ? (req.file.location || req.file.path) : null
    });

  } catch (error) {
    console.error("❌ Checklist Completion Error:", error.message);
    res.status(500).json({
      message: "Error updating checklist",
      error: error.message
    });
  }
};

exports.getAllChecklists = async (req, res) => {
  try {
    const { tenantId } = req.params;

    // 1. Validation: Ensure ID is valid
    if (!mongoose.Types.ObjectId.isValid(tenantId)) {
      return res.status(400).json({ message: "Invalid Tenant ID format" });
    }

    // 2. Fetch checklists for the entire company/tenant
    const checklists = await ChecklistTask.find({ tenantId })
      .populate('doerId', 'name department')
      .sort({ createdAt: -1 });

    // 3. Always return an array, even if empty, to prevent frontend crashes
    res.status(200).json(checklists || []);
  } catch (error) {
    console.error("❌ Error in getAllChecklists:", error.message);
    res.status(500).json({
      message: "Internal Server Error in Checklist fetching",
      error: error.message
    });
  }
};
exports.updateChecklistTask = async (req, res) => {
  try {
    const { id } = req.params;

    /**
     * 1. EXTRACT UPDATED FIELDS
     * Added 'description' to the destructuring to ensure it is captured 
     * from the high-density grid's edit mode.
     */
    const { taskName, description, doerId, status, frequency, frequencyConfig , createdAt } = req.body;

    /**
     * 2. SMART RE-CALCULATION GUARD
     * If frequency settings change, we need to find the new nextDueDate immediately.
     */
    const existingTask = await ChecklistTask.findById(id);
    if (!existingTask) {
      return res.status(404).json({ message: "Checklist record not found" });
    }

    const tenant = await Tenant.findById(existingTask.tenantId);
    const holidays = tenant?.holidays || [];
    let effectiveWeekends = tenant?.weekends || [0];

    // NEW: Factor in individual doer's Sunday availability
    const targetDoer = await Employee.findById(doerId || existingTask.doerId);
    if (targetDoer && targetDoer.workOnSunday) {
      effectiveWeekends = effectiveWeekends.filter(day => day !== 0);
    }

    // Recalculate if frequency or config changed
    let finalNextDueDate = existingTask.nextDueDate;
    const freqChanged = frequency && frequency !== existingTask.frequency;
    const configChanged = frequencyConfig && JSON.stringify(frequencyConfig) !== JSON.stringify(existingTask.frequencyConfig);

    if (freqChanged || configChanged) {
      const { calculateNextDate } = require('../utils/scheduler');

      // Use the scheduler's calculateNextDate to find the very next valid mission
      // Anchor from today to ensure the new schedule starts fresh
      
      
      
      //const anchor = new Date();


      const anchor = createdAt ? new Date(createdAt) : new Date(existingTask.createdAt);
anchor.setHours(0, 0, 0, 0);  


      //anchor.setHours(0, 0, 0, 0);

      finalNextDueDate = calculateNextDate(
        frequency || existingTask.frequency,
        frequencyConfig || existingTask.frequencyConfig,
        holidays,
        anchor,
        true, // isInitial: true forces anchoring on or after today
        effectiveWeekends
      );
    }

    /**
     * 3. EXECUTE ATOMIC UPDATE
     */
    const updatedTask = await ChecklistTask.findByIdAndUpdate(
      id,
      {
        $set: {
          taskName,
          description: description || "",
          doerId,
          status,
          frequency,
          frequencyConfig,
          nextDueDate: finalNextDueDate ,
          createdAt: createdAt || existingTask.createdAt,
        }
      },
      { new: true }
    ).populate('doerId', 'name department'); // Populating department for the Excel view

    // 3. REGISTRY VERIFICATION
    if (!updatedTask) {
      return res.status(404).json({ message: "Checklist record not found in system registry" });
    }

    console.log(`✅ Record Updated: ${updatedTask.taskName}`);

    // 4. SYNCHRONIZED RESPONSE
    res.status(200).json({
      message: "Checklist ledger record updated successfully!",
      task: updatedTask
    });

  } catch (error) {
    console.error("❌ Ledger Update Error:", error.message);
    res.status(500).json({
      message: "Action failed: Task update sequence error",
      error: error.message
    });
  }
};
exports.createChecklistTask = async (req, res) => {
  try {
    /**
     * 1. EXTRACT DATA
     * Captured from the new v3.0 high-density Create Protocol UI.
     * frequencyConfig now includes arrays: daysOfWeek: [] and daysOfMonth: [].
     */
    const {
      tenantId,
      taskName,
      description,
      doerId,
      frequency,
      frequencyConfig,
      startDate
    } = req.body;

    // 2. FETCH TENANT SETTINGS
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) return res.status(404).json({ message: "Factory settings not found" });

    /**
     * 3. INITIAL SMART-DATE CALCULATION (v3.1)
     * We pass the user-selected startDate as the baseDate.
     * isInitial: true tells the scheduler to anchor to this date for Daily/Q/H/Y
     * or scan forward from this date for Weekly/Monthly.
     */
    const baseAnchorDate = startDate ? new Date(startDate) : new Date();



    // Example for weekly
if (frequency === "Weekly") {
  const selectedDays = frequencyConfig.daysOfWeek || [];
  const weekends = tenant.weekends || [0];

  const conflictDays = selectedDays.filter(day => weekends.includes(day));

  if (conflictDays.length > 0) {
    return res.status(400).json({
      message: "Invalid configuration: Selected working day falls on employee off day",
      conflictDays
    });
  }
}



    const firstDueDate = calculateNextDate(
      frequency,
      frequencyConfig || {},
      tenant.holidays || [],
      baseAnchorDate,
      true,
      tenant.weekends || [0]
    );


    const newChecklist = new ChecklistTask({
      tenantId,
      taskName,
      description: description || "",
      doerId,
      frequency,
      /**
       * Persisting the full config object to enable iterative repeat logic
       * (e.g., repeating on the 1st, 15th, and 30th of every month).
       */
      frequencyConfig: frequencyConfig || {},
      startDate: baseAnchorDate, // Store the official initiation anchor
      nextDueDate: firstDueDate,  // Set the first active mission date
      status: 'Active',
      history: [{
        action: "Checklist Created",
        remarks: `Master directive initiated. First mission anchored for ${firstDueDate.toLocaleDateString('en-IN')}`,
        timestamp: new Date()
      }]
    });

    // 5. PERSIST TO REGISTRY
    await newChecklist.save();

    console.log(`✅ [LEDGER] Directive Synchronized: ${taskName} | Frequency: ${frequency} | Start: ${firstDueDate.toDateString()}`);

    res.status(201).json({
      message: "Recurring Checklist Created Successfully",
      nextDue: firstDueDate,
      taskId: newChecklist._id
    });

  } catch (error) {
    console.error("❌ [LEDGER ERROR]:", error.message);
    res.status(500).json({
      message: "Registry error: Failed to initiate checklist protocol",
      error: error.message
    });
  }
};
// 1. Updated: Supervisor/Coordinator Force Done
exports.coordinatorForceDone = async (req, res) => {
  try {
    const { taskId, coordinatorId, remarks } = req.body;

    // Find the Supervisor/Coordinator details
    const supervisor = await Employee.findById(coordinatorId);
    if (!supervisor) return res.status(404).json({ message: "Supervisor not found." });

    // 1. Identify the Task Collection
    // We populate all related parties to get names and WhatsApp numbers
    let task = await DelegationTask.findById(taskId)
      .populate('assignerId doerId coordinatorId');
    let isChecklist = false;

    if (!task) {
      task = await ChecklistTask.findById(taskId)
        .populate('doerId coordinatorId');
      isChecklist = true;
    }

    if (!task) return res.status(404).json({ message: "Task details not found." });

    // 2. Set the status based on Task Type
    if (isChecklist) {
      task.status = 'Active';
    } else {
      task.status = 'Completed';
    }

    // 3. Record the Action in History
    const historyEntry = {
      action: "Administrative Completion",
      performedBy: coordinatorId,
      timestamp: new Date(),
      remarks: remarks || `Marked as DONE by Supervisor: ${supervisor.name}`
    };

    if (!task.history) task.history = [];
    task.history.push(historyEntry);

    // 4. Handle Checklist-specific logic
    const Tenant = require('../models/Tenant');
    const tenant = await Tenant.findById(task.tenantId);

    if (isChecklist) {
      const { calculateNextDate } = require('../utils/scheduler');
      task.lastCompleted = new Date();
      task.nextDueDate = calculateNextDate(
        task.frequency,
        task.frequencyConfig || {},
        tenant ? tenant.holidays : []
      );
    }

    await task.save();

    // --- UPDATED: WHATSAPP NOTIFICATIONS FOR ALL PARTIES ---
    try {
      // GENERATE DYNAMIC LOGIN LINK USING SUBDOMAIN
      const companySubdomain = tenant?.subdomain || "portal";
      const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;

      const taskName = task.title || task.taskName;
      const formattedDeadline = task.deadline
        ? new Date(task.deadline).toLocaleDateString('en-IN', {
          day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        })
        : "N/A";

      // MAP SUPPORT TEAM NAMES AND FETCH NUMBERS
      const helperIds = Array.isArray(task.helperDoers) ? task.helperDoers.map(h => h.helperId) : [];
      const helpers = helperIds.length > 0 ? await Employee.find({ _id: { $in: helperIds } }) : [];
      const helperNames = helpers.map(h => h.name).join(", ") || "None";

      // PREPARE FILE LINKS
      const fileLinks = task.files && task.files.length > 0
        ? task.files.map((f, i) => `\n📎 Ref ${i + 1}: ${f.fileUrl}`).join("")
        : "\nNo attachments.";

      // FULL DETAILS BLOCK (Simple Language)
      const fullTaskDetails = `\n\n` +
        `*Task Title:* ${taskName}\n` +
        `*Description:* ${task.description || "No extra notes."}\n` +
        `*Given By:* ${task.assignerId?.name || 'Admin'}\n` +
        `*Primary Doer:* ${task.doerId?.name || 'Staff'}\n` +
        `*Coordinator:* ${task.coordinatorId?.name || 'Self-Track'}\n` +
        `*Support Team:* ${helperNames}\n` +
        `*Completion Date:* ${formattedDeadline}\n` +
        `*Urgency Level:* ${task.priority || 'Medium'}\n` +
        `*Files:* ${fileLinks}\n\n` +
        `*Done By:* Supervisor ${supervisor.name}\n` +
        `*Reason:* ${remarks || "Administrative closure"}\n\n` +
        `*Login Link:* ${loginLink}`;

      const finalHeader = `⚡ *Work Finalized by Supervisor*`;

      // DISPATCH TO ALL
      if (task.doerId?.whatsappNumber) await sendWhatsAppMessage(task.doerId.whatsappNumber, `${finalHeader}\n\nHi ${task.doerId.name}, your task has been closed.` + fullTaskDetails);
      if (!isChecklist && task.assignerId?.whatsappNumber) await sendWhatsAppMessage(task.assignerId.whatsappNumber, `${finalHeader}\n\nHi ${task.assignerId.name}, the work you assigned is now marked DONE.` + fullTaskDetails);
      if (task.coordinatorId?.whatsappNumber) await sendWhatsAppMessage(task.coordinatorId.whatsappNumber, `🛡️ *Task Closure Alert*\n\nHi ${task.coordinatorId.name}, a task you track was finished.` + fullTaskDetails);

      for (const helper of helpers) {
        if (helper.whatsappNumber) await sendWhatsAppMessage(helper.whatsappNumber, `🤝 *Team Work Update*\n\nHi ${helper.name}, the task you were helping with is closed.` + fullTaskDetails);
      }

    } catch (waError) {
      console.error("⚠️ WhatsApp Error:", waError.message);
    }

    res.status(200).json({ message: "Task marked as Done by Supervisor", task });
  } catch (error) {
    res.status(500).json({ message: "Action failed", error: error.message });
  }
};


/**
 * NEW: DEEP-DIVE LEDGER
 * Purpose: Row-wise detail of every late/missed task for a specific employee.
 */
exports.getEmployeeDeepDive = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;

    // 1. Fetch employee to check leave configuration
    const employee = await Employee.findById(employeeId).select('leaveStatus');
    const hasLeave = employee?.leaveStatus?.onLeave && employee.leaveStatus.startDate && employee.leaveStatus.endDate;

    // 2. Fetch both task types matching the date range
    const [delegations, checklists] = await Promise.all([
      DelegationTask.find({
        doerId: employeeId,
        deadline: { $gte: new Date(startDate), $lte: new Date(endDate) }
      }).lean(),
      ChecklistTask.find({
        doerId: employeeId,
      }).lean()
    ]);

    const detailedRows = [];

    // 3. Process Delegation Tasks
    delegations.forEach(t => {
      // LEAVE FILTERING: Skip if deadline falls inside leave period
      if (hasLeave) {
        const deadline = new Date(t.deadline);
        const leaveStart = new Date(employee.leaveStatus.startDate);
        const leaveEnd = new Date(employee.leaveStatus.endDate);
        const dDate = new Date(deadline).setHours(0, 0, 0, 0);
        const sDate = new Date(leaveStart).setHours(0, 0, 0, 0);
        const eDate = new Date(leaveEnd).setHours(23, 59, 59, 999);
        if (dDate >= sDate && dDate <= eDate) return;
      }

      const done = t.history?.find(h => h.action === 'Completed');
      let status = 'ON-TIME';
      if (!done && new Date(t.deadline) < new Date()) status = 'OVERDUE';
      else if (done && new Date(done.timestamp) > new Date(t.deadline)) status = 'LATE';
      else if (!done) status = 'PENDING';

      detailedRows.push({
        id: t._id,
        name: t.title || t.taskName,
        type: 'Delegation',
        deadline: t.deadline,
        completedAt: done?.timestamp || null,
        status: status,
        remarks: t.remarks || ""
      });
    });

    // 4. Process Checklist instances that fall within the range
   
   
  
  /*  checklists.forEach(t => {
      const rangeHistory = t.history?.filter(h =>
        new Date(h.timestamp) >= new Date(startDate) && new Date(h.timestamp) <= new Date(endDate)
      ) || [];

      rangeHistory.forEach(h => {
        const instanceDate = h.instanceDate || h.timestamp;

        // LEAVE FILTERING: Skip if instanceDate falls inside leave period
        if (hasLeave) {
          const leaveStart = new Date(employee.leaveStatus.startDate);
          const leaveEnd = new Date(employee.leaveStatus.endDate);
          const iDate = new Date(instanceDate).setHours(0, 0, 0, 0);
          const sDate = new Date(leaveStart).setHours(0, 0, 0, 0);
          const eDate = new Date(leaveEnd).setHours(23, 59, 59, 999);
          if (iDate >= sDate && iDate <= eDate) return;
        }

        const isLate = new Date(h.timestamp).toDateString() !== new Date(instanceDate).toDateString();

        detailedRows.push({
          id: t._id,
          name: t.taskName,
          type: 'Checklist',
          deadline: instanceDate,
          completedAt: h.timestamp,
          status: isLate ? 'LATE' : 'COMPLETED',
          remarks: h.remarks
        });
      });
    });
    
    
    
    */


    // 4. Process Checklist instances (INCLUDING PENDING)
checklists.forEach(t => {
  const start = new Date(startDate);
  const end = new Date(endDate);

  let pointer = new Date(t.nextDueDate);
  pointer.setHours(0,0,0,0);

  let loop = 0;

  while (pointer <= end && loop < 50) {
    loop++;

    const instanceDate = new Date(pointer);

    // Check if completed
    const done = t.history?.find(h => {
      const hDate = new Date(h.instanceDate || h.timestamp);
      return h.action === 'Completed' &&
             hDate.toDateString() === instanceDate.toDateString();
    });

    // LEAVE FILTERING
    if (hasLeave) {
      const leaveStart = new Date(employee.leaveStatus.startDate);
      const leaveEnd = new Date(employee.leaveStatus.endDate);

      const iDate = instanceDate.setHours(0,0,0,0);
      const sDate = new Date(leaveStart).setHours(0,0,0,0);
      const eDate = new Date(leaveEnd).setHours(23,59,59,999);

      if (iDate >= sDate && iDate <= eDate) {
        pointer.setDate(pointer.getDate() + 1);
        continue;
      }
    }

    let status = "PENDING";

    if (done) {
      const isLate = new Date(done.timestamp).toDateString() !== instanceDate.toDateString();
      status = isLate ? "LATE" : "COMPLETED";
    } else if (instanceDate < new Date()) {
      status = "OVERDUE";
    }

    detailedRows.push({
      id: t._id,
      name: t.taskName,
      type: 'Checklist',
      deadline: instanceDate,
      completedAt: done?.timestamp || null,
      status,
      remarks: done?.remarks || "",
      isChecklistInstance: true   // ⭐ IMPORTANT FLAG
    });

    // Move pointer
    if (t.frequency === 'Daily') pointer.setDate(pointer.getDate() + 1);
    else if (t.frequency === 'Weekly') pointer.setDate(pointer.getDate() + 7);
    else break;
  }
});



    res.status(200).json(detailedRows);
  } catch (error) {
    console.error("❌ Deep-dive fetch crash:", error);
    res.status(500).json({ message: "Internal Ledger Error", error: error.message });
  }
};

// ENDPOINT TO SAVE TARGET
exports.updateEmployeeTarget = async (req, res) => {
  try {
    const { employeeId, target } = req.body;
    await Employee.findByIdAndUpdate(employeeId, { weeklyLateTarget: target });
    res.status(200).json({ message: "Target synchronized." });
  } catch (error) {
    res.status(500).json({ message: "Update failed" });
  }
};
// 2. Updated: Manual Dashboard Reminder
// 2. Updated: Manual Dashboard Reminder using DoubleTick Template
exports.sendWhatsAppReminder = async (req, res) => {
  try {
    const { whatsappNumber, taskTitle, customMessage, taskId, coordinatorId } = req.body;

    // 1. Fetch Task and Coordinator details for the template variables
    const [task, supervisor] = await Promise.all([
      DelegationTask.findById(taskId).populate('doerId'),
      Employee.findById(coordinatorId)
    ]);

    if (!task) return res.status(404).json({ message: "Task not found." });

    const tenant = await Tenant.findById(task.tenantId);
    const companySubdomain = tenant?.subdomain || "portal";
    //const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;
    const loginLink = `https://${companySubdomain}.lrbcloud.ai/dashboard/my-tasks`
    /**
     * TEMPLATE: coordinator_manual_reminder
     * {{1}} - Employee Name (Doer)
     * {{2}} - Task Title
     * {{3}} - Coordinator Name
     * {{4}} - Custom Admin Message
     * {{5}} - Login Link
     */
    const payload = {
      templateName: "coordinator_manual_reminder", // Matches your latest screenshot
      variables: [
        task.doerId?.name || "Staff",         // {{1}}
        task.title || taskTitle,              // {{2}}
        supervisor?.name || "Factory Admin",  // {{3}}
        customMessage || "Please update your status.", // {{4}}
        loginLink                             // {{5}}
      ]
    };

    // 2. Dispatch to the specific number (Doer)
    await sendWhatsAppMessage(whatsappNumber, payload);

    console.log(`🔔 Reminder Template "${payload.templateName}" sent to ${whatsappNumber}`);
    res.status(200).json({ message: "Reminder sent successfully!" });

  } catch (error) {
    console.error("❌ Reminder Dispatch Failed:", error.message);
    res.status(500).json({ message: "Reminder failed", error: error.message });
  }
};

// server/controllers/taskController.js

// server/controllers/taskController.js
exports.dispatchDailyBriefings = async () => {
  try {
    const tenants = await Tenant.find();
    const todayStart = moment().startOf('day');
    const todayEnd = moment().endOf('day');

    for (const tenant of tenants) {
      // 1. Calculate the target time (e.g., if opening is 09:00, target is 07:00)
      const openingTime = tenant.officeHours?.opening || "09:00";
      const targetTime = moment(openingTime, "HH:mm").subtract(2, 'hours').format("HH:mm");
      const currentTime = moment().format("HH:mm");

      // Only run for factories whose "2-hour lead time" matches the current clock
      if (currentTime !== targetTime) continue;

      const employees = await Employee.find({ tenantId: tenant._id });

      for (const employee of employees) {
        // 2. Fetch Tasks for this specific employee
        const tasks = await DelegationTask.find({ 
          doerId: employee._id, 
          status: { $in: ['Pending', 'Accepted', 'Revision Requested'] } 
        });

        // 3. Categorize: Today vs Backlog
        const todaysTasks = tasks.filter(t => moment(t.deadline).isBetween(todayStart, todayEnd)).length;
        const backlogTasks = tasks.filter(t => moment(t.deadline).isBefore(todayStart)).length;
        const totalActionItems = todaysTasks + backlogTasks;

        // Skip if the employee has a completely clean slate
        if (totalActionItems === 0) continue;

        // 4. Dispatch DoubleTick Template: daily_morning_briefing
        if (employee.whatsappNumber) {
          const payload = {
            templateName: "daily_morning_briefing", // Matches your final screenshot
            variables: [
              employee.name,                          // {{1}}
              moment().format('DD MMM YYYY'),         // {{2}}
              String(todaysTasks),                    // {{3}}
              String(backlogTasks),                   // {{4}}
              String(totalActionItems),               // {{5}}
              //`https://${tenant.subdomain}.lrbcloud.ai/login` // {{6}}
              `https://${tenant.subdomain}.lrbcloud.ai/dashboard/my-tasks`
            ]
          };

          await sendWhatsAppMessage(employee.whatsappNumber, payload);
        }
      }
      console.log(`🌅 [Briefing] Dispatched for factory: ${tenant.companyName}`);
    }
  } catch (err) {
    console.error("❌ Briefing Engine Failure:", err.message);
  }
};


exports.getCoordinatorTasks = async (req, res) => {
  try {
    const { coordinatorId } = req.params;

    // 1. Find the Coordinator
    const coordinator = await Employee.findById(coordinatorId);
    if (!coordinator) return res.status(404).json({ message: "Coordinator not found" });

    let delegationQuery = {};
    let checklistQuery = {};

    // 2. CRITICAL LOGIC: If Admin, bypass mapping and show everything for the factory
    if (coordinator.roles.includes('Admin')) {
      delegationQuery = { tenantId: coordinator.tenantId };
      checklistQuery = { tenantId: coordinator.tenantId };
    } else {
      /**
       * MAPPING SYNC
       * Combine 'managedAssigners' AND 'managedDoers' to capture everyone 
       * mapped to this coordinator in the Mapping Tab.
       */
      const monitoredStaffIds = [
        ...(coordinator.managedAssigners || []),
        ...(coordinator.managedDoers || [])
      ];

      // If no mapping exists for a non-admin, return empty array immediately
      if (monitoredStaffIds.length === 0) {
        return res.status(200).json([]);
      }

      /**
       * SMART FILTERING
       * Retrieves tasks where the mapped staff are either giving the work 
       * (Assigner) or performing the work (Doer).
       */
      delegationQuery = {
        $or: [
          { assignerId: { $in: monitoredStaffIds } },
          { doerId: { $in: monitoredStaffIds } }
        ]
      };

      // Checklists are monitored based on the assigned Doer
      checklistQuery = { doerId: { $in: monitoredStaffIds } };
    }

    // 3. Parallel Fetch from Delegation and Checklist collections
    const [delegationTasks, checklistTasks] = await Promise.all([
      DelegationTask.find(delegationQuery)
        .populate('assignerId', 'name role')
        .populate('doerId', 'name role whatsappNumber department')
        .lean(),

      ChecklistTask.find(checklistQuery)
        .populate('doerId', 'name department whatsappNumber')
        .lean()
    ]);

    // 4. Normalization (Ensures frontend UI components don't crash)
    const normalizedChecklists = (checklistTasks || []).map(t => ({
      ...t,
      title: t.taskName || "Untitled Checklist",
      deadline: t.nextDueDate || new Date(),
      taskType: 'Checklist'
    }));

    const normalizedDelegations = (delegationTasks || []).map(t => ({
      ...t,
      taskType: 'Delegation'
    }));

    // 5. Merge and Sort by chronological deadline
    const allTasks = [...normalizedDelegations, ...normalizedChecklists].sort(
      (a, b) => new Date(a.deadline) - new Date(b.deadline)
    );

    res.status(200).json(allTasks);
  } catch (error) {
    console.error("❌ Coordinator Dashboard Sync Crash:", error.message);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
};
/*
exports.handleRevision = async (req, res) => {
  try {
    const { taskId, action, newDeadline, newDoerId, remarks, assignerId } = req.body;
    const { proposedDeadline } = req.body;

    // 1. Fetch Task and populate all related parties
    const task = await DelegationTask.findById(taskId)
      .populate('assignerId doerId coordinatorId');

    if (!task) return res.status(404).json({ message: "Task not found" });

    const Tenant = require('../models/Tenant');
    const tenant = await Tenant.findById(task.tenantId);

    // 2. GENERATE DYNAMIC LOGIN LINK USING SUBDOMAIN
    const companySubdomain = tenant?.subdomain || "portal";
    const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;

    // 3. Prepare task details for the WhatsApp message
    const moment = require('moment'); // Ensure moment is available
    const formattedDeadline = moment(newDeadline || task.deadline).format('DD MMM YYYY, hh:mm A');

    const helperIds = Array.isArray(task.helperDoers) ? task.helperDoers.map(h => h.helperId) : [];
    const helpers = helperIds.length > 0 ? await Employee.find({ _id: { $in: helperIds } }) : [];
    const helperNames = helpers.map(h => h.name).join(", ") || "None";

    const fileLinks = task.files && task.files.length > 0
      ? task.files.map((f, i) => `\n📎 Ref ${i + 1}: ${f.fileUrl}`).join("")
      : "\nNo attachments provided.";


    // --- REQUEST REVISION ---
if (action === 'Request') {
  task.status = 'Revision Requested';
  task.remarks = remarks || '';

  task.history.push({
    action: "Revision Requested",
    performedBy: task.doerId,
    remarks,
    timestamp: new Date()
  });

  await task.save();
}




    
    // * NEW: TRIGGER REVISION REQUEST NOTIFICATION
     //* If the status is 'Revision Requested', notify the Assigner using the template.
     
    //if (task.status === 'Revision Requested' && action !== 'Approve' && action !== 'Reassign') {
   
   
   
    if (action === 'Request'){
      try {
        if (task.assignerId?.whatsappNumber) {
          /**
           * TEMPLATE: task_revision_request
           * {{1}} - Personnel (Doer Name)
           * {{2}} - Task Title
           * {{3}} - Requested Deadline
           * {{4}} - Reason/Remarks
           * {{5}} - Approval/Login Link
           .................................

           
          const revisionPayload = {
            templateName: "task_revision_request",
            variables: [
              task.doerId?.name || "Staff",         // {{1}}
              task.title,                           // {{2}}
              formattedDeadline,                    // {{3}}
              task.remarks || "Not specified",      // {{4}}
              loginLink                             // {{5}}
            ]
          };
          await sendWhatsAppMessage(task.assignerId.whatsappNumber, revisionPayload);
          console.log(`🔄 Revision Request Template sent to Assigner: ${task.assignerId.name}`);
        }
      } catch (waErr) { console.error("⚠️ Revision Request Notify Error:", waErr.message); }
    }

    // --- CORE LOGIC: APPROVE EXTRA TIME ---
    if (action === 'Approve') {
      task.deadline = newDeadline || task.deadline;
      task.status = 'Accepted';
      task.remarks = "";

      task.history.push({
        action: "Deadline Approved",
        performedBy: assignerId,
        remarks: `New target date: ${new Date(task.deadline).toLocaleDateString()}`,
        timestamp: new Date()
      });

      // WHATSAPP: NOTIFY ENTIRE TEAM
      try {
        const fullDetails = `\n\n*Task:* ${task.title}\n*Description:* ${task.description || "No notes."}\n*Given By:* ${task.assignerId?.name}\n*Primary Doer:* ${task.doerId?.name}\n*Coordinator:* ${task.coordinatorId?.name || 'Admin'}\n*Support Team:* ${helperNames}\n*New Deadline:* ${formattedDeadline}\n*Urgency:* ${task.priority}\n*Files:* ${fileLinks}\n\n*Login Link:* ${loginLink}`;

        const message = `📅 *Extra Time Approved*\n\nHi [Name], the deadline for this task has been updated.` + fullDetails;

        if (task.doerId?.whatsappNumber) await sendWhatsAppMessage(task.doerId.whatsappNumber, message.replace("[Name]", task.doerId.name));
        if (task.assignerId?.whatsappNumber) await sendWhatsAppMessage(task.assignerId.whatsappNumber, message.replace("[Name]", task.assignerId.name));
        if (task.coordinatorId?.whatsappNumber) await sendWhatsAppMessage(task.coordinatorId.whatsappNumber, message.replace("[Name]", task.coordinatorId.name));
        for (const helper of helpers) {
          if (helper.whatsappNumber) await sendWhatsAppMessage(helper.whatsappNumber, message.replace("[Name]", helper.name));
        }
      } catch (waErr) { console.error("WA Error:", waErr.message); }
    }
    // --- CORE LOGIC: REASSIGN WORK ---
    else if (action === 'Reassign') {
      const oldDoerName = task.doerId?.name || "Previous Staff";
      task.doerId = newDoerId;
      task.status = 'Pending';

      task.history.push({
        action: "Task Reassigned",
        performedBy: assignerId,
        remarks: `Work moved from ${oldDoerName} to new person. Reason: ${remarks}`,
        timestamp: new Date()
      });

      await task.save();
      const updatedTask = await DelegationTask.findById(taskId).populate('doerId coordinatorId assignerId');
      const newDoer = updatedTask.doerId;

      // WHATSAPP: NOTIFY THE NEW TEAM
      try {
        const fullTaskDetails = `\n\n*Task:* ${updatedTask.title}\n*Description:* ${updatedTask.description || "No notes."}\n*Given By:* ${updatedTask.assignerId?.name}\n*Primary Doer:* ${newDoer?.name}\n*Coordinator:* ${updatedTask.coordinatorId?.name || 'Admin'}\n*Support Team:* ${helperNames}\n*Deadline:* ${formattedDeadline}\n*Urgency:* ${updatedTask.priority}\n*Files:* ${fileLinks}\n\n*Login Link:* ${loginLink}`;

        const message = `🔄 *Work Reassigned*\n\nHi [Name], this task has been moved to ${newDoer?.name}.` + fullTaskDetails;

        if (newDoer?.whatsappNumber) await sendWhatsAppMessage(newDoer.whatsappNumber, message.replace("[Name]", newDoer.name));
        if (updatedTask.assignerId?.whatsappNumber) await sendWhatsAppMessage(updatedTask.assignerId.whatsappNumber, message.replace("[Name]", updatedTask.assignerId.name));
        if (updatedTask.coordinatorId?.whatsappNumber) await sendWhatsAppMessage(updatedTask.coordinatorId.whatsappNumber, message.replace("[Name]", updatedTask.coordinatorId.name));
        for (const helper of helpers) {
          if (helper.whatsappNumber) await sendWhatsAppMessage(helper.whatsappNumber, message.replace("[Name]", helper.name));
        }
      } catch (waErr) { console.error("WA Error:", waErr.message); }
    }

    await task.save();
    res.status(200).json({ message: `Task ${action} successfully`, task });
  } catch (error) {
    console.error("Revision Error:", error.message);
    res.status(500).json({ message: "Update failed", error: error.message });
  }
};
*/



exports.handleRevision = async (req, res) => {
  try {
    const { taskId, action, newDeadline, newDoerId, remarks, assignerId, proposedDeadline } = req.body;

    // 1. Fetch Task
    const task = await DelegationTask.findById(taskId)
      .populate('assignerId doerId coordinatorId');

    if (!task) return res.status(404).json({ message: "Task not found" });

    const Tenant = require('../models/Tenant');
    const tenant = await Tenant.findById(task.tenantId);

    const companySubdomain = tenant?.subdomain || "portal";
    const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;

    const moment = require('moment');

    const helperIds = Array.isArray(task.helperDoers) ? task.helperDoers.map(h => h.helperId) : [];
    const helpers = helperIds.length > 0 ? await Employee.find({ _id: { $in: helperIds } }) : [];
    const helperNames = helpers.map(h => h.name).join(", ") || "None";

    const fileLinks = task.files && task.files.length > 0
      ? task.files.map((f, i) => `\n📎 Ref ${i + 1}: ${f.fileUrl}`).join("")
      : "\nNo attachments provided.";
    
    if (action === 'Request') {
      task.status = 'Revision Requested';
      task.remarks = remarks || '';

      
      if (proposedDeadline) {
        task.proposedDeadline = new Date(proposedDeadline);
      }

      task.history.push({
        action: "Revision Requested",
        performedBy: task.doerId,
        remarks,
        timestamp: new Date()
      });

      await task.save();

      // WhatsApp
      try {
        if (task.assignerId?.whatsappNumber) {
          const formattedDeadline = moment(task.proposedDeadline || task.deadline)
            .format('DD MMM YYYY, hh:mm A');

          const revisionPayload = {
            templateName: "task_revision_request",
            variables: [
              task.doerId?.name || "Staff",
              task.title,
              formattedDeadline,
              task.remarks || "Not specified",
              loginLink
            ]
          };

          await sendWhatsAppMessage(task.assignerId.whatsappNumber, revisionPayload);
        }
      } catch (waErr) {
        console.error("⚠️ Revision Request Notify Error:", waErr.message);
      }
    }

    
    if (action === 'Approve') {

      
      const finalDeadline = newDeadline || task.proposedDeadline || task.deadline;

      task.deadline = new Date(finalDeadline);
      task.status = 'Accepted';
      task.remarks = "";
      task.proposedDeadline = null; // cleanup

      task.history.push({
        action: "Deadline Approved",
        performedBy: assignerId,
        remarks: `New target date: ${new Date(task.deadline).toLocaleDateString()}`,
        timestamp: new Date()
      });

      const formattedDeadline = moment(task.deadline).format('DD MMM YYYY, hh:mm A');

      try {
        const fullDetails = `\n\n*Task:* ${task.title}\n*Description:* ${task.description || "No notes."}\n*Given By:* ${task.assignerId?.name}\n*Primary Doer:* ${task.doerId?.name}\n*Coordinator:* ${task.coordinatorId?.name || 'Admin'}\n*Support Team:* ${helperNames}\n*New Deadline:* ${formattedDeadline}\n*Urgency:* ${task.priority}\n*Files:* ${fileLinks}\n\n*Login Link:* ${loginLink}`;

        const message = `📅 *Extra Time Approved*\n\nHi [Name], the deadline for this task has been updated.` + fullDetails;

        if (task.doerId?.whatsappNumber) await sendWhatsAppMessage(task.doerId.whatsappNumber, message.replace("[Name]", task.doerId.name));
        if (task.assignerId?.whatsappNumber) await sendWhatsAppMessage(task.assignerId.whatsappNumber, message.replace("[Name]", task.assignerId.name));
        if (task.coordinatorId?.whatsappNumber) await sendWhatsAppMessage(task.coordinatorId.whatsappNumber, message.replace("[Name]", task.coordinatorId.name));

        for (const helper of helpers) {
          if (helper.whatsappNumber) {
            await sendWhatsAppMessage(helper.whatsappNumber, message.replace("[Name]", helper.name));
          }
        }

      } catch (waErr) {
        console.error("WA Error:", waErr.message);
      }
    }

    else if (action === 'Reassign') {

      const oldDoerName = task.doerId?.name || "Previous Staff";
      task.doerId = newDoerId;
      task.status = 'Pending';


      if (newDeadline) {
        task.deadline = new Date(newDeadline);
      }

      task.history.push({
        action: "Task Reassigned",
        performedBy: assignerId,
        remarks: `Work moved from ${oldDoerName} to new person. Reason: ${remarks}`,
        timestamp: new Date()
      });

      await task.save();

      const updatedTask = await DelegationTask.findById(taskId)
        .populate('doerId coordinatorId assignerId');

      const newDoer = updatedTask.doerId;

      const formattedDeadline = moment(updatedTask.deadline).format('DD MMM YYYY, hh:mm A');

      try {
        const fullTaskDetails = `\n\n*Task:* ${updatedTask.title}\n*Description:* ${updatedTask.description || "No notes."}\n*Given By:* ${updatedTask.assignerId?.name}\n*Primary Doer:* ${newDoer?.name}\n*Coordinator:* ${updatedTask.coordinatorId?.name || 'Admin'}\n*Support Team:* ${helperNames}\n*Deadline:* ${formattedDeadline}\n*Urgency:* ${updatedTask.priority}\n*Files:* ${fileLinks}\n\n*Login Link:* ${loginLink}`;

        const message = `🔄 *Work Reassigned*\n\nHi [Name], this task has been moved to ${newDoer?.name}.` + fullTaskDetails;

        if (newDoer?.whatsappNumber) await sendWhatsAppMessage(newDoer.whatsappNumber, message.replace("[Name]", newDoer.name));
        if (updatedTask.assignerId?.whatsappNumber) await sendWhatsAppMessage(updatedTask.assignerId.whatsappNumber, message.replace("[Name]", updatedTask.assignerId.name));
        if (updatedTask.coordinatorId?.whatsappNumber) await sendWhatsAppMessage(updatedTask.coordinatorId.whatsappNumber, message.replace("[Name]", updatedTask.coordinatorId.name));

        for (const helper of helpers) {
          if (helper.whatsappNumber) {
            await sendWhatsAppMessage(helper.whatsappNumber, message.replace("[Name]", helper.name));
          }
        }

      } catch (waErr) {
        console.error("WA Error:", waErr.message);
      }
    }

    await task.save();

    res.status(200).json({
      message: `Task ${action} successfully`,
      task
    });

  } catch (error) {
    console.error("Revision Error:", error.message);
    res.status(500).json({
      message: "Update failed",
      error: error.message
    });
  }
};


exports.respondToTask = async (req, res) => {
  try {
    // 1. SAFE DATA EXTRACTION
    const body = req.body || {};
    const { taskId, status, revisedDeadline, remarks, doerId } = body;

    // DEBUG LOGGING
    console.log("Incoming Respond Request:", {
      taskId,
      status,
      performerId: doerId,
      hasFile: !!req.file
    });

    if (!taskId) {
      return res.status(400).json({
        message: "Protocol Error: Task ID is missing. Ensure fields are sent before files in FormData."
      });
    }

    // Populate performer info for WhatsApp and Response logic
    const task = await DelegationTask.findById(taskId).populate('assignerId doerId coordinatorId');
    if (!task) return res.status(404).json({ message: "Task node not found." });

    // Handle Evidence Files (S3 or Local)
    let evidenceUrl = req.file ? (req.file.location || req.file.path) : null;

    // --- PRESERVE: POINTS & ACHIEVEMENT ENGINE ---
    try {
      if (status === 'Completed' || status === 'Verified') {
        const TenantModel = mongoose.model('Tenant');
        const EmployeeModel = mongoose.model('Employee');

        const tenant = await TenantModel.findById(task.tenantId);
        // Points are still anchored to the Primary Lead (task.doerId)
        const primaryLead = await EmployeeModel.findById(task.doerId);

        if (tenant?.pointSettings?.isActive && primaryLead && tenant.pointSettings.brackets?.length > 0) {
          const settings = tenant.pointSettings;
          const totalDurationMs = new Date(task.deadline) - new Date(task.createdAt);
          const totalDurationDays = totalDurationMs / (1000 * 60 * 60 * 24);

          const sortedBrackets = [...settings.brackets].sort((a, b) => a.maxDurationDays - b.maxDurationDays);
          const bracket = sortedBrackets.find(b => totalDurationDays <= b.maxDurationDays) || sortedBrackets[sortedBrackets.length - 1];

          if (bracket) {
            const completionDate = new Date();
            const deltaMs = new Date(task.deadline) - completionDate;
            const deltaHours = deltaMs / (1000 * 60 * 60);
            let pointsAwarded = 0;
            const unitMultiplier = bracket.pointsUnit === 'day' ? 24 : 1;

            if (deltaHours > 0) {
              pointsAwarded = Math.floor((deltaHours / unitMultiplier) * bracket.earlyBonus);
            } else if (deltaHours < 0) {
              pointsAwarded = -Math.floor((Math.abs(deltaHours) / unitMultiplier) * bracket.latePenalty);
            }

            primaryLead.totalPoints = (primaryLead.totalPoints || 0) + pointsAwarded;

            // Badge Processing Logic for Primary Lead
            if (tenant.badgeLibrary && tenant.badgeLibrary.length > 0) {
              tenant.badgeLibrary.forEach(badge => {
                const alreadyEarned = primaryLead.earnedBadges?.some(eb => eb.badgeId?.toString() === badge._id.toString());
                if (primaryLead.totalPoints >= badge.pointThreshold && !alreadyEarned) {
                  primaryLead.earnedBadges.push({
                    badgeId: badge._id, name: badge.name, iconName: badge.iconName,
                    color: badge.color, unlockedAt: new Date()
                  });
                }
              });
            }
            await primaryLead.save();

            // Assigner Reward (10% kickback)
            if (pointsAwarded > 0 && task.assignerId) {
              await EmployeeModel.findByIdAndUpdate(task.assignerId, {
                $inc: { totalPoints: Math.max(5, Math.floor(pointsAwarded * 0.1)) }
              });
            }

            // Record who triggered the points (Follower or Lead)
            task.history.push({
              action: 'Points Calculated',
              performedBy: doerId || task.doerId,
              timestamp: new Date(),
              remarks: `Points awarded to Lead (${primaryLead.name}): ${pointsAwarded > 0 ? '+' : ''}${pointsAwarded}`
            });
          }
        }
      }
    } catch (pointErr) {
      console.error("⚠️ Non-fatal Points Engine Error:", pointErr.message);
    }

    // 3. UPDATE TASK STATE & AUDIT LOG
    task.status = status;
    if (status === 'Revision Requested') {
      task.remarks = `New Date: ${revisedDeadline}. Reason: ${remarks}`;
    } else if (status === 'Completed') {
      task.remarks = remarks || "Work completed.";
    }

    if (evidenceUrl) {
      task.files.push({
        fileName: `Proof: ${req.file.originalname}`,
        fileUrl: evidenceUrl,
        uploadedAt: new Date()
      });
    }

    // CRITICAL: Records the exact person who clicked "Done"
    task.history.push({
      action: status,
      performedBy: doerId || task.doerId,
      timestamp: new Date(),
      remarks: remarks || `Mission telemetry synced to ${status}`
    });

    await task.save();

    // --- UPDATED: WHATSAPP NOTIFICATIONS (Using task_completion_alert) ---
    try {
      const TenantModel = mongoose.model('Tenant');
      const tenant = await TenantModel.findById(task.tenantId);
      const EmployeeModel = mongoose.model('Employee');
      const clicker = await EmployeeModel.findById(doerId);

      if (tenant?.whatsappConfig?.isActive && (status === 'Completed' || status === 'Verified')) {
        const companySubdomain = tenant?.subdomain || "portal";
        const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;
        const completionTime = moment().format('DD MMM, hh:mm A');

        /**
         * TEMPLATE: task_completion_alert
         * {{1}} - Doer Name (The person who finalized the work)
         * {{2}} - Task Title
         * {{3}} - Completion Time
         * {{4}} - Proof Link/Evidence
         * {{5}} - Ledger Review Link
         */
        const payload = {
          templateName: "task_completion_alert", // Matches your latest DoubleTick screenshot
          variables: [
            clicker?.name || task.doerId?.name, // {{1}}
            task.title,                           // {{2}}
            completionTime,                       // {{3}}
            evidenceUrl || "Text entry only",     // {{4}}
            loginLink                             // {{5}}
          ]
        };

        // Notify Assigner (The person who gave the work)
        if (task.assignerId?.whatsappNumber) {
          await sendWhatsAppMessage(task.assignerId.whatsappNumber, payload);
          console.log(`✅ Assigner Notified: ${task.assignerId.name}`);
        }

        // Notify Quality Coordinator (If assigned)
        if (task.coordinatorId?.whatsappNumber) {
          await sendWhatsAppMessage(task.coordinatorId.whatsappNumber, payload);
        }
      }
    } catch (waError) {
      console.error("⚠️ WhatsApp Notify Error:", waError.message);
    }

    // Populate performedBy names for the frontend History View
    const finalPopulatedTask = await DelegationTask.findById(task._id)
      .populate('assignerId doerId coordinatorId')
      .populate('history.performedBy', 'name');

    res.status(200).json({ message: "Registry updated successfully.", task: finalPopulatedTask });

  } catch (error) {
    console.error("❌ respondToTask CRITICAL ERROR:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
};
exports.getMappingOverview = async (req, res) => {
  try {
    const { tenantId } = req.params;

    // Verification
    const delegationCount = await DelegationTask.countDocuments({ tenantId });
    const checklistCount = await ChecklistTask.countDocuments({ tenantId });
    const employeeCount = await Employee.countDocuments({ tenantId });

    res.status(200).json({
      delegationCount,
      checklistCount,
      employeeCount
    });
  } catch (error) {
    console.error("Overview Fetch Error:", error.message);
    res.status(500).json({ message: error.message });
  }
};
exports.getCoordinatorMapping = async (req, res) => {
  try {
    const { tenantId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(tenantId)) {
      return res.status(400).json({ message: "Invalid Tenant ID format" });
    }

    // Parallel counts to feed the mapping dashboard cards
    const [delegations, checklists, employees] = await Promise.all([
      DelegationTask.countDocuments({ tenantId }),
      ChecklistTask.countDocuments({ tenantId }),
      Employee.countDocuments({ tenantId })
    ]);

    res.status(200).json({
      delegationCount: delegations,
      checklistCount: checklists,
      employeeCount: employees
    });

  } catch (error) {
    // If DelegationTask was not imported above, this error triggers the 500
    console.error("❌ getCoordinatorMapping Error:", error.message);
    res.status(500).json({
      message: "Server error in mapping fetch",
      error: error.message
    });
  }
};
// server/controllers/taskController.js


exports.createTask = async (req, res) => {

  // Ensure moment is available for deadline formatting

  const moment = require('moment');



  try {

    const taskData = { ...req.body };



    // --- PRESERVE: PARSE HELPER DOERS ---

    if (taskData.helperDoers && typeof taskData.helperDoers === 'string') {

      try {

        taskData.helperDoers = JSON.parse(taskData.helperDoers);

      } catch (e) {

        console.error("❌ Helper Doers Parse Error:", e.message);

        taskData.helperDoers = [];

      }

    }



    // --- PRESERVE: PROCESS FILES ---

    let uploadedFiles = [];

    if (req.files && req.files.length > 0) {

      uploadedFiles = req.files.map(file => ({

        fileName: file.originalname,

        fileUrl: file.location || file.path,

        uploadedAt: new Date()

      }));

    }

    taskData.files = uploadedFiles;



    // --- PRESERVE: DATA CLEANING ---

    if (!taskData.coordinatorId || taskData.coordinatorId === "" || taskData.coordinatorId === "null") {

      delete taskData.coordinatorId;

    }



    if (taskData.coworkers && typeof taskData.coworkers === 'string') {

      try {

        taskData.coworkers = JSON.parse(taskData.coworkers);

      } catch (e) {

        taskData.coworkers = [];

      }

    }



    // 2. Save to Database

    const newTask = new DelegationTask(taskData);

    newTask.history = [{

      action: "Task Created",

      performedBy: taskData.assignerId,

      timestamp: new Date(),

      remarks: `Work assigned with ${uploadedFiles.length} file(s).`

    }];



    await newTask.save();

    console.log(`✅ Task "${newTask.title}" saved.`);



    // --- UPDATED: WHATSAPP NOTIFICATIONS (ONLY TO DOER) ---

    try {

      const [assigner, doer, tenant] = await Promise.all([

        Employee.findById(newTask.assignerId),

        Employee.findById(newTask.doerId),

        Tenant.findById(newTask.tenantId)

      ]);



      const companySubdomain = tenant?.subdomain || "portal";

      //const briefingLink = `https://${companySubdomain}.lrbcloud.ai/login`;
      const briefingLink = `https://${companySubdomain}.lrbcloud.ai/dashboard/my-tasks`

      const formattedDeadline = moment(newTask.deadline).format('DD MMM YYYY, hh:mm A');



      /**

       * TEMPLATE MAPPING (Based on your new_task_delegation_v2 screenshot):

       * {{1}} - Employee Name

       * {{2}} - Task Title

       * {{3}} - Given By (Assigner Name)

       * {{4}} - Deadline

       * {{5}} - Priority

       * {{6}} - View Briefing Link

       */

      if (doer?.whatsappNumber) {

        const payload = {

          templateName: "new_task_delegation_v2", // Updated based on screenshot

          variables: [

            doer.name,                  // {{1}} Employee Name

            newTask.title,              // {{2}} Task Title

            assigner?.name || "Admin",  // {{3}} Given By

            formattedDeadline,          // {{4}} Deadline

            newTask.priority || "Normal",// {{5}} Priority

            briefingLink                // {{6}} Briefing Link

          ]

        };



        // Send to Primary Doer only

        await sendWhatsAppMessage(doer.whatsappNumber, payload);

        console.log(`🚀 Primary Doer Notified: ${doer.name}`);

      }



    } catch (waError) {

      console.error("⚠️ WhatsApp Notify Error:", waError.message);

    }



    res.status(201).json({ message: "Task Assigned & Doer Notified", task: newTask });



  } catch (error) {

    console.error("❌ Task Error:", error.message);

    res.status(500).json({ message: "Failed to create task", error: error.message });

  }

};



// Add this to server/controllers/taskController.js if not there
// server/controllers/taskController.js
exports.deleteChecklistTask = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Validate ID format to prevent server-side casting errors
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid Checklist ID provided." });
    }

    // 2. Execute deletion
    const deletedTask = await ChecklistTask.findByIdAndDelete(id);

    if (!deletedTask) {
      return res.status(404).json({ message: "Checklist not found in active registry." });
    }

    console.log(`🗑️ Node Purged: ${deletedTask.taskName}`);

    res.status(200).json({
      message: "Protocol successfully terminated and purged.",
      deletedId: id
    });
  } catch (error) {
    console.error("❌ Deletion Crash:", error.message);
    res.status(500).json({
      message: "Action failed: Node deletion error.",
      error: error.message
    });
  }
};
// server/controllers/taskController.js

exports.getChecklistTasks = async (req, res) => {
  try {
    const { doerId } = req.params;
    const now = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const allVisibleInstances = [];
    const instanceTracker = new Set();

    // 1. FETCH REQUESTER DATA
    const requester = await Employee.findById(doerId);
    if (!requester) return res.status(404).json({ message: "Employee not found" });

    const tenant = await Tenant.findById(requester.tenantId);
    const holidays = tenant?.holidays || [];
    const weekends = tenant?.weekends || [0];

    /**
     * 2. DEFINE AUTHORIZED SEARCH SCOPE
     * We need to find: 
     * A. The current user themselves.
     * B. Anyone who has assigned this user as their Buddy.
     */

    // Find staff who have the requester as their buddy (Always check dates, ignore toggle)
    const staffWhoAssignedMeAsBuddy = await Employee.find({
      'leaveStatus.buddyId': doerId
    }).select('_id name leaveStatus');

    const authorizedIdList = [
      doerId,
      ...staffWhoAssignedMeAsBuddy.map(s => s._id.toString())
    ];

    /**
     * 3. FETCH TASKS FOR ALL AUTHORIZED IDs
     */
    const tasks = await ChecklistTask.find({
      doerId: { $in: authorizedIdList },
      status: 'Active'
    }).populate('doerId', 'name workOnSunday leaveStatus');

    const moment = require('moment');
    const startOfTodayMoment = moment().startOf('day');
    const futureLimit = moment().startOf('day').add(10, 'days');

    for (const task of tasks) {
      const taskOwner = task.doerId;
      if (!taskOwner) {
        console.warn(`[CHECKLIST_DEBUG] Task ${task.taskName} has no doerId, skipping.`);
        continue;
      }
      const isBuddySubstitution = taskOwner._id.toString() !== doerId;

      let instancePointer = moment(task.nextDueDate).startOf('day');

      /**
       * NEW: DYNAMIC WEEKEND CALCULATION
       */
      let effectiveWeekends = [...weekends];
      if (taskOwner && taskOwner.workOnSunday) {
        effectiveWeekends = effectiveWeekends.filter(dayIndex => dayIndex !== 0);
      }

      let loopCount = 0;
      const maxLoops = 100;

      while (instancePointer.isSameOrBefore(futureLimit) && loopCount < maxLoops) {
        loopCount++;

        const instanceDateObj = instancePointer.toDate();
        const dateStr = instanceDateObj.toDateString();
        const instanceTimestamp = instancePointer.valueOf();

        /**
         * 4. HYBRID LEAVE FILTERING (Date-Driven with Toggle Fallback)
         * - If dates are present: Use strict date range.
         * - If dates are missing: Fallback to the 'onLeave' boolean toggle.
         */
        const getIsOnLeave = (emp, timestamp) => {
          const lstatus = emp?.leaveStatus;
          if (!lstatus) return false;
          if (lstatus.startDate && lstatus.endDate) {
            const s = moment(lstatus.startDate).startOf('day').valueOf();
            const e = moment(lstatus.endDate).endOf('day').valueOf();
            return timestamp >= s && timestamp <= e;
          }
          return lstatus.onLeave || false;
        };

        const ownerOnLeaveForThisDate = getIsOnLeave(taskOwner, instanceTimestamp);
        const requesterOnLeaveForThisDate = getIsOnLeave(requester, instanceTimestamp);

        // --- PROTOCOL JUMP ENGINE ---
        const getNextValidDate = (currentDate) => {
          return calculateNextDate(
            task.frequency,
            task.frequencyConfig || {},
            holidays,
            currentDate,
            false,
            effectiveWeekends
          );
        };

        // Logic split:
        if (requesterOnLeaveForThisDate) {
          // I (the requester) am on leave -> Hide EVERYTHING for this instance date
          const nextVal = getNextValidDate(instanceDateObj);
          if (!nextVal || moment(nextVal).isSameOrBefore(instancePointer)) break;
          instancePointer = moment(nextVal).startOf('day');
          continue;
        }

        if (ownerOnLeaveForThisDate) {
          if (!isBuddySubstitution) {
            // I am the owner, on leave -> Advance to next valid instance
            const nextVal = getNextValidDate(instanceDateObj);
            if (!nextVal || moment(nextVal).isSameOrBefore(instancePointer)) break;
            instancePointer = moment(nextVal).startOf('day');
            continue;
          }
          // I am the buddy, owner is on leave -> Show
        } else {
          if (isBuddySubstitution) {
            // I am the buddy, owner NOT on leave -> Advance to next valid instance
            const nextVal = getNextValidDate(instanceDateObj);
            if (!nextVal || moment(nextVal).isSameOrBefore(instancePointer)) break;
            instancePointer = moment(nextVal).startOf('day');
            continue;
          }
          // I am the owner, NOT on leave -> Show
        }

        // Skip Weekend/Holiday as before (Already handled by calculateNextDate for jumps, 
        // but nextDueDate itself might be on a weekend/holiday if manually set)
        const isHoliday = holidays.some(h => moment(h.date).format('YYYY-MM-DD') === instancePointer.format('YYYY-MM-DD'));
        const isWeekend = effectiveWeekends.includes(instancePointer.day());

        if (isHoliday || isWeekend) {
          const nextVal = getNextValidDate(instanceDateObj);
          if (!nextVal || moment(nextVal).isSameOrBefore(instancePointer)) break;
          instancePointer = moment(nextVal).startOf('day');
          continue;
        }

        const alreadyDone = task.history && task.history.some(h => {
          if (h.action !== "Completed" && h.action !== "Administrative Completion") return false;
          const historyDate = moment(h.instanceDate || h.timestamp).startOf('day');
          return historyDate.toDate().toDateString() === dateStr;
        });

        const isBacklog = instancePointer.isBefore(startOfTodayMoment);
        const taskNameKey = (task.taskName || "").toLowerCase().trim();
        const instanceKey = `${taskNameKey}-${dateStr}`;

        if (!instanceTracker.has(instanceKey)) {
          instanceTracker.add(instanceKey);

          if (!alreadyDone) {
            allVisibleInstances.push({
              ...task.toObject(),
              instanceDate: instanceDateObj,
              isBacklog: isBacklog,
              isBuddyTask: isBuddySubstitution,
              isDone: false,
              originalOwnerName: isBuddySubstitution ? taskOwner.name : null
            });
            break; // Break after first instance per task
          }
        } else {
          // If already in tracker, someone else (buddy or owner) took this slot
          // We don't push duplicates for the same card
        }

        const nextVal = getNextValidDate(instanceDateObj);
        if (!nextVal || moment(nextVal).isSameOrBefore(instancePointer)) break;
        instancePointer = moment(nextVal).startOf('day');
      }
    }

    const sorted = allVisibleInstances.sort((a, b) => new Date(a.instanceDate) - new Date(b.instanceDate));
    res.status(200).json(sorted);

  } catch (error) {
    console.error("❌ Checklist Routing Error:", error);
    res.status(500).json({ message: "Multi-card buddy generation failed", error: error.message });
  }
};

// DIAGNOSTIC ENDPOINT - Add this temporarily
exports.debugChecklistCards = async (req, res) => {
  try {
    const { doerId } = req.params;
    const now = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // UPDATED: Populate doerId to check workOnSunday
    const tasks = await ChecklistTask.find({ doerId, status: 'Active' })
      .populate('doerId', 'name workOnSunday'); // FIXED population

    const debugInfo = [];

    tasks.forEach(task => {
      let instancePointer = new Date(task.nextDueDate);
      instancePointer.setHours(0, 0, 0, 0);

      const worksSunday = task.doerId?.workOnSunday || false; // Debug flag

      const taskDebug = {
        taskName: task.taskName,
        nextDueDate: task.nextDueDate,
        frequency: task.frequency,
        worksSunday: worksSunday, // Log Sunday work state
        cards: []
      };

      let loopCount = 0;
      while (instancePointer <= startOfToday && loopCount < 10) {
        loopCount++;
        const dateStr = instancePointer.toDateString();

        const alreadyDone = task.history && task.history.some(h => {
          if (h.action !== "Completed" && h.action !== "Administrative Completion") return false;
          const historyDate = new Date(h.instanceDate || h.timestamp);
          historyDate.setHours(0, 0, 0, 0);
          return historyDate.toDateString() === dateStr;
        });

        taskDebug.cards.push({
          date: dateStr,
          instanceDate: instancePointer.toISOString(),
          alreadyDone,
          isBacklog: instancePointer < startOfToday,
          willCreateCard: !alreadyDone
        });

        if (task.frequency === 'Daily') {
          instancePointer.setDate(instancePointer.getDate() + 1);
        }
        instancePointer.setHours(0, 0, 0, 0);
      }

      debugInfo.push(taskDebug);
    });

    res.status(200).json({
      today: startOfToday.toDateString(),
      debugInfo
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
exports.getReviewAnalytics = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { view = 'Weekly', date = new Date() } = req.query;

    const now = new Date();
    const referenceDate = new Date(date);
    let startDate = new Date(referenceDate);
    let endDate = new Date(referenceDate);

    // 1. TIMELINE BOUNDARIES
    if (view === 'Daily') {
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
    } else if (view === 'Weekly') {
      const day = startDate.getDay();
      const diff = startDate.getDate() - day + (day === 0 ? -6 : 1);
      startDate.setDate(diff);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
    } else {
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
    }

    // UPDATED: Added 'weeklyLateTarget' to select
    const [employees, delegations, checklists] = await Promise.all([
      Employee.find({ tenantId }).select('name department weeklyLateTarget'),
      DelegationTask.find({ tenantId, deadline: { $gte: startDate, $lte: endDate } }),
      ChecklistTask.find({ tenantId, status: 'Active' })
    ]);

    const report = employees.map(emp => {
      const stats = {
        // CRITICAL: Added fields for Frontend Deep-Dive targeting
        employeeId: emp._id,
        employeeName: emp.name,
        department: emp.department,
        weeklyLateTarget: emp.weeklyLateTarget || 20,
        periodStart: startDate.toISOString(),
        periodEnd: endDate.toISOString(),
        periodName: view === 'Weekly' ? `Week of ${startDate.toLocaleDateString()}` : view,

        delegation: { total: 0, done: 0, overdue: 0, late: 0, notDone: 0 },
        checklist: { total: 0, done: 0, overdue: 0, late: 0, notDone: 0 }
      };

      // 2. DELEGATION PROCESSING
      const empDelegations = delegations.filter(t => t.doerId && t.doerId.toString() === emp._id.toString());
      empDelegations.forEach(t => {
        stats.delegation.total++;
        const doneRecord = t.history.find(h => h.action === 'Completed' || h.action === 'Verified');

        if (doneRecord) {
          stats.delegation.done++;
          if (new Date(doneRecord.timestamp) > new Date(t.deadline)) {
            stats.delegation.late++;
          }
        } else {
          stats.delegation.notDone++;
          if (new Date(t.deadline) < now) {
            stats.delegation.overdue++;
          }
        }
      });

      // 3. CHECKLIST PROCESSING
      const empChecklists = checklists.filter(t => t.doerId && t.doerId.toString() === emp._id.toString());
      empChecklists.forEach(t => {
        let expected = 0;
        if (t.frequency === 'Daily') expected = view === 'Weekly' ? 7 : (view === 'Daily' ? 1 : 30);
        else if (t.frequency === 'Weekly') expected = view === 'Monthly' ? 4 : 1;
        else expected = 1;

        const rangeCompletions = t.history.filter(h =>
          (h.action === 'Completed' || h.action === 'Administrative Completion') &&
          new Date(h.timestamp) >= startDate && new Date(h.timestamp) <= endDate
        );

        stats.checklist.total += expected;
        stats.checklist.done += rangeCompletions.length;

        let missedCount = Math.max(0, expected - rangeCompletions.length);
        stats.checklist.notDone += missedCount;

        rangeCompletions.forEach(h => {
          const instanceDueDate = new Date(h.instanceDate || h.timestamp);
          if (new Date(h.timestamp).toDateString() !== instanceDueDate.toDateString() && new Date(h.timestamp) > instanceDueDate) {
            stats.checklist.late++;
          }
        });

        const effectiveEndDate = endDate < now ? endDate : now;
        if (missedCount > 0 && effectiveEndDate >= startDate) {
          stats.checklist.overdue += missedCount;
        }
      });

      return stats;
    });

    res.status(200).json({ view, startDate, endDate, report });
  } catch (error) {
    console.error("Analytics Calculation Error:", error);
    res.status(500).json({ message: "Analytics calculation failed" });
  }
};
