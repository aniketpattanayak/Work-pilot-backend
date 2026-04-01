const Tenant = require('../models/Tenant');
const Employee = require('../models/Employee');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const DelegationTask = require('../models/DelegationTask');
const ChecklistTask = require('../models/ChecklistTask');
const sendWhatsAppMessage = require('../utils/whatsappNotify');

exports.getEmployeeList = async (req, res) => {
  try {
    const { tenantId } = req.params;

    // Find all employees where tenantId matches
    // .populate() swaps the ID strings for the actual Name and Role of the linked staff
    const employees = await Employee.find({ tenantId })
      .populate('managedDoers', 'name role department')
      .populate('managedAssigners', 'name role department')
      .select('-password') // Exclude passwords for security
      .sort({ createdAt: -1 }); // Keep newest employees at the top

    res.status(200).json(employees);
  } catch (error) {
    console.error("Fetch Error:", error.message);
    res.status(500).json({ message: "Error fetching employee list", error: error.message });
  }
};

exports.deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;

    // Find and delete the employee by their MongoDB ID
    const deletedEmployee = await Employee.findByIdAndDelete(id);

    if (!deletedEmployee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    res.status(200).json({ message: "Employee deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting employee", error: error.message });
  }
};


exports.handleRevision = async (req, res) => {
  try {
    const { taskId, action, newDeadline, newDoerId, remarks, assignerId } = req.body;

    // We populate doerId to ensure we have the current doer's details for the "Approve" notification
    const task = await DelegationTask.findById(taskId).populate('doerId');

    if (!task) return res.status(404).json({ message: "Task not found" });

    let recipientPhone = null;
    let notificationMessage = "";

    if (action === 'Approve') {
      // 1. Update deadline and reset status to 'Accepted'
      task.deadline = new Date(newDeadline);
      task.status = 'Accepted';
      task.remarks = "Deadline revision approved by Assigner.";

      task.history.push({
        action: "Revision Approved",
        performedBy: assignerId,
        timestamp: new Date(),
        remarks: `New deadline set to: ${new Date(newDeadline).toLocaleDateString()}`
      });

      // Prepare Notification for the current Doer
      if (task.doerId?.whatsappNumber) {
        recipientPhone = task.doerId.whatsappNumber;
        notificationMessage = `✅ *Deadline Approved*\n\n` +
          `*Task:* ${task.title}\n` +
          `*New Deadline:* ${new Date(newDeadline).toLocaleDateString()}\n\n` +
          `The commander has accepted your revision request. Please proceed with the mission.`;
      }
    }
    else if (action === 'Reassign') {
      // 2. Transfer task to a new Doer
      const oldDoerId = task.doerId;
      task.doerId = newDoerId;
      task.status = 'Pending'; // Resets to pending for the new doer to accept
      task.remarks = remarks;

      task.history.push({
        action: "Task Reassigned",
        performedBy: assignerId,
        timestamp: new Date(),
        remarks: `Task moved from original Doer to new assignee. Reason: ${remarks}`
      });

      // We must fetch the NEW Doer's phone number from the database
      const newDoer = await Employee.findById(newDoerId);
      if (newDoer && newDoer.whatsappNumber) {
        recipientPhone = newDoer.whatsappNumber;
        notificationMessage = `🚀 *Task Reassigned to You*\n\n` +
          `*Mission:* ${task.title}\n` +
          `*Priority:* ${task.priority}\n` +
          `*Deadline:* ${new Date(task.deadline).toLocaleDateString()}\n\n` +
          `*Commander's Note:* ${remarks || 'New assignment initialized.'}\n\n` +
          `Please log in to the terminal to acknowledge this transfer.`;
      }
    }

    await task.save();

    // --- PHASE 2: WHATSAPP DISPATCH ---
    if (recipientPhone && notificationMessage) {
      try {
        await sendWhatsAppMessage(recipientPhone, notificationMessage);
      } catch (waError) {
        console.error("⚠️ Revision WhatsApp Dispatch Failed:", waError.message);
      }
    }

    res.status(200).json({ message: `Revision handled: ${action}`, task });
  } catch (err) {
    console.error("handleRevision Error:", err.message);
    res.status(500).json({ message: "Server error handling revision", error: err.message });
  }
};
// server/controllers/tenantController.js

