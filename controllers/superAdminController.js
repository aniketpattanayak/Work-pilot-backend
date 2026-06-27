const Tenant      = require('../models/Tenant');
const Employee    = require('../models/Employee');
const ActivityLog = require('../models/ActivityLog');
const Billing     = require('../models/Billing');
const bcrypt      = require('bcryptjs');

// ─── GET ALL TENANTS OVERVIEW ─────────────────────────────────────────────────
/**
 * GET /api/superadmin/tenants
 * Returns all tenants with usage stats and status
 */
exports.getAllTenants = async (req, res) => {
  try {
    const tenants = await Tenant.find({}).lean();

    // Require real models for accurate counts (not ActivityLog which may be empty)
    const DelegationTask  = require('../models/DelegationTask');
    const FlowInstance    = require('../models/FlowInstance');
    const OrderSubmission = require('../models/OrderSubmission');

    const monthStart = new Date(new Date().setDate(1));

    const results = await Promise.all(tenants.map(async (t) => {
      const tenantId = t._id;

      const [
        employeeCount,
        taskCount,
        orderCount,
        activeFlows,
        lastLogin,
      ] = await Promise.all([
        Employee.countDocuments({ tenantId }),
        DelegationTask.countDocuments({ tenantId, createdAt: { $gte: monthStart } }).catch(()=>0),
        OrderSubmission.countDocuments({ tenantId, createdAt: { $gte: monthStart } }).catch(()=>0),
        FlowInstance.countDocuments({ tenantId, status: 'active' }).catch(()=>0),
        ActivityLog.findOne({ tenantId, action: 'login' }).sort({ createdAt: -1 }).select('createdAt employeeName').lean().catch(()=>null),
      ]);

      const billing = await Billing.findOne({ tenantId }).sort({ createdAt: -1 }).lean().catch(()=>null);

      return {
        _id:        t._id,
        companyName:t.companyName,
        subdomain:  t.subdomain,
        adminEmail: t.adminEmail,
        createdAt:  t.createdAt,
        superAdmin: t.superAdmin || {},
        stats: {
          employeeCount,
          tasksThisMonth:  taskCount,
          ordersThisMonth: orderCount,
          activeFlows,
          lastActivity:    lastLogin,
        },
        billing,
      };
    }));

    res.json(results);
  } catch (err) {
    console.error('[SuperAdmin] getAllTenants error:', err.message);
    res.status(500).json({ message: 'Failed to fetch tenants' });
  }
};

// ─── GET SINGLE TENANT DETAIL ─────────────────────────────────────────────────
exports.getTenantDetail = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenant = await Tenant.findById(tenantId).lean();
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

    const employees = await Employee.find({ tenantId }).select('name role isActive lastLogin createdAt').lean();

    // Real counts from actual models
    const DelegationTask  = require('../models/DelegationTask');
    const FlowInstance    = require('../models/FlowInstance');
    const FlowTemplate    = require('../models/FlowTemplate');
    const OrderSubmission = require('../models/OrderSubmission');

    const monthStart  = new Date(new Date().setDate(1));
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      taskCreated, taskCompleted, orderCount,
      activeFlows, totalFlows, logins,
    ] = await Promise.all([
      DelegationTask.countDocuments({ tenantId, createdAt: { $gte: monthStart } }).catch(()=>0),
      DelegationTask.countDocuments({ tenantId, status:'done', updatedAt: { $gte: monthStart } }).catch(()=>0),
      OrderSubmission.countDocuments({ tenantId, createdAt: { $gte: monthStart } }).catch(()=>0),
      FlowInstance.countDocuments({ tenantId, status:'active' }).catch(()=>0),
      FlowTemplate.countDocuments({ tenantId }).catch(()=>0),
      ActivityLog.countDocuments({ tenantId, action:'login', createdAt:{ $gte: monthStart } }).catch(()=>0),
    ]);

    const actionCounts = [
      { _id:'task_created',    count: taskCreated   },
      { _id:'task_completed',  count: taskCompleted },
      { _id:'order_submitted', count: orderCount    },
      { _id:'flow_active',     count: activeFlows   },
      { _id:'flow_total',      count: totalFlows    },
      { _id:'login',           count: logins        },
    ];

    // Recent activity log (last 7 days)
    const recentLogs = await ActivityLog.find({ tenantId, createdAt: { $gte: sevenDaysAgo } })
      .sort({ createdAt: -1 }).limit(100).lean();

    const billing = await Billing.find({ tenantId }).sort({ createdAt: -1 }).limit(12).lean();

    res.json({ tenant, employees, recentLogs, actionCounts, billing });
  } catch (err) {
    console.error('[SuperAdmin] getTenantDetail error:', err.message);
    res.status(500).json({ message: 'Failed to fetch tenant detail' });
  }
};

