// server/middleware/subscriptionGuard.js
// Checks if the authenticated user's company has an active subscription.
// IMPORTANT: Must be used AFTER authMiddleware so req.user is populated.
// SuperAdmins are never blocked.

const Tenant = require('../models/Tenant');

const subscriptionGuard = async (req, res, next) => {
  try {
    // No user context yet (unauthenticated request) — let auth handle it
    if (!req.user) return next();

    // SuperAdmins bypass the guard entirely
    if (req.user.isSuperAdmin) return next();

    const tenantId = req.user.tenantId;
    if (!tenantId) return next();

    const tenant = await Tenant.findById(tenantId)
      .select('subscription superAdmin companyName')
      .lean();

    if (!tenant) return next();

    // Check BOTH old subscription field AND new superAdmin.status field
    const isPaused =
      tenant.superAdmin?.status === 'paused' ||
      tenant.superAdmin?.status === 'suspended' ||
      tenant.subscription?.status === 'paused';

    if (isPaused) {
      return res.status(403).json({
        code:     'SUBSCRIPTION_PAUSED',
        message:  'Your account has been paused. Please contact support.',
        reason:   tenant.superAdmin?.pauseReason || tenant.subscription?.reason || 'Contact your administrator.',
        pausedAt: tenant.superAdmin?.pausedAt || tenant.subscription?.pausedAt,
      });
    }

    next();
  } catch (err) {
    console.error('[SubscriptionGuard] Error:', err.message);
    next(); // fail open — don't block on guard errors
  }
};

module.exports = subscriptionGuard;