exports.getCompanyOverview = async (req, res) => {
  try {
    const { tenantId } = req.params;

    // 1. Parallel Fetch: Get all registry data at once
    const [employees, delegationTasks, checklistTasks] = await Promise.all([
      // Fetches EVERY employee for universal mapping
      Employee.find({ tenantId })
        .select('name roles role department email managedDoers managedAssigners'),

      // Fetches all delegation tasks for the factory
      DelegationTask.find({ tenantId })
        .populate('assignerId', 'name')
        .populate('doerId', 'name')
        .sort({ createdAt: -1 }),

      // Fetches all routine checklist tasks
      ChecklistTask.find({ tenantId })
        .populate('doerId', 'name')
    ]);

    // 2. Return data to frontend
    res.status(200).json({
      employees: employees || [],
      delegationTasks: delegationTasks || [],
      checklistTasks: checklistTasks || []
    });

  } catch (error) {
    // This logs the specific error (e.g., "DelegationTask is not defined") in your console
    console.error("❌ UNIVERSAL OVERVIEW CRASH:", error.message);
    res.status(500).json({
      message: "Backend Error: Could not fetch factory data",
      error: error.message
    });
  }
};
exports.updateSettings = async (req, res) => {
  try {
    // 1. Destructure all fields from the request body to ensure they are captured
    // UPDATED: Added 'weekends' to capture the Sun-Sat array
    const {
      tenantId,
      pointSettings,
      officeHours,
      holidays,
      badgeLibrary,
      weekends
    } = req.body;

    // 2. Update the Tenant document in MongoDB
    // The { new: true } option is CRITICAL so it returns the SAVED data
    const updatedTenant = await Tenant.findByIdAndUpdate(
      tenantId,
      {
        $set: {
          badgeLibrary,   // Saved from Phase 6.2
          pointSettings,  // Saved from Phase 2
          officeHours,    // Foundation Setup
          holidays,       // Foundation Setup
          weekends        // NEW: Persisting the custom weekend array
        }
      },
      { new: true, runValidators: true }
    );

    // 3. Check if the tenant exists
    if (!updatedTenant) {
      return res.status(404).json({ message: "Tenant not found" });
    }

    // 4. Return the updated document wrapped in a response object
    // This allows the frontend to access response.data.updatedTenant
    res.status(200).json({
      message: "Global parameters synchronized successfully",
      updatedTenant
    });

  } catch (error) {
    console.error("Update Error:", error.message);
    res.status(500).json({
      message: "Backend Save Failed",
      error: error.message
    });
  }
};
exports.assignToCoordinator = async (req, res) => {
  try {
    const { coordinatorId, assignerIds } = req.body;
    const coordinator = await Employee.findByIdAndUpdate(
      coordinatorId,
      { $set: { managedAssigners: assignerIds } },
      { new: true }
    );
    if (!coordinator) return res.status(404).json({ message: "Coordinator not found" });
    res.status(200).json({ message: "Linked successfully", managed: coordinator.managedAssigners });
  } catch (error) {
    res.status(500).json({ message: "Assignment failed", error: error.message });
  }
};