// ─── PAUSE / RESUME TENANT ────────────────────────────────────────────────────
exports.pauseTenant = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { reason, pauseFrom, pauseTo } = req.body || {};

    const now = new Date();
    const fromDate = pauseFrom ? new Date(pauseFrom) : now;
    const toDate   = pauseTo   ? new Date(pauseTo)   : null;

    // If pauseFrom is in the future — schedule it (status stays active but scheduled fields set)
    const isImmediate = fromDate <= now;

    await Tenant.findByIdAndUpdate(tenantId, {
      $set: {
        'superAdmin.status':        isImmediate ? 'paused' : 'active',
        'superAdmin.pausedAt':      isImmediate ? now : null,
        'superAdmin.pausedBy':      req.user?.name || 'SuperAdmin',
        'superAdmin.pauseReason':   reason || '',
        'superAdmin.scheduledPauseFrom': fromDate,
        'superAdmin.scheduledPauseTo':   toDate,
      },
    });

    await ActivityLog.create({
      tenantId, employeeName: 'SuperAdmin', action: 'tenant_paused',
      description: isImmediate
        ? `Tenant paused immediately. Reason: ${reason || 'not specified'}`
        : `Tenant pause scheduled from ${fromDate.toDateString()}${toDate ? ' to ' + toDate.toDateString() : ''}`,
    });

    res.json({
      message: isImmediate ? 'Tenant paused successfully' : `Pause scheduled from ${fromDate.toDateString()}`,
      isImmediate,
      pauseFrom: fromDate,
      pauseTo:   toDate,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to pause tenant' });
  }
};

exports.resumeTenant = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { resumeAt } = req.body || {}; // guard against undefined body

    const now = new Date();
    const resumeDate = resumeAt ? new Date(resumeAt) : now;
    const isImmediate = resumeDate <= now;

    // Use $set for status fields + $unset for optional schedule fields
    await Tenant.findByIdAndUpdate(tenantId, {
      $set: {
        'superAdmin.status':      'active',
        'superAdmin.pausedAt':    null,
        'superAdmin.pauseReason': '',
      },
      $unset: {
        'superAdmin.scheduledPauseFrom': '',
        'superAdmin.scheduledPauseTo':   '',
      },
    }, { strict: false });

    // Log activity — non-blocking
    try {
      await ActivityLog.create({
        tenantId,
        employeeName: 'SuperAdmin',
        action: 'tenant_resumed',
        description: 'Tenant access restored',
      });
    } catch(logErr) { /* non-blocking */ }

    res.json({ message: 'Tenant resumed successfully' });

  } catch (err) {
    console.error('[SuperAdmin] resumeTenant error:', err.message, err.stack);
    res.status(500).json({ message: 'Failed to resume tenant', error: err.message });
  }
};

// ─── CHECK SCHEDULED PAUSES (called by cron or on demand) ────────────────────
exports.processScheduledPauses = async (req, res) => {
  try {
    const now = new Date();

    // Activate scheduled pauses that are due
    const toActivate = await Tenant.find({
      'superAdmin.status': 'active',
      'superAdmin.scheduledPauseFrom': { $lte: now },
    }).lean();

    for (const t of toActivate) {
      await Tenant.findByIdAndUpdate(t._id, {
        $set: { 'superAdmin.status': 'paused', 'superAdmin.pausedAt': now }
      });
    }

    // Resume tenants whose scheduled pause period has ended
    const toResume = await Tenant.find({
      'superAdmin.status': 'paused',
      'superAdmin.scheduledPauseTo': { $lte: now, $ne: null },
    }).lean();

    for (const t of toResume) {
      await Tenant.findByIdAndUpdate(t._id, {
        $set: {
          'superAdmin.status': 'active',
          'superAdmin.pausedAt': null,
          'superAdmin.scheduledPauseFrom': null,
          'superAdmin.scheduledPauseTo': null,
        }
      });
      await ActivityLog.create({
        tenantId: t._id, employeeName: 'System', action: 'tenant_resumed',
        description: 'Tenant auto-resumed after scheduled pause period ended',
      });
    }

    res.json({ activated: toActivate.length, resumed: toResume.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── UPDATE LIMITS ────────────────────────────────────────────────────────────
exports.updateLimits = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { employeeLimit, whatsappLimit } = req.body;

    const update = {};
    if (employeeLimit !== undefined) update['superAdmin.employeeLimit'] = Number(employeeLimit);
    if (whatsappLimit !== undefined) update['superAdmin.whatsappLimit'] = Number(whatsappLimit);

    await Tenant.findByIdAndUpdate(tenantId, { $set: update });

    await ActivityLog.create({
      tenantId, employeeName: 'SuperAdmin', action: 'limit_changed',
      description: `Limits updated: employees=${employeeLimit}, whatsapp=${whatsappLimit}`,
    });

    res.json({ message: 'Limits updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update limits' });
  }
};

// ─── UPDATE FEATURES ──────────────────────────────────────────────────────────
exports.updateFeatures = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { features } = req.body; // { tasks: true, fms: false, ... }

    const update = {};
    Object.keys(features).forEach(f => {
      update[`superAdmin.features.${f}`] = features[f];
    });

    await Tenant.findByIdAndUpdate(tenantId, { $set: update });

    res.json({ message: 'Features updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update features' });
  }
};

