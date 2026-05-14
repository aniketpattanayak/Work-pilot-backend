// server/middleware/subscriptionGuard.js
// Checks if the authenticated user's company has an active subscription.
// If paused, returns 403 with a structured error the frontend can display.
// SuperAdmins are never blocked so they can always access the console.

const Tenant = require('../models/Tenant');

const subscriptionGuard = async (req, res, next) => {
  try {
    // SuperAdmins bypass the guard entirely
    if (req.user?.isSuperAdmin) return next();

    const tenantId = req.user?.tenantId;
    if (!tenantId) return next(); // no tenant context — let auth handle it

    const tenant = await Tenant.findById(tenantId).select('subscription companyName').lean();
    if (!tenant) return next();

    if (tenant.subscription?.status === 'paused') {
      return res.status(403).json({
        code:    'SUBSCRIPTION_PAUSED',
        message: 'Your company subscription is currently paused.',
        reason:  tenant.subscription.reason || 'Contact your administrator.',
        pausedAt: tenant.subscription.pausedAt,
      });
    }

    next();
  } catch (err) {
    // Don't block on guard errors — fail open
    console.error('[SubscriptionGuard] Error:', err.message);
    next();
  }
};

module.exports = subscriptionGuard;