exports.addEmployee = async (req, res) => {
  try {
    const {
      tenantId, name, email, department, whatsappNumber,
      roles, password, managedDoers, managedAssigners, workOnSunday,
    } = req.body;

    // 1. Password Hashing (Preserved)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 2. Initialize and Save Employee
    const newEmployee = new Employee({
      tenantId, name, email, department, whatsappNumber,
      workOnSunday: workOnSunday || false,
      roles: (Array.isArray(roles) && roles.length > 0) ? roles : ['Doer'],
      password: hashedPassword,
      managedDoers: managedDoers || [],
      managedAssigners: managedAssigners || []
    });

    let savedEmployee = await newEmployee.save();

    // 3. Fetch Tenant for dynamic data
    const tenant = await Tenant.findById(tenantId);
    
    // 4. Trigger "Welcome to the Team" Template
    try {
      if (whatsappNumber && tenant) {
        const loginLink = `https://${tenant.subdomain || "portal"}.lrbcloud.ai/login`;

        /**
         * TEMPLATE: mployee_onboarding_welcome
         * {{1}} - Employee Name
         * {{2}} - Company/System Name
         * {{3}} - Role/Designation
         * {{4}} - Department
         * {{5}} - Login Link
         */
        const welcomeData = {
          templateName: "mployee_onboarding_welcome",
          variables: [
            name,                              // {{1}}
            tenant.companyName || "WorkPilot", // {{2}}
            roles.join(', '),                  // {{3}}
            department || "Operations",         // {{4}}
            loginLink                          // {{5}}
          ]
        };

        await sendWhatsAppMessage(whatsappNumber, welcomeData);
      }
    } catch (waError) {
      console.error("⚠️ Welcome Template Failed:", waError.message);
    }

    // 5. Populate and Return
    savedEmployee = await Employee.findById(savedEmployee._id)
      .populate('managedDoers', 'name roles department')
      .populate('managedAssigners', 'name roles department')
      .select('-password');

    res.status(201).json({ message: "Employee Onboarded Successfully", employee: savedEmployee });
  } catch (error) {
    res.status(500).json({ message: "Creation failed", error: error.message });
  }
};
// Create a new Company/Tenant (Superadmin only)


// 1. Get all registered companies
exports.getAllCompanies = async (req, res) => {
  try {
    const companies = await Tenant.find();
    res.status(200).json(companies);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch companies", error: error.message });
  }
};

// 2. Delete a company (and its employees)
exports.deleteCompany = async (req, res) => {
  try {
    const { id } = req.params;
    await Tenant.findByIdAndDelete(id);
    await Employee.deleteMany({ tenantId: id }); // Cleanup employees
    res.status(200).json({ message: "Company and its data removed." });
  } catch (error) {
    res.status(500).json({ message: "Delete failed" });
  }
};

// server/controllers/tenantController.js

// server/controllers/tenantController.js

exports.superAdminLogin = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Get values from .env and force them to strings/trimmed
    const envUser = String(process.env.SUPERADMIN_USER || "").trim();
    const envPass = String(process.env.SUPERADMIN_PASS || "").trim();

    const inputUser = String(username || "").trim();
    const inputPass = String(password || "").trim();

    // LOGS FOR DEBUGGING (Check your terminal)

    if (inputUser === envUser && inputPass === envPass) {
      const jwt = require('jsonwebtoken');
      const token = jwt.sign(
        { id: 'MASTER_ID', roles: ['Admin'], isSuperAdmin: true },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
      );

      return res.status(200).json({
        message: "Master Access Granted",
        token,
        user: {
          name: "Lalit (SuperAdmin)",
          roles: ["Admin"],
          isSuperAdmin: true
        }
      });
    } else {
      return res.status(401).json({
        message: "Invalid Master Credentials",
        details: {
          userMatch: inputUser === envUser,
          passMatch: inputPass === envPass
        }
      });
    }
  } catch (error) {
    console.error("SuperAdmin Login Error:", error.message);
    res.status(500).json({ message: "Login Error", error: error.message });
  }
};


exports.loginEmployee = async (req, res) => {
  try {
    const { email, password, subdomain } = req.body;

    // 1. Find the Factory/Tenant by subdomain
    const tenant = await Tenant.findOne({ subdomain });
    if (!tenant) return res.status(404).json({ message: "Factory not found." });

    // 2. Find the Employee within that specific Factory
    const employee = await Employee.findOne({ email, tenantId: tenant._id });
    if (!employee) return res.status(401).json({ message: "Invalid Credentials." });

    // 3. Verify the Password
    const isMatch = await bcrypt.compare(password, employee.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid Credentials." });

    // 4. Generate JWT Token with Multi-Role Array
    // We now use 'roles' (array) instead of 'role' (string)
    const token = jwt.sign(
      {
        id: employee._id,
        roles: employee.roles, // Multi-role support
        tenantId: tenant._id
      },
      process.env.JWT_SECRET || 'your_secret_key',
      { expiresIn: '1d' }
    );

    // 5. Send User Object with Roles to Frontend
    res.json({
      token,
      user: {
        id: employee._id,
        name: employee.name,
        roles: employee.roles, // Full array of roles
        company: tenant.companyName
      },
      tenantId: tenant._id
    });
  } catch (error) {
    console.error("Login Error:", error.message);
    res.status(500).json({ message: "Login Error", error: error.message });
  }
};



exports.getProfile = async (req, res) => {
  try {
    // user info comes from JWT middleware
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // fetch latest employee data from DB
    const employee = await Employee.findById(userId)
      .select('-password'); // NEVER send password

    if (!employee) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      user: {
        id: employee._id,
        name: employee.name,
        roles: employee.roles,
        department: employee.department,
        email: employee.email
      }
    });

  } catch (error) {
    console.error("Profile Fetch Error:", error.message);
    res.status(500).json({
      message: "Failed to fetch profile",
      error: error.message
    });
  }
};



