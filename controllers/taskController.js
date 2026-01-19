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
        message: "This task has expired (Missed). You cannot mark past dates as done today." 
      });
    }

    // 2. Fetch Factory/Tenant settings to calculate next occurrence
    const tenant = await Tenant.findById(task.tenantId);
    const holidays = tenant ? tenant.holidays : [];

    // 3. Update the last completion timestamp
    task.lastCompleted = now;

    // 4. Update the Audit History Log
    // attachmentUrl uses req.file.location which is the S3 public link
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

    // --- PHASE 2: WHATSAPP NOTIFICATION TRIGGER ---
    // Since checklists are company-wide, we notify the Factory Admin/Assigner 
    try {
      if (tenant && tenant.adminEmail) {
        // Find the admin employee record to get the WhatsApp number
        const adminNode = await Employee.findOne({ 
          email: tenant.adminEmail, 
          tenantId: tenant._id 
        });

        if (adminNode && adminNode.whatsappNumber) {
          const message = `📋 *Routine Protocol Finalized*\n\n` +
                          `*Protocol:* ${task.taskName}\n` +
                          `*Node Performed:* ${task.doerId?.name || 'Assigned Staff'}\n` +
                          `*Next Due:* ${task.nextDueDate.toLocaleDateString()}\n\n` +
                          `Evidence has been synchronized to the cloud. Review the Audit Log for details.`;
          
          // Dispatch via Maytapi Utility
          await sendWhatsAppMessage(adminNode.whatsappNumber, message);
        }
      }
    } catch (waError) {
      console.error("⚠️ Checklist WhatsApp Dispatch Failed:", waError.message);
    }

    // 6. Return confirmation
    res.status(200).json({ 
      message: "Work submitted with proof! Next occurrence scheduled.", 
      nextDue: task.nextDueDate,
      fileUrl: req.file ? (req.file.location || req.file.path) : null 
    });
  } catch (error) {
    console.error("❌ Checklist Completion Error:", error.message);
    res.status(500).json({ 
      message: "Error updating checklist or AWS upload", 
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
exports.coordinatorForceDone = async (req, res) => {
  try {
    const { taskId, coordinatorId, remarks } = req.body;
    
    const supervisor = await Employee.findById(coordinatorId);
    if (!supervisor) return res.status(404).json({ message: "Supervisor not found." });

    // 1. Identify the Task Collection
    let task = await DelegationTask.findById(taskId);
    let isChecklist = false;

    if (!task) {
      task = await ChecklistTask.findById(taskId);
      isChecklist = true;
    }

    if (!task) return res.status(404).json({ message: "Task not found." });

    // 2. ENUM VALIDATION FIX: Set status based on Task Type
    if (isChecklist) {
      // Checklists must stay 'Active' to repeat
      task.status = 'Active'; 
    } else {
      // One-time tasks move to 'Completed'
      task.status = 'Completed';
    }

    // 3. Record the Action in History
    const historyEntry = {
      action: "Administrative Completion",
      performedBy: coordinatorId,
      timestamp: new Date(),
      remarks: remarks || `Force completed by Supervisor: ${supervisor.name}`
    };

    if (!task.history) task.history = [];
    task.history.push(historyEntry);

    // 4. Handle Checklist-specific logic (Scheduling)
    if (isChecklist) {
      const { calculateNextDate } = require('../utils/scheduler');
      const Tenant = require('../models/Tenant');
      const tenant = await Tenant.findById(task.tenantId);
      
      task.lastCompleted = new Date();
      task.nextDueDate = calculateNextDate(
        task.frequency, 
        task.frequencyConfig || {}, 
        tenant ? tenant.holidays : []
      );
    }

    await task.save();
    res.status(200).json({ message: "Task verified by Supervisor", task });

  } catch (error) {
    console.error("❌ Override Crash:", error.message);
    res.status(500).json({ message: "Update failed", error: error.message });
  }
};

  exports.sendWhatsAppReminder = async (req, res) => {
    const { whatsappNumber, taskTitle } = req.body;
    // This will call your WhatsApp API provider
    console.log(`Sending reminder to ${whatsappNumber} for task: ${taskTitle}`);
    res.status(200).json({ message: "Reminder sent!" });
  };

exports.getCoordinatorTasks = async (req, res) => {
    try {
      const { coordinatorId } = req.params;
  
      // 1. Find the Coordinator to see which Assigners they track
      const coordinator = await Employee.findById(coordinatorId);
      if (!coordinator) return res.status(404).json({ message: "Coordinator not found" });
  
      // 2. Fetch tasks where the Assigner is in the Coordinator's managed list
      const tasks = await DelegationTask.find({
        assignerId: { $in: coordinator.managedAssigners }
      })
      .populate('assignerId', 'name role')
      .populate('doerId', 'name role whatsappNumber')
      .sort({ deadline: 1 }); // Show closest deadlines first
  
      res.status(200).json(tasks);
    } catch (error) {
      res.status(500).json({ message: "Error fetching tracking data", error: error.message });
    }
  };

exports.handleRevision = async (req, res) => {
    try {
        const { taskId, action, newDeadline, newDoerId, remarks, assignerId } = req.body;
        const task = await DelegationTask.findById(taskId);

        if (!task) return res.status(404).json({ message: "Task not found" });

        if (action === 'Approve') {
            task.deadline = newDeadline || task.deadline;
            task.status = 'Accepted';
            task.remarks = ""; // Clear the request remarks
            task.history.push({
                action: "Deadline Approved",
                performedBy: assignerId,
                remarks: `New deadline: ${new Date(task.deadline).toLocaleDateString()}`,
                timestamp: new Date()
            });
        } 
        else if (action === 'Reassign') {
            const oldDoer = task.doerId;
            task.doerId = newDoerId;
            task.status = 'Pending'; // Reset to pending for the new doer
            task.history.push({
                action: "Task Reassigned",
                performedBy: assignerId,
                remarks: `Moved from ${oldDoer} to ${newDoerId}. Reason: ${remarks}`,
                timestamp: new Date()
            });
        }

        await task.save();
        res.status(200).json({ message: `Task ${action} successfully`, task });
    } catch (error) {
        console.error("Revision Controller Error:", error);
        res.status(500).json({ message: "Update failed", error: error.message });
    }
};


exports.respondToTask = async (req, res) => {
  try {
      // 1. Safety check: ensure middleware correctly parsed the multipart/form-data
      if (!req.body || Object.keys(req.body).length === 0) {
          return res.status(400).json({ message: "No data received. Ensure multipart/form-data is used." });
      }

      const { taskId, status, revisedDeadline, remarks, doerId } = req.body;
      
      // CRITICAL: Populate assignerId and doerId to access their WhatsApp numbers later
      const task = await DelegationTask.findById(taskId).populate('assignerId doerId');
      if (!task) return res.status(404).json({ message: "Task not found" });

      // 2. Handle Evidence Files (S3 or local path)
      let evidenceUrl = null;
      if (req.file) {
          evidenceUrl = req.file.location || req.file.path; 
      }

      // --- PHASE 6.3: DUAL POINT & ACHIEVEMENT ENGINE (TRIGGERED ON COMPLETION) ---
      // Logic preserved exactly as per original requirements
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

                  const newTotalPoints = (employee.totalPoints || 0) + pointsAwarded;
                  employee.totalPoints = newTotalPoints;

                  if (tenant.badgeLibrary && tenant.badgeLibrary.length > 0) {
                      tenant.badgeLibrary.forEach(badge => {
                          const alreadyEarned = employee.earnedBadges.some(eb => eb.badgeId?.toString() === badge._id.toString());
                          
                          if (newTotalPoints >= badge.pointThreshold && !alreadyEarned) {
                              employee.earnedBadges.push({
                                  badgeId: badge._id,
                                  name: badge.name,
                                  iconName: badge.iconName,
                                  color: badge.color,
                                  unlockedAt: new Date()
                              });

                              task.history.push({
                                  action: 'Achievement Unlocked',
                                  performedBy: task.doerId,
                                  timestamp: new Date(),
                                  remarks: `🏆 New Badge: ${badge.name}! Milestone of ${badge.pointThreshold} PTS reached.`
                              });
                          }
                      });
                  }

                  await employee.save(); 

                  if (pointsAwarded > 0) {
                      const assignerBonus = Math.max(5, Math.floor(pointsAwarded * 0.1));
                      await Employee.findByIdAndUpdate(task.assignerId, {
                          $inc: { totalPoints: assignerBonus }
                      });
                  }

                  task.history.push({
                      action: 'Points Calculated',
                      performedBy: doerId,
                      timestamp: new Date(),
                      remarks: `Reward processed: Doer (${pointsAwarded > 0 ? '+' : ''}${pointsAwarded} PTS). Rule applied: ${bracket.label}`
                  });
              }
          }
      }

      // 3. Update Global Task State
      task.status = status;

      if (status === 'Revision Requested') {
          task.remarks = `Proposed Deadline: ${revisedDeadline}. Reason: ${remarks}`;
      } else if (status === 'Completed') {
          task.remarks = remarks || "Task submitted for verification.";
      }

      // 4. Record Status History
      const historyEntry = {
          action: status,
          performedBy: doerId,
          timestamp: new Date(),
          remarks: remarks || `Status changed to ${status}`
      };

      if (evidenceUrl) {
          historyEntry.remarks += ` | Evidence attached: ${evidenceUrl}`;
          task.files.push({
              fileName: `Evidence: ${req.file.originalname}`,
              fileUrl: evidenceUrl,
              uploadedAt: new Date()
          });
      }

      task.history.push(historyEntry);

      await task.save(); // Persist all changes

      // --- PHASE 2: WHATSAPP CONTEXTUAL NOTIFICATIONS ---
      try {
          // Trigger A: Notify Assigner of task completion
          if (status === 'Completed' && task.assignerId?.whatsappNumber) {
              const msg = `✅ *Mission Finalized*\n\n` +
                          `*Task:* ${task.title}\n` +
                          `*Submitted By:* ${task.doerId?.name}\n\n` +
                          `Work proof has been uploaded to the terminal. Please review and verify the asset.`;
              await sendWhatsAppMessage(task.assignerId.whatsappNumber, msg);
          }

          // Trigger B: Notify Doer that a revision is required
          if (status === 'Revision Requested' && task.doerId?.whatsappNumber) {
              const msg = `⚠️ *Rework Required*\n\n` +
                          `*Task:* ${task.title}\n` +
                          `*Commander Feedback:* ${remarks}\n` +
                          `*New Target:* ${revisedDeadline}\n\n` +
                          `Please update the task parameters and re-submit for verification.`;
              await sendWhatsAppMessage(task.doerId.whatsappNumber, msg);
          }
      } catch (waError) {
          console.error("⚠️ WhatsApp Response Notification Failed:", waError.message);
      }

      res.status(200).json({ message: `Status updated to ${status}`, task });

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

/**
 * Fully Updated createTask Controller
 * Fixes: Undefined property errors, broken S3 links, and history logging.
 */
/**
 * Fully Updated createTask Controller with WhatsApp Integration
 * Logic: Preserves S3 uploads, helper doer parsing, and audit history.
 * Trigger: Notifies the lead Doer node via Maytapi upon successful assignment.
 */
exports.createTask = async (req, res) => {
  try {
    // 1. Ensure req.body is spread into an object so we can safely set properties
    const taskData = { ...req.body }; 

    // --- NEW: PARSE HELPER DOERS (CRITICAL FIX FOR CASTERRO) ---
    // FormData sends arrays as strings; we must convert them back to JSON objects.
    if (taskData.helperDoers && typeof taskData.helperDoers === 'string') {
      try {
        taskData.helperDoers = JSON.parse(taskData.helperDoers);
      } catch (e) {
        console.error("❌ Helper Doers Parse Error:", e.message);
        taskData.helperDoers = []; // Fallback to empty array if parsing fails
      }
    }

    // 2. Initialize files as an empty array to prevent 'undefined' crashes
    let uploadedFiles = [];
    
    // 3. Process files provided by Multer-S3 middleware
    if (req.files && req.files.length > 0) {
      uploadedFiles = req.files.map(file => ({
        fileName: file.originalname,
        /**
         * CRITICAL FIX: Use 'file.location' for the full S3 URL.
         * Fallback to 'file.path' only if using local disk storage.
         */
        fileUrl: file.location || file.path, 
        uploadedAt: new Date()
      }));
    }
    
    // 4. Assign the processed file array back to the task object
    taskData.files = uploadedFiles;

    // 5. Data Cleaning: Remove empty strings for optional ID fields
    if (!taskData.coordinatorId || taskData.coordinatorId === "" || taskData.coordinatorId === "null") {
      delete taskData.coordinatorId;
    }

    // 6. Handle coworkers array cleaning if necessary
    if (taskData.coworkers && typeof taskData.coworkers === 'string') {
      try {
        taskData.coworkers = JSON.parse(taskData.coworkers);
      } catch (e) {
        taskData.coworkers = [];
      }
    }

    // 7. Initialize the Mongoose Model
    const newTask = new DelegationTask(taskData);
    
    // 8. Initialize Audit History
    // Including specific remarks about attachments for the Assigner to see
    newTask.history = [{
      action: "Task Created",
      performedBy: taskData.assignerId,
      timestamp: new Date(),
      remarks: `Initial assignment created with ${uploadedFiles.length} reference attachment(s).`
    }];

    // 9. Persist to MongoDB
    await newTask.save();
    
    console.log(`✅ Task "${newTask.title}" saved with ${uploadedFiles.length} files to S3.`);

    // --- PHASE 2: WHATSAPP NOTIFICATION TRIGGER ---
    // Look up the lead Doer's phone number to dispatch the directive
    try {
      const doer = await Employee.findById(newTask.doerId);
      if (doer && doer.whatsappNumber) {
        const message = `🚀 *New Directive Assigned*\n\n` +
                        `*Objective:* ${newTask.title}\n` +
                        `*Priority:* ${newTask.priority}\n` +
                        `*Deadline:* ${new Date(newTask.deadline).toLocaleDateString()}\n\n` +
                        `Please log in to the *Work Pilot* terminal to acknowledge and review instructions.`;
        
        // Dispatch via Maytapi Utility
        await sendWhatsAppMessage(doer.whatsappNumber, message);
      }
    } catch (waError) {
      // We catch WA errors separately so the user still gets their "Success" response
      console.error("⚠️ WhatsApp Dispatch Failed (Non-Critical):", waError.message);
    }

    // 10. Return success response to the frontend
    res.status(201).json({ 
      message: "Task Assigned Successfully & Node Notified", 
      task: newTask 
    });

  } catch (error) {
    // Log the exact error in the terminal for debugging
    console.error("❌ Mongoose Task Creation Error:", error.message);
    
    res.status(500).json({ 
      message: "Task Creation Failed", 
      error: error.message 
    });
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