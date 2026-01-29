// server/controllers/taskController.js
const DelegationTask = require('../models/DelegationTask');
const Employee = require('../models/Employee'); // Ensure you import the Employee model
const Tenant = require('../models/Tenant');
const mongoose = require('mongoose');
const sendWhatsAppMessage = require('../utils/whatsappNotify');


const ChecklistTask = require('../models/ChecklistTask'); // The Model
const { calculateNextDate } = require('../utils/scheduler'); // The Math


exports.getDoerTasks = async (req, res) => {
  try {
      const { doerId } = req.params;

      // 1. Validation: Prevent crash if ID is malformed
      if (!mongoose.Types.ObjectId.isValid(doerId)) {
          
          return res.status(400).json({ message: "Invalid Doer ID format" });
      }

      // 2. Fetch tasks where the user is the 'doerId'
      // We populate assignerId so the Doer knows who gave the task
      const tasks = await DelegationTask.find({ doerId: doerId })
          .populate('assignerId', 'name email')
          .populate('coordinatorId', 'name')
          .sort({ createdAt: -1 });


      res.status(200).json(tasks);
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

      /**
       * CRITICAL FILTER: We query ONLY the DelegationTask collection.
       * Routine doer checklists are stored in a separate 'ChecklistTask' collection 
       * and will be automatically excluded by this query.
       */
      const tasks = await DelegationTask.find({ assignerId: assignerId })
          .populate('doerId', 'name department roles email') // Populate Doer info
          .populate('coordinatorId', 'name')                 // Populate Coordinator info
          .populate('assignerId', 'name')                    // Populate Assigner info
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
     * req.body is populated by Multer (upload.single('evidence'))
     */
    const { checklistId, remarks, completedBy, instanceDate } = req.body;
    
    // CRITICAL: Populate doerId to include the performer's name in notifications
    const task = await ChecklistTask.findById(checklistId).populate('doerId');

    if (!task) return res.status(404).json({ message: "Task not found" });

    const now = new Date();
    
    /**
     * TACTICAL INSTANCE TARGETING
     * We use the specific date sent from the card (e.g., 21 Jan).
     * This ensures that marking 21 Jan does not conflict with 22 Jan.
     */
    const targetDate = instanceDate ? new Date(instanceDate) : new Date();
    // Normalize target date to start of day for accurate comparison
    targetDate.setHours(0, 0, 0, 0);

    // 2. Fetch Factory/Tenant settings for scheduling logic
    const tenant = await Tenant.findById(task.tenantId);
    const holidays = tenant ? tenant.holidays : [];

    // 3. Update core tracking fields
    task.lastCompleted = now;

    // 4. Update the Audit History Log with Instance precision
    if (!task.history) task.history = [];
    
    // IMPROVED: Store the exact instanceDate for precise tracking
    task.history.push({
      action: "Completed",
      timestamp: now, // When the action was actually performed
      instanceDate: new Date(targetDate), // Which day's card was completed
      remarks: remarks || (instanceDate ? `Backlog catch-up for ${targetDate.toDateString()}` : "Daily routine finished."), 
      attachmentUrl: req.file ? (req.file.location || req.file.path) : null, 
      completedBy: completedBy || task.doerId 
    });

    /**
     * 5. SMART POINTER ADVANCEMENT
     * We only move 'nextDueDate' forward if the doer finished the EXACT date 
     * that the pointer was currently waiting for. 
     * 
     * IMPROVED LOGIC:
     * - If completing today's card → advance pointer to next occurrence
     * - If completing a backlog card → pointer stays at current position
     * - This allows multiple cards to exist simultaneously
     */
    const currentNextDue = new Date(task.nextDueDate);
    currentNextDue.setHours(0, 0, 0, 0);
    
    if (targetDate.toDateString() === currentNextDue.toDateString()) {
        // They completed the current "nextDueDate" card, so advance the pointer
        task.nextDueDate = calculateNextDate(
          task.frequency, 
          task.frequencyConfig || {}, 
          holidays,
          new Date(targetDate),
          false,
          tenant.weekends || [0] // Pass weekends array
      );
    }
    // CRITICAL: If targetDate is in the past (backlog), we DON'T advance nextDueDate
    // This ensures today's card remains visible even after completing yesterday's card

    await task.save();

    console.log(`✅ Checklist "${task.taskName}" for ${targetDate.toDateString()} completed.`);

    // --- PRESERVED: WHATSAPP NOTIFICATIONS FOR ALL PARTIES ---
    try {
      const companySubdomain = tenant?.subdomain || "portal"; 
      const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;

      // Format date for better readability in messages
      const formattedInstanceDate = targetDate.toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });

      const coordinator = task.coordinatorId ? await Employee.findById(task.coordinatorId) : null;
      const helperIds = Array.isArray(task.helperDoers) ? task.helperDoers.map(h => h.helperId) : [];
      const helpers = helperIds.length > 0 ? await Employee.find({ _id: { $in: helperIds } }) : [];
      const helperNames = helpers.map(h => h.name).join(", ") || "None";

      // Evidence handling for message body
      const evidenceLink = req.file ? `\n📎 Work Proof: ${req.file.location || req.file.path}` : "\nNo proof attached.";

      const fullTaskDetails = `\n\n` +
        `*Task Name:* ${task.taskName}\n` +
        `*For Date:* ${formattedInstanceDate}\n` +
        `*Done By:* ${task.doerId?.name || 'Staff member'}\n` +
        `*Coordinator:* ${coordinator?.name || 'Admin'}\n` +
        `*Support Team:* ${helperNames}\n` +
        `*Recorded At:* ${now.toLocaleTimeString()}\n` +
        `*Proof:* ${evidenceLink}\n\n` +
        `*Login Link:* ${loginLink}`;

      // A. Notify Admin
      if (tenant && tenant.adminEmail) {
        const adminNode = await Employee.findOne({ email: tenant.adminEmail, tenantId: tenant._id });
        if (adminNode?.whatsappNumber) {
          const adminMsg = `📋 *Routine Entry: ${formattedInstanceDate}*` + fullTaskDetails;
          await sendWhatsAppMessage(adminNode.whatsappNumber, adminMsg);
        }
      }

      // B. Notify the Primary Doer
      if (task.doerId?.whatsappNumber) {
        const doerMsg = `✅ *Work Saved for ${formattedInstanceDate}*` + fullTaskDetails;
        await sendWhatsAppMessage(task.doerId.whatsappNumber, doerMsg);
      }

      // C. Notify Quality Coordinator
      if (coordinator?.whatsappNumber) {
        const coordMsg = `🛡️ *Routine Verified: ${formattedInstanceDate}*` + fullTaskDetails;
        await sendWhatsAppMessage(coordinator.whatsappNumber, coordMsg);
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
      const { taskName, description, doerId, status } = req.body;

      /**
       * 2. EXECUTE ATOMIC UPDATE
       * We use $set to target specific fields, including the description.
       * { new: true } ensures the response contains the modified record.
       */
      const updatedTask = await ChecklistTask.findByIdAndUpdate(
          id,
          { 
              $set: { 
                  taskName, 
                  description: description || "", // FIXED: Now strictly included in updates
                  doerId, 
                  status 
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
        ? task.files.map((f, i) => `\n📎 Ref ${i+1}: ${f.fileUrl}`).join("") 
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

// 2. Updated: Manual Dashboard Reminder
exports.sendWhatsAppReminder = async (req, res) => {
  try {
    const { whatsappNumber, taskTitle, customMessage, taskId } = req.body;
    
    // Fetch full details for the reminder
    const task = await DelegationTask.findById(taskId)
      .populate('assignerId doerId coordinatorId');
    
    const tenant = await Tenant.findById(task.tenantId);
    const companySubdomain = tenant?.subdomain || "portal"; 
    const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;

    const formattedDeadline = task.deadline ? new Date(task.deadline).toLocaleDateString('en-IN') : "N/A";
    
    const helperIds = Array.isArray(task.helperDoers) ? task.helperDoers.map(h => h.helperId) : [];
    const helpers = await Employee.find({ _id: { $in: helperIds } });
    const helperNames = helpers.map(h => h.name).join(", ") || "None";

    const fullTaskDetails = `\n\n` +
      `*Work Name:* ${task.title}\n` +
      `*Given By:* ${task.assignerId?.name}\n` +
      `*Primary Doer:* ${task.doerId?.name}\n` +
      `*Coordinator:* ${task.coordinatorId?.name || 'Admin'}\n` +
      `*Support Team:* ${helperNames}\n` +
      `*Deadline:* ${formattedDeadline}\n` +
      `*Priority:* ${task.priority}\n\n` +
      `*Check Status here:* ${loginLink}`;

    const finalMsg = `🔔 *Work Reminder*\n\n${customMessage || "Please update your task status."}` + fullTaskDetails;

    // Dispatch to the specific number (Doer)
    await sendWhatsAppMessage(whatsappNumber, finalMsg);

    res.status(200).json({ message: "Reminder sent successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Reminder failed", error: error.message });
  }
};

// server/controllers/taskController.js

exports.getCoordinatorTasks = async (req, res) => {
  try {
    const { coordinatorId } = req.params;

    // 1. Find the Coordinator to identify managed staff (the "flock")
    const coordinator = await Employee.findById(coordinatorId);
    if (!coordinator) return res.status(404).json({ message: "Coordinator not found" });

    // 2. Identify the list of staff IDs this coordinator is authorized to monitor
    const monitoredStaffIds = coordinator.managedAssigners || [];

    /**
     * 3. UNIFIED DATA ACQUISITION:
     * Fetch tasks where monitored staff are either the ASSIGNER OR the DOER.
     * This ensures tasks like Murthy's (where he is the Doer) are captured.
     */
    const [delegationTasks, checklistTasks] = await Promise.all([
      DelegationTask.find({ 
        $or: [
          { assignerId: { $in: monitoredStaffIds } },
          { doerId: { $in: monitoredStaffIds } }
        ]
      })
      .populate('assignerId', 'name role')
      .populate('doerId', 'name role whatsappNumber')
      .lean(),

      ChecklistTask.find({ 
        doerId: { $in: monitoredStaffIds } 
      })
      .populate('doerId', 'name department whatsappNumber')
      .lean()
    ]);

    // 4. Normalization: Tagging and mapping fields for UI consistency
    const normalizedChecklists = checklistTasks.map(t => ({
      ...t,
      title: t.taskName, // Standardize taskName to title for the frontend table
      deadline: t.nextDueDate, // Standardize nextDueDate to deadline for the frontend table
      taskType: 'Checklist'
    }));

    const normalizedDelegations = delegationTasks.map(t => ({
      ...t,
      taskType: 'Delegation'
    }));

    // 5. Merge and Chronological Sort (Closest deadlines first)
    const allTasks = [...normalizedDelegations, ...normalizedChecklists].sort(
      (a, b) => new Date(a.deadline) - new Date(b.deadline)
    );

    res.status(200).json(allTasks);
  } catch (error) {
    console.error("Coordinator Unified Fetch Error:", error.message);
    res.status(500).json({ message: "Error fetching tracking data", error: error.message });
  }
};

  exports.handleRevision = async (req, res) => {
    try {
        const { taskId, action, newDeadline, newDoerId, remarks, assignerId } = req.body;
        
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
        const formattedDeadline = new Date(newDeadline || task.deadline).toLocaleDateString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        const helperIds = Array.isArray(task.helperDoers) ? task.helperDoers.map(h => h.helperId) : [];
        const helpers = helperIds.length > 0 ? await Employee.find({ _id: { $in: helperIds } }) : [];
        const helperNames = helpers.map(h => h.name).join(", ") || "None";

        const fileLinks = task.files && task.files.length > 0 
            ? task.files.map((f, i) => `\n📎 Ref ${i+1}: ${f.fileUrl}`).join("") 
            : "\nNo attachments provided.";

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
                const fullDetails = `\n\n*Task:* ${updatedTask.title}\n*Description:* ${updatedTask.description || "No notes."}\n*Given By:* ${updatedTask.assignerId?.name}\n*Primary Doer:* ${newDoer?.name}\n*Coordinator:* ${updatedTask.coordinatorId?.name || 'Admin'}\n*Support Team:* ${helperNames}\n*Deadline:* ${formattedDeadline}\n*Urgency:* ${updatedTask.priority}\n*Files:* ${fileLinks}\n\n*Login Link:* ${loginLink}`;
                
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


exports.respondToTask = async (req, res) => {
  try {
    // 1. SAFE DATA EXTRACTION
    // Safe extraction to prevent "Cannot destructure" error if body is delayed
    const body = req.body || {};
    const { taskId, status, revisedDeadline, remarks, doerId } = body;
    
    // DEBUG LOGGING
    console.log("Incoming Respond Request:", { 
      taskId, 
      status, 
      hasFile: !!req.file,
      bodyKeys: Object.keys(body) 
    });

    if (!taskId) {
      return res.status(400).json({ 
        message: "Protocol Error: Task ID is missing. Ensure fields are sent before files in FormData." 
      });
    }

    const task = await DelegationTask.findById(taskId).populate('assignerId doerId coordinatorId');
    if (!task) return res.status(404).json({ message: "Task node not found." });

    // Handle Evidence Files (S3 or Local)
    let evidenceUrl = req.file ? (req.file.location || req.file.path) : null;

    // --- POINTS & ACHIEVEMENT ENGINE (Wrapped for Stability) ---
    try {
      if (status === 'Completed' || status === 'Verified') {
        const TenantModel = mongoose.model('Tenant');
        const EmployeeModel = mongoose.model('Employee');
        
        const tenant = await TenantModel.findById(task.tenantId);
        const employee = await EmployeeModel.findById(task.doerId);
        
        if (tenant?.pointSettings?.isActive && employee && tenant.pointSettings.brackets?.length > 0) {
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

            employee.totalPoints = (employee.totalPoints || 0) + pointsAwarded;

            // Badge Processing Logic
            if (tenant.badgeLibrary && tenant.badgeLibrary.length > 0) {
              tenant.badgeLibrary.forEach(badge => {
                const alreadyEarned = employee.earnedBadges?.some(eb => eb.badgeId?.toString() === badge._id.toString());
                if (employee.totalPoints >= badge.pointThreshold && !alreadyEarned) {
                  employee.earnedBadges.push({
                    badgeId: badge._id, name: badge.name, iconName: badge.iconName,
                    color: badge.color, unlockedAt: new Date()
                  });
                }
              });
            }
            await employee.save(); 

            // Assigner Reward (10% kickback)
            if (pointsAwarded > 0 && task.assignerId) {
              await EmployeeModel.findByIdAndUpdate(task.assignerId, { 
                $inc: { totalPoints: Math.max(5, Math.floor(pointsAwarded * 0.1)) } 
              });
            }

            task.history.push({
              action: 'Points Calculated', 
              performedBy: doerId || task.doerId,
              timestamp: new Date(), 
              remarks: `Points: ${pointsAwarded > 0 ? '+' : ''}${pointsAwarded}`
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

    task.history.push({
      action: status,
      performedBy: doerId || task.doerId,
      timestamp: new Date(),
      remarks: remarks || `Task state synchronized to ${status}`
    });

    await task.save();

    // --- WHATSAPP NOTIFICATIONS (Wrapped for Stability) ---
    try {
      const TenantModel = mongoose.model('Tenant');
      const tenant = await TenantModel.findById(task.tenantId);
      const companySubdomain = tenant?.subdomain || "portal"; 
      const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;

      const fullTaskDetails = `\n\n*Task:* ${task.title}\n*Status:* ${status}\n*Personnel:* ${task.doerId?.name}\n\n*View Ledger:* ${loginLink}`;

      if (task.assignerId?.whatsappNumber) {
        await sendWhatsAppMessage(task.assignerId.whatsappNumber, `🛡️ *Node Update*` + fullTaskDetails);
      }
    } catch (waError) {
      console.error("⚠️ Non-fatal WhatsApp Notify Error:", waError.message);
    }

    res.status(200).json({ message: "Registry updated successfully.", task });

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
  try {
    // 1. Prepare task data from the request
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

    // --- PRESERVE: PROCESS FILES (S3 OR LOCAL) ---
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

    // 2. Initialize the Mongoose Model
    const newTask = new DelegationTask(taskData);
    
    // --- PRESERVE: INITIALIZE AUDIT HISTORY ---
    newTask.history = [{
      action: "Task Created",
      performedBy: taskData.assignerId,
      timestamp: new Date(),
      remarks: `Work assigned with ${uploadedFiles.length} file(s).`
    }];

    // 3. Save to Database
    await newTask.save();
    
    console.log(`✅ Task "${newTask.title}" saved.`);

    // --- UPDATED: WHATSAPP NOTIFICATIONS FOR ALL PARTIES ---
    try {
      // Find Assigner, Primary Doer, and Tenant details
      const [assigner, doer, tenant] = await Promise.all([
        Employee.findById(newTask.assignerId),
        Employee.findById(newTask.doerId),
        Tenant.findById(newTask.tenantId)
      ]);

      // Find Coordinator details if assigned
      const coordinator = newTask.coordinatorId ? await Employee.findById(newTask.coordinatorId) : null;

      // 4. GENERATE DYNAMIC LOGIN LINK USING SUBDOMAIN
      const companySubdomain = tenant?.subdomain || "portal"; 
      const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;

      const formattedDeadline = new Date(newTask.deadline).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });

      // 5. MAP SUPPORT TEAM NAMES AND FETCH THEIR PHONE NUMBERS
      const helperIds = Array.isArray(newTask.helperDoers) ? newTask.helperDoers.map(h => h.helperId) : [];
      const helpers = helperIds.length > 0 ? await Employee.find({ _id: { $in: helperIds } }) : [];
      const helperNames = helpers.map(h => h.name).join(", ") || "None";

      // 6. PREPARE FILE LINKS
      const fileLinks = uploadedFiles.length > 0 
        ? uploadedFiles.map((f, i) => `\n📎 File ${i+1}: ${f.fileUrl}`).join("") 
        : "\nNo attachments provided.";

      // FULL DETAILS BLOCK (Simple Language)
      const fullTaskDetails = `\n\n` +
        `*Task Title:* ${newTask.title}\n` +
        `*Description:* ${newTask.description || "No extra notes."}\n` +
        `*Given By:* ${assigner?.name || 'Admin'}\n` +
        `*Primary Doer:* ${doer?.name || 'Staff'}\n` +
        `*Coordinator:* ${coordinator?.name || 'Self-Track'}\n` +
        `*Support Team:* ${helperNames}\n` +
        `*Expected Completion:* ${formattedDeadline}\n` +
        `*Urgency Level:* ${newTask.priority}\n` +
        `*Files:* ${fileLinks}\n\n` +
        `*Login Link:* ${loginLink}`;

      // --- DISPATCH MESSAGES ---

      // A. Notify Primary Doer
      if (doer?.whatsappNumber) {
        const doerMsg = `🚀 *New Task Assigned*\n\nHi ${doer.name}, you are the Lead for this task.` + fullTaskDetails;
        await sendWhatsAppMessage(doer.whatsappNumber, doerMsg);
      }

      // B. Notify Quality Coordinator
      if (coordinator?.whatsappNumber) {
        const coordMsg = `🛡️ *Quality Check Assigned*\n\nHi ${coordinator.name}, you are the Coordinator for this new task.` + fullTaskDetails;
        await sendWhatsAppMessage(coordinator.whatsappNumber, coordMsg);
      }

      // C. Notify Support Team (Helpers)
      if (helpers.length > 0) {
        for (const helper of helpers) {
          if (helper.whatsappNumber) {
            const helperMsg = `🤝 *Support Team Request*\n\nHi ${helper.name}, you have been added as a Helper for this task.` + fullTaskDetails;
            await sendWhatsAppMessage(helper.whatsappNumber, helperMsg);
          }
        }
      }

      // D. Notify Assigner
      if (assigner?.whatsappNumber) {
        const assignerMsg = `📤 *Task Dispatched*\n\nHi ${assigner.name}, your work assignment has been sent to everyone.` + fullTaskDetails;
        await sendWhatsAppMessage(assigner.whatsappNumber, assignerMsg);
      }

    } catch (waError) {
      console.error("⚠️ WhatsApp Notify Error:", waError.message);
    }

    // 7. Return success to frontend
    res.status(201).json({ 
      message: "Task Assigned & Group Notifications Sent", 
      task: newTask 
    });

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

    // 1. FETCH REQUESTER DATA
    const requester = await Employee.findById(doerId);
    if (!requester) return res.status(404).json({ message: "Employee not found" });

    const tenant = await Tenant.findById(requester.tenantId);
    const holidays = tenant?.holidays || [];
    const weekends = tenant?.weekends || [0];

    /**
     * 2. DEFINE TASK VISIBILITY LIST
     */
    let authorizedIdList = [];

    // A. Verify if the requester themselves is currently on leave
    const requesterIsOnLeave = 
      requester.leaveStatus?.onLeave && 
      new Date(requester.leaveStatus.startDate) <= now && 
      new Date(requester.leaveStatus.endDate) >= startOfToday;

    // If NOT on leave, they see their own tasks
    if (!requesterIsOnLeave) {
      authorizedIdList.push(doerId);
    }

    // B. Find anyone who has assigned THIS requester as their Buddy and is currently away
    const staffOnLeave = await Employee.find({
      'leaveStatus.buddyId': doerId,
      'leaveStatus.onLeave': true,
      'leaveStatus.startDate': { $lte: now },
      'leaveStatus.endDate': { $gte: startOfToday }
    }).select('_id name');

    // Add those IDs to the list so their tasks flow to the Buddy's dashboard
    const substitutedIds = staffOnLeave.map(s => s._id.toString());
    authorizedIdList = [...authorizedIdList, ...substitutedIds];

    /**
     * 3. FETCH TASKS FOR ALL AUTHORIZED IDs
     */
    const tasks = await ChecklistTask.find({ 
      doerId: { $in: authorizedIdList }, 
      status: 'Active' 
    }).populate('doerId', 'name');

    let allVisibleInstances = [];

    tasks.forEach((task) => {
      let instancePointer = new Date(task.nextDueDate);
      instancePointer.setHours(0, 0, 0, 0);
      
      let loopCount = 0;
      const maxLoops = 30;

      while (instancePointer <= startOfToday && loopCount < maxLoops) {
        loopCount++;
        const dateStr = instancePointer.toDateString();
        
        // Check if this specific date instance was already completed
        const alreadyDone = task.history && task.history.some(h => {
          if (h.action !== "Completed" && h.action !== "Administrative Completion") return false;
          const historyDate = new Date(h.instanceDate || h.timestamp);
          historyDate.setHours(0, 0, 0, 0);
          return historyDate.toDateString() === dateStr;
        });

        if (!alreadyDone) {
          const isBacklog = instancePointer < startOfToday;
          
          /**
           * 4. SUBSTITUTION TAGGING
           * Flag tasks that belong to the person on leave so the Buddy knows
           * who they are covering for.
           */
          const isBuddySubstitution = task.doerId._id.toString() !== doerId;

          allVisibleInstances.push({
            ...task.toObject(),
            instanceDate: new Date(instancePointer),
            isBacklog: isBacklog,
            isBuddyTask: isBuddySubstitution,
            originalOwnerName: isBuddySubstitution ? task.doerId.name : null
          });
        }

        /**
         * 5. SMART POINTER ADVANCEMENT
         * Respects factory-defined weekends and holidays during generation.
         */
        const nextVal = calculateNextDate(
          task.frequency, 
          task.frequencyConfig || {}, 
          holidays,
          new Date(instancePointer),
          false, 
          weekends 
        );
        
        if (!nextVal || nextVal <= instancePointer) break;
        
        instancePointer = new Date(nextVal);
        instancePointer.setHours(0, 0, 0, 0);
      }
    });

    // Final sorting: Oldest backlog items appear at the top
    const sorted = allVisibleInstances.sort((a, b) => a.instanceDate - b.instanceDate);
    
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

    const tasks = await ChecklistTask.find({ doerId, status: 'Active' });
    const debugInfo = [];

    tasks.forEach(task => {
      let instancePointer = new Date(task.nextDueDate);
      instancePointer.setHours(0, 0, 0, 0);
      
      const taskDebug = {
        taskName: task.taskName,
        nextDueDate: task.nextDueDate,
        frequency: task.frequency,
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

    const [employees, delegations, checklists] = await Promise.all([
      Employee.find({ tenantId }).select('name department'),
      DelegationTask.find({ tenantId, deadline: { $gte: startDate, $lte: endDate } }),
      ChecklistTask.find({ tenantId, status: 'Active' })
    ]);

    const report = employees.map(emp => {
      const stats = {
        employeeName: emp.name,
        department: emp.department,
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
          // If the work was finished but AFTER the deadline, it's Late
          if (new Date(doneRecord.timestamp) > new Date(t.deadline)) {
            stats.delegation.late++;
          }
        } else {
          stats.delegation.notDone++;
          // If it's not done and today is past the deadline, it's Overdue
          if (new Date(t.deadline) < now) {
            stats.delegation.overdue++;
          }
        }
      });

      // 3. CHECKLIST PROCESSING (Daily/Weekly frequency logic)
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
        
        // Calculate work not done
        let missedCount = Math.max(0, expected - rangeCompletions.length);
        stats.checklist.notDone += missedCount;

        // CHECKLIST OVERDUE & LATE LOGIC
        rangeCompletions.forEach(h => {
           const instanceDueDate = new Date(h.instanceDate || h.timestamp);
           // If the submission happened on a day later than the instance's intended date
           if (new Date(h.timestamp).toDateString() !== instanceDueDate.toDateString() && new Date(h.timestamp) > instanceDueDate) {
              stats.checklist.late++;
           }
        });

        // Current instances missed that are already in the past
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