// server/controllers/tenantController.js
exports.updateBranding = async (req, res) => {
  try {
    const { tenantId, companyName } = req.body;

    // Check if a new file was uploaded, otherwise keep old logo
    const updateData = { companyName };
    if (req.file) {
      updateData.logo = req.file.location || req.file.path;
    }

    const updatedTenant = await Tenant.findByIdAndUpdate(
      tenantId,
      { $set: updateData },
      { new: true } // Returns the updated document
    );

    res.status(200).json({ message: "Branding updated", logo: updatedTenant.logo });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const calculatePerformancePoints = (task, settings) => {
  if (!settings || !settings.isActive || !settings.brackets.length) return 0;

  // 1. Calculate Total Task Duration (Created to Deadline) to find the bracket
  const totalDurationMs = new Date(task.deadline) - new Date(task.createdAt);
  const totalDurationDays = totalDurationMs / (1000 * 60 * 60 * 24);

  // 2. Find the correct bracket (smallest maxDurationDays that fits)
  const sortedBrackets = [...settings.brackets].sort((a, b) => a.maxDurationDays - b.maxDurationDays);
  const bracket = sortedBrackets.find(b => totalDurationDays <= b.maxDurationDays) || sortedBrackets[sortedBrackets.length - 1];

  if (!bracket) return 0;

  // 3. Calculate Time Delta (Deadline vs Completion)
  const completionDate = task.history.find(h => h.action === 'Completed')?.timestamp || new Date();
  const deltaMs = new Date(task.deadline) - new Date(completionDate);
  const deltaHours = deltaMs / (1000 * 60 * 60);

  let earnedPoints = 0;
  const unitMultiplier = bracket.pointsUnit === 'day' ? 24 : 1;

  if (deltaHours > 0) {
    // EARLY: Award Bonus
    earnedPoints = Math.floor((deltaHours / unitMultiplier) * bracket.earlyBonus);
  } else if (deltaHours < 0) {
    // LATE: Apply Penalty
    earnedPoints = -Math.floor((Math.abs(deltaHours) / unitMultiplier) * bracket.latePenalty);
  }

  return earnedPoints;
};
// Create a new Factory and its first Admin user
exports.createTenant = async (req, res) => {
  try {
    const { companyName, subdomain, ownerEmail, adminPassword } = req.body;

    // 1. Process Logo URL
    /**
     * req.file is populated by your upload middleware (Multer).
     * We check for 'location' (AWS S3) or 'path' (Local Storage).
     */
    const logoUrl = req.file ? (req.file.location || req.file.path) : null;

    // 2. Subdomain Validation
    const formattedSubdomain = subdomain.toLowerCase().trim();
    const existingTenant = await Tenant.findOne({ subdomain: formattedSubdomain });

    if (existingTenant) {
      return res.status(400).json({ message: "Subdomain already taken. Try another." });
    }

    // 3. Create the Tenant record with the new Logo field
    const newTenant = new Tenant({
      companyName,
      subdomain: formattedSubdomain,
      adminEmail: ownerEmail,
      password: adminPassword,
      logo: logoUrl // Save the URL of the uploaded logo
    });

    await newTenant.save();

    // 4. Setup Initial Admin Account
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const newAdmin = new Employee({
      tenantId: newTenant._id,
      name: `${companyName} Admin`,
      email: ownerEmail,
      password: hashedPassword,
      department: 'Management',
      whatsappNumber: '0000000000',
      roles: ['Admin']
    });

    await newAdmin.save();

    res.status(201).json({
      message: "New Factory Registered Successfully!",
      tenant: newTenant,
      logoUrl // Return the URL for immediate frontend verification
    });

  } catch (error) {
    console.error("Factory Creation Error:", error.message);
    res.status(500).json({
      message: "Creation failed",
      error: error.message
    });
  }
};
// Function to update any employee detail (Name, Role, Dept, etc.)
// This updated logic prevents duplicates by overwriting the array
exports.updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, whatsappNumber, department, roles, managedDoers, managedAssigners, password, workOnSunday, leaveStatus } = req.body;

    const updateData = {
      name, email, department, roles, whatsappNumber, workOnSunday, leaveStatus,
      managedDoers: Array.isArray(managedDoers) ? managedDoers.map(d => d._id || d) : [],
      managedAssigners: Array.isArray(managedAssigners) ? managedAssigners.map(a => a._id || a) : []
    };

    if (password && password.trim() !== "") {
      const salt = await bcrypt.genSalt(10);
      updateData.password = await bcrypt.hash(password, salt);
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(id, { $set: updateData }, { new: true })
      .populate('managedDoers', 'name roles department')
      .populate('managedAssigners', 'name roles department')
      .select('-password');

    // --- TRIGGER: PROFILE UPDATED TEMPLATE ---
    try {
      const tenant = await Tenant.findById(updatedEmployee.tenantId);
      if (updatedEmployee.whatsappNumber && tenant) {
        const loginLink = `https://${tenant.subdomain || "portal"}.lrbcloud.ai/login`;

        /**
         * TEMPLATE: _employee_profile_update
         * {{1}} - Employee Name
         * {{2}} - New Designation (Roles)
         * {{3}} - Department
         * {{4}} - Login Link
         */
        const updateDataPayload = {
          templateName: "_employee_profile_update",
          variables: [
            updatedEmployee.name,      // {{1}}
            roles.join(', '),          // {{2}}
            department || 'General',   // {{3}}
            loginLink                  // {{4}}
          ]
        };

        await sendWhatsAppMessage(updatedEmployee.whatsappNumber, updateDataPayload);
      }
    } catch (waError) {
      console.error("⚠️ Profile Update Template Failed:", waError.message);
    }

    res.status(200).json({ message: "Profile Synchronized", employee: updatedEmployee });
  } catch (error) {
    res.status(500).json({ message: "Update failed", error: error.message });
  }
};
// Admin logic to link staff (Assigner -> Doers OR Coordinator -> Assigners)
// Function to Update existing mapping links anytime
// This function allows the Admin to update a team link at any time
// server/controllers/tenantController.js

exports.updateEmployeeMapping = async (req, res) => {
  try {
    // Renamed variables to match the Universal intent
    const { employeeId, targetIds, mappingType } = req.body;

    const updatedEmployee = await Employee.findByIdAndUpdate(
      employeeId,
      { $set: { [mappingType]: targetIds } },
      { new: true }
    ).populate(mappingType, 'name roles role department'); // Populate full info

    res.status(200).json({
      message: "Operational Linkage updated successfully!",
      employee: updatedEmployee
    });
  } catch (error) {
    res.status(500).json({ message: "Update failed", error: error.message });
  }
};

// --- ADD THIS TO THE BOTTOM OF YOUR FILE ---
exports.verifyTenant = async (req, res) => {
  try {
    const { subdomain } = req.params;

    // Find the factory by its subdomain
    const tenant = await Tenant.findOne({ subdomain: subdomain.toLowerCase() });

    if (!tenant) {
      return res.status(404).json({ message: "Factory infrastructure not found." });
    }

    // This is the CRITICAL part: we must return the logo and companyName
    res.status(200).json({
      id: tenant._id,
      companyName: tenant.companyName,
      logo: tenant.logo // The login page is currently receiving 'undefined' for this
    });
  } catch (error) {
    console.error("Verification Error:", error.message);
    res.status(500).json({ message: "Verification Error", error: error.message });
  }
};