// ─── UPDATE BILLING ───────────────────────────────────────────────────────────
exports.updateBilling = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { plan, amount, renewalDate, billingNote, status } = req.body;

    // Update tenant superAdmin billing fields
    await Tenant.findByIdAndUpdate(tenantId, {
      $set: {
        'superAdmin.plan':        plan,
        'superAdmin.amount':      amount,
        'superAdmin.renewalDate': renewalDate,
        'superAdmin.billingNote': billingNote || '',
      },
    });

    // Create billing record
    await Billing.create({ tenantId, plan, amount, renewalDate, status: status || 'paid', notes: billingNote });

    await ActivityLog.create({
      tenantId, employeeName: 'SuperAdmin', action: 'plan_changed',
      description: `Plan changed to ${plan} — ₹${amount}`,
    });

    res.json({ message: 'Billing updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update billing' });
  }
};

// ─── RESET ADMIN PASSWORD ─────────────────────────────────────────────────────
exports.resetAdminPassword = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    // Update the tenant admin password (stored in Tenant model)
    await Tenant.findByIdAndUpdate(tenantId, { $set: { password: hashed } });

    res.json({ message: 'Admin password reset successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to reset password' });
  }
};

// ─── GET ACTIVITY LOG ─────────────────────────────────────────────────────────
exports.getActivityLog = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { page = 1, limit = 50, action, employeeId, from, to } = req.query;

    const filter = { tenantId };
    if (action)     filter.action = action;
    if (employeeId) filter.employeeId = employeeId;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      ActivityLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      ActivityLog.countDocuments(filter),
    ]);

    res.json({ logs, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch activity log' });
  }
};

// ─── GET GLOBAL ACTIVITY FEED (all tenants) ───────────────────────────────────
exports.getGlobalFeed = async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const logs = await ActivityLog.find({})
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .populate('tenantId', 'companyName subdomain')
      .lean();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch global feed' });
  }
};

// ─── GET DASHBOARD STATS ──────────────────────────────────────────────────────
exports.getDashboardStats = async (req, res) => {
  try {
    const tenants   = await Tenant.find({}).lean();
    const monthStart = new Date(new Date().setDate(1));

    const [
      totalTenants,
      activeTenants,
      totalEmployees,
      totalActions,
    ] = await Promise.all([
      tenants.length,
      tenants.filter(t => t.superAdmin?.status !== 'paused').length,
      Employee.countDocuments({}),
      ActivityLog.countDocuments({ createdAt: { $gte: monthStart } }),
    ]);

    // Revenue this month
    const billingAgg = await Billing.aggregate([
      { $match: { createdAt: { $gte: monthStart }, status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const revenueThisMonth = billingAgg[0]?.total || 0;

    // Active users in last 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeUsers = await ActivityLog.distinct('employeeId', {
      action: 'login',
      createdAt: { $gte: oneDayAgo },
    });

    res.json({
      totalTenants,
      activeTenants,
      pausedTenants: totalTenants - activeTenants,
      totalEmployees,
      totalActionsThisMonth: totalActions,
      revenueThisMonth,
      activeUsersToday: activeUsers.length,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
};

// ─── UPDATE INTERNAL NOTE ─────────────────────────────────────────────────────
exports.updateNote = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { note } = req.body;
    await Tenant.findByIdAndUpdate(tenantId, { $set: { 'superAdmin.internalNote': note } });
    res.json({ message: 'Note saved' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to save note' });
  }
};