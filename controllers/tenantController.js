const Tenant = require('../models/Tenant');
const Employee = require('../models/Employee');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const DelegationTask = require('../models/DelegationTask');
const ChecklistTask = require('../models/ChecklistTask');

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

// --- Missing Function: Company Overview for Viewer Role ---
// server/controllers/taskController.js
// server/controllers/taskController.js

exports.handleRevision = async (req, res) => {
  try {
    const { taskId, action, newDeadline, newDoerId, remarks, assignerId } = req.body;
    const task = await DelegationTask.findById(taskId);

    if (!task) return res.status(404).json({ message: "Task not found" });

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
    }

    await task.save();
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
    const { tenantId, pointSettings, officeHours, holidays, badgeLibrary } = req.body;
    
    // 2. Update the Tenant document in MongoDB
    // The { new: true } option is CRITICAL so it returns the SAVED data
    const updatedTenant = await Tenant.findByIdAndUpdate(
      tenantId,
      { 
        $set: { 
          badgeLibrary,   // Saved from Phase 6.2
          pointSettings,  // Saved from Phase 2
          officeHours,    // Foundation Setup
          holidays        // Foundation Setup
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
      message: "Settings saved successfully", 
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
      // Receive 'roles' as an array from req.body
      const { tenantId, name, email, department, whatsappNumber, roles, password, managedDoers, managedAssigners } = req.body;
  
      const newEmployee = new Employee({
        tenantId,
        name,
        email,
        department,
        whatsappNumber,
        roles: roles || ['Doer'], // Save as array
        password, 
        managedDoers: managedDoers || [],
        managedAssigners: managedAssigners || []
      });
  
      let savedEmployee = await newEmployee.save();
  
      savedEmployee = await Employee.findById(savedEmployee._id)
        .populate('managedDoers', 'name roles department')
        .populate('managedAssigners', 'name roles department')
        .select('-password');
  
      res.status(201).json({ 
        message: "Employee Created with Multi-Roles Successfully!", 
        employee: savedEmployee 
      });
    } catch (error) {
      console.error("Add Employee Error:", error.message);
      res.status(500).json({ message: "Server Error during creation", error: error.message });
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
      const { name, email, department, role, managedDoers, managedAssigners, password } = req.body;

      // Map the IDs correctly to ensure we only store the ID strings
      const cleanDoers = managedDoers ? managedDoers.map(d => d._id || d) : [];
      const cleanAssigners = managedAssigners ? managedAssigners.map(a => a._id || a) : [];

      const updateData = { 
        name, 
        email, 
        department, 
        role, 
        managedDoers: cleanDoers, // Overwrites old list with new clean list
        managedAssigners: cleanAssigners 
      };

      if (password && password.trim() !== "") {
        const bcrypt = require('bcryptjs');
        const salt = await bcrypt.genSalt(10);
        updateData.password = await bcrypt.hash(password, salt);
      }

      const updatedEmployee = await Employee.findByIdAndUpdate(
        id, 
        { $set: updateData }, 
        { new: true }
      )
      .populate('managedDoers', 'name role') 
      .populate('managedAssigners', 'name role')
      .select('-password');

      res.status(200).json({ message: "Updated Successfully!", employee: updatedEmployee });
    } catch (error) {
      res.status(500).json({ message: "Server Error", error: error.message });
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


