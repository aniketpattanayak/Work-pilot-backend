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
          console.error("❌ Invalid Doer ID received:", doerId);
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
      console.error("❌ Error in getDoerTasks:", error.message);
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

    // --- NEW: FETCH EMPLOYEE DATA (For Points & Badges) ---
    // We need to import the Employee model if not already at the top of the file
    const Employee = require('../models/Employee');
    const employee = await Employee.findById(employeeId);

    // 1. Fetch all tasks for this doer
    // Note: Removed 'Completed' filter to match your 'Verified' tasks in screenshots
    const tasks = await DelegationTask.find({ 
      doerId: employeeId,
      $or: [{ status: 'Completed' }, { status: 'Verified' }]
    });

    if (!tasks || tasks.length === 0) {
      return res.json({ 
        score: 0, 
        totalPoints: employee ? employee.totalPoints : 0,
        earnedBadges: employee ? employee.earnedBadges : [],
        message: "No tasks found for this node." 
      });
    }

    let onTimeCount = 0;
    
    tasks.forEach(task => {
      // Find the "Completed" entry in history
      const completionEntry = task.history.find(h => h.action === 'Completed' || h.action.includes('Done'));
      
      if (completionEntry) {
        // Compare completion time with the deadline
        if (new Date(completionEntry.timestamp) <= new Date(task.deadline)) {
          onTimeCount++;
        }
      }
    });

    const scorePercentage = (onTimeCount / tasks.length) * 100;

    // --- UPDATED RESPONSE OBJECT ---
    res.status(200).json({
      totalTasks: tasks.length,
      onTimeTasks: onTimeCount,
      score: scorePercentage.toFixed(2), // This drives the Efficiency %
      
      // CRITICAL: These fields drive the Top Right Scoreboard
      totalPoints: employee ? employee.totalPoints : 0, 
      earnedBadges: employee ? employee.earnedBadges : [],
      
      notDoneOnTime: tasks.length - onTimeCount
    });
  } catch (error) {
    console.error("Score Error:", error.message);
    res.status(500).json({ message: "Score calculation failed", error: error.message });
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
    const { checklistId, remarks, completedBy } = req.body;
    
    // CRITICAL: We populate doerId to include the performer's name in the notification
    const task = await ChecklistTask.findById(checklistId).populate('doerId');

    if (!task) return res.status(404).json({ message: "Task not found" });

    const now = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0); 

    /**
     * --- DATE-WISE INTEGRITY CHECK ---
     * Prevents staff from marking an expired/missed task as 'Done' today
     */
    if (new Date(task.nextDueDate) < startOfToday) {
      return res.status(400).json({ 
        message: "This task has already expired. You cannot mark it as done today." 
      });
    }

    // 2. Fetch Factory/Tenant settings to calculate next occurrence
    const tenant = await Tenant.findById(task.tenantId);
    const holidays = tenant ? tenant.holidays : [];

    // 3. Update the last completion timestamp
    task.lastCompleted = now;

    // 4. Update the Audit History Log
    if (!task.history) task.history = [];
    
    task.history.push({
      action: "Completed",
      timestamp: now,
      remarks: remarks || "Daily routine finished.", 
      attachmentUrl: req.file ? (req.file.location || req.file.path) : null, 
      completedBy: completedBy || task.doerId 
    });

    // 5. Schedule the Next Task Occurrence
    task.nextDueDate = calculateNextDate(
      task.frequency, 
      task.frequencyConfig || {}, 
      holidays
    );

    await task.save();

    console.log(`✅ Checklist "${task.taskName}" completed. Next due: ${task.nextDueDate.toDateString()}`);

    // --- UPDATED: WHATSAPP NOTIFICATIONS FOR ALL PARTIES ---
    try {
      /**
       * 4. DYNAMIC SUBDOMAIN URL LOGIC
       * Uses the 'subdomain' field from TenantSchema
       */
      const companySubdomain = tenant?.subdomain || "portal"; 
      const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;

      const formattedNextDate = new Date(task.nextDueDate).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });

      // Find Quality Coordinator and Support Team if they exist for this routine
      // NOTE: ChecklistTask model typically links to a doerId; 
      // if you store helpers/coordinators here too, they are fetched now.
      const coordinator = task.coordinatorId ? await Employee.findById(task.coordinatorId) : null;
      const helperIds = Array.isArray(task.helperDoers) ? task.helperDoers.map(h => h.helperId) : [];
      const helpers = helperIds.length > 0 ? await Employee.find({ _id: { $in: helperIds } }) : [];
      const helperNames = helpers.map(h => h.name).join(", ") || "None";

      // Preparation of reference links
      const evidenceLink = req.file ? `\n📎 Work Proof: ${req.file.location || req.file.path}` : "\nNo proof attached.";

      // FULL DETAILS BLOCK (Simple Language)
      const fullTaskDetails = `\n\n` +
        `*Task Name:* ${task.taskName}\n` +
        `*Description:* ${task.description || "Daily Routine Work."}\n` +
        `*Done By:* ${task.doerId?.name || 'Staff member'}\n` +
        `*Coordinator:* ${coordinator?.name || 'Admin'}\n` +
        `*Support Team:* ${helperNames}\n` +
        `*Next Schedule:* ${formattedNextDate}\n` +
        `*Proof:* ${evidenceLink}\n\n` +
        `*Login Link:* ${loginLink}`;

      // --- DISPATCH MESSAGES ---

      // A. Notify Admin (Factory Head)
      if (tenant && tenant.adminEmail) {
        const adminNode = await Employee.findOne({ email: tenant.adminEmail, tenantId: tenant._id });
        if (adminNode?.whatsappNumber) {
          const adminMsg = `📋 *Routine Work Done*\n\nHi ${adminNode.name}, a routine task has been updated.` + fullTaskDetails;
          await sendWhatsAppMessage(adminNode.whatsappNumber, adminMsg);
        }
      }

      // B. Notify the Primary Doer
      if (task.doerId?.whatsappNumber) {
        const doerMsg = `✅ *Work Recorded*\n\nHi ${task.doerId.name}, your routine task has been saved.` + fullTaskDetails;
        await sendWhatsAppMessage(task.doerId.whatsappNumber, doerMsg);
      }

      // C. Notify Quality Coordinator
      if (coordinator?.whatsappNumber) {
        const coordMsg = `🛡️ *Routine Check Update*\n\nHi ${coordinator.name}, a routine you coordinate was finished.` + fullTaskDetails;
        await sendWhatsAppMessage(coordinator.whatsappNumber, coordMsg);
      }

      // D. Notify Support Team (Helpers)
      if (helpers.length > 0) {
        for (const helper of helpers) {
          if (helper.whatsappNumber) {
            const helperMsg = `🤝 *Team Work Update*\n\nHi ${helper.name}, a routine task you help with was finished.` + fullTaskDetails;
            await sendWhatsAppMessage(helper.whatsappNumber, helperMsg);
          }
        }
      }

    } catch (waError) {
      console.error("⚠️ Checklist WhatsApp Dispatch Failed:", waError.message);
    }

    // 6. Return confirmation
    res.status(200).json({ 
      message: "Work submitted! Next routine scheduled.", 
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
        const { taskName, doerId, status } = req.body;

        const updatedTask = await ChecklistTask.findByIdAndUpdate(
            id,
            { $set: { taskName, doerId, status } },
            { new: true }
        ).populate('doerId', 'name');

        if (!updatedTask) return res.status(404).json({ message: "Checklist not found" });

        res.status(200).json({ 
            message: "Checklist updated successfully!", 
            task: updatedTask 
        });
    } catch (error) {
        res.status(500).json({ message: "Update failed", error: error.message });
    }
};
exports.createChecklistTask = async (req, res) => {
  try {
    // FIX: Added 'startDate' to destructuring
    const { tenantId, taskName, doerId, frequency, frequencyConfig, startDate } = req.body;

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) return res.status(404).json({ message: "Factory settings not found" });

    // FIX: Logic to use user-defined start date or calculate immediately
    let firstDueDate;
    if (startDate) {
      firstDueDate = new Date(startDate);
      // Ensure it starts at the beginning of the day (e.g., 00:00)
      firstDueDate.setHours(0, 0, 0, 0);
    } else {
      firstDueDate = calculateNextDate(
        frequency, 
        frequencyConfig, 
        tenant.holidays || []
      );
    }

    const newChecklist = new ChecklistTask({
      tenantId,
      taskName,
      doerId,
      frequency,
      frequencyConfig,
      startDate: firstDueDate, // Store the official start date
      nextDueDate: firstDueDate, // Set the first occurrence
      history: [{
        action: "Checklist Created",
        remarks: `Protocol initiated. First occurrence scheduled for ${firstDueDate.toLocaleDateString()}`,
        timestamp: new Date()
      }]
    });
  
      await newChecklist.save();
      res.status(201).json({ message: "Recurring Checklist Created", nextDue: firstDueDate });
    } catch (error) {
      res.status(500).json({ message: "Failed to create checklist", error: error.message });
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
    // 1. Safety check for incoming data
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ message: "Data not received properly." });
    }

    const { taskId, status, revisedDeadline, remarks, doerId } = req.body;
    
    /**
     * CRITICAL: Populate all related parties to get names and WhatsApp numbers.
     * We populate assignerId, doerId, and coordinatorId.
     */
    const task = await DelegationTask.findById(taskId)
      .populate('assignerId doerId coordinatorId');
      
    if (!task) return res.status(404).json({ message: "Task not found" });

    // 2. Handle Evidence Files (S3 or local)
    let evidenceUrl = null;
    if (req.file) {
      evidenceUrl = req.file.location || req.file.path; 
    }

    // --- PRESERVE: POINT & ACHIEVEMENT ENGINE (Logic strictly kept) ---
    if (status === 'Completed' || status === 'Verified') {
      const Tenant = require('../models/Tenant'); 
      const Employee = require('../models/Employee');
      
      const tenant = await Tenant.findById(task.tenantId);
      const employee = await Employee.findById(task.doerId);
      
      if (tenant && tenant.pointSettings?.isActive && employee && tenant.pointSettings.brackets.length > 0) {
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

          if (tenant.badgeLibrary && tenant.badgeLibrary.length > 0) {
            tenant.badgeLibrary.forEach(badge => {
              const alreadyEarned = employee.earnedBadges.some(eb => eb.badgeId?.toString() === badge._id.toString());
              if (employee.totalPoints >= badge.pointThreshold && !alreadyEarned) {
                employee.earnedBadges.push({
                  badgeId: badge._id, name: badge.name, iconName: badge.iconName,
                  color: badge.color, unlockedAt: new Date()
                });
                task.history.push({
                  action: 'Achievement Unlocked', performedBy: task.doerId,
                  timestamp: new Date(), remarks: `🏆 New Badge: ${badge.name}!`
                });
              }
            });
          }
          await employee.save(); 

          if (pointsAwarded > 0) {
            await Employee.findByIdAndUpdate(task.assignerId, { $inc: { totalPoints: Math.max(5, Math.floor(pointsAwarded * 0.1)) } });
          }

          task.history.push({
            action: 'Points Calculated', performedBy: doerId,
            timestamp: new Date(), remarks: `Points: ${pointsAwarded > 0 ? '+' : ''}${pointsAwarded}`
          });
        }
      }
    }

    // 3. Update Task Status and History
    task.status = status;
    if (status === 'Revision Requested') {
      task.remarks = `New Date: ${revisedDeadline}. Reason: ${remarks}`;
    } else if (status === 'Completed') {
      task.remarks = remarks || "Work finished and submitted.";
    }

    const historyEntry = {
      action: status,
      performedBy: doerId,
      timestamp: new Date(),
      remarks: remarks || `Status changed to ${status}`
    };

    if (evidenceUrl) {
      task.files.push({ fileName: `Work Proof: ${req.file.originalname}`, fileUrl: evidenceUrl, uploadedAt: new Date() });
    }
    task.history.push(historyEntry);

    await task.save();

    // --- UPDATED: WHATSAPP NOTIFICATIONS FOR ALL PARTIES ---
    try {
      const tenant = await Tenant.findById(task.tenantId);
      
      // Generate Dynamic Subdomain URL
      const companySubdomain = tenant?.subdomain || "portal"; 
      const loginLink = `https://${companySubdomain}.lrbcloud.ai/login`;

      const formattedDeadline = new Date(task.deadline).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });

      // Find Support Team members
      const helperIds = Array.isArray(task.helperDoers) ? task.helperDoers.map(h => h.helperId) : [];
      const helpers = helperIds.length > 0 ? await Employee.find({ _id: { $in: helperIds } }) : [];
      const helperNames = helpers.map(h => h.name).join(", ") || "None";

      // Documentation links from original task files
      const fileLinks = task.files.length > 0 
        ? task.files.map((f, i) => `\n📎 Ref ${i+1}: ${f.fileUrl}`).join("") 
        : "\nNo attachments.";

      // Unified Task Detail Block
      const fullTaskDetails = `\n\n` +
        `*Task Title:* ${task.title}\n` +
        `*Description:* ${task.description || "No notes."}\n` +
        `*Given By:* ${task.assignerId?.name || 'Admin'}\n` +
        `*Primary Doer:* ${task.doerId?.name || 'Staff'}\n` +
        `*Coordinator:* ${task.coordinatorId?.name || 'Self-Track'}\n` +
        `*Support Team:* ${helperNames}\n` +
        `*Expected Completion:* ${formattedDeadline}\n` +
        `*Urgency Level:* ${task.priority}\n` +
        `*References:* ${fileLinks}\n\n` +
        `*Check Status:* ${loginLink}`;

      // --- DEFINE MESSAGES BASED ON STATUS ---
      let header = "";
      let footer = "";

      if (status === 'Completed') {
        header = `✅ *Work Submitted*`;
        footer = `The work has been sent for verification.`;
      } else if (status === 'Revision Requested') {
        header = `⚠️ *Correction Needed*`;
        footer = `*Feedback:* ${remarks}\n*New Target:* ${revisedDeadline}`;
      } else if (status === 'Verified') {
        header = `🎊 *Task Verified*`;
        footer = `This task is now officially closed. Good job!`;
      }

      const finalMessage = `${header}\n\nHi [Name], there is a status update for your task.${fullTaskDetails}\n\n${footer}`;

      // --- SEND TO ALL PARTIES ---
      
      // 1. To Assigner
      if (task.assignerId?.whatsappNumber) {
        await sendWhatsAppMessage(task.assignerId.whatsappNumber, finalMessage.replace("[Name]", task.assignerId.name));
      }
      
      // 2. To Primary Doer
      if (task.doerId?.whatsappNumber) {
        await sendWhatsAppMessage(task.doerId.whatsappNumber, finalMessage.replace("[Name]", task.doerId.name));
      }

      // 3. To Coordinator
      if (task.coordinatorId?.whatsappNumber) {
        await sendWhatsAppMessage(task.coordinatorId.whatsappNumber, finalMessage.replace("[Name]", task.coordinatorId.name));
      }

      // 4. To Support Team (Helpers)
      if (helpers.length > 0) {
        for (const helper of helpers) {
          if (helper.whatsappNumber) {
            await sendWhatsAppMessage(helper.whatsappNumber, finalMessage.replace("[Name]", helper.name));
          }
        }
      }

    } catch (waError) {
      console.error("⚠️ WhatsApp Notify Error:", waError.message);
    }

    res.status(200).json({ message: "Task status updated and team notified.", task });

  } catch (error) {
    console.error("❌ respondToTask Error:", error.message);
    res.status(500).json({ message: "Update failed", error: error.message });
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

// server/controllers/taskController.js

exports.getChecklistTasks = async (req, res) => {
    try {
        const { doerId } = req.params;
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];

        // 1. Fetch the employee and their factory settings
        const employee = await Employee.findById(doerId);
        if (!employee) return res.status(404).json({ message: "Employee not found" });

        const tenant = await Tenant.findById(employee.tenantId);
        
        // 2. Determine Office Opening Hours
        const openingTime = tenant?.officeHours?.opening || "09:00";
        const [openHour, openMin] = openingTime.split(':').map(Number);
        
        // 3. Create a timestamp for when the office opens TODAY
        const officeOpeningToday = new Date();
        officeOpeningToday.setHours(openHour, openMin, 0, 0);

        // 4. Find active tasks for this doer where nextDueDate has arrived
        const tasks = await ChecklistTask.find({ 
            doerId,
            status: 'Active',
            nextDueDate: { $lte: now } 
        });

        // 5. FILTER: Apply the renewal and office hour logic
        const visibleTasks = tasks.filter(task => {
            // If never completed, show it immediately
            if (!task.lastCompleted) return true;
            
            const lastDoneStr = new Date(task.lastCompleted).toISOString().split('T')[0];
            
            // HIDE if it was already done today
            if (lastDoneStr === todayStr) return false;
            
            // HIDE if the current time is still before the office opening time
            if (now < officeOpeningToday) return false;

            return true;
        });

        res.status(200).json(visibleTasks || []);
    } catch (error) {
        console.error("Checklist Fetch Error:", error.message);
        res.status(500).json({ message: "Error loading checklist", error: error.message });
    }
};