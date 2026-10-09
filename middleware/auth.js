// server/middleware/auth.js
// FIX S-2: Authentication middleware — was completely missing from the project.
// Apply this to every route that requires a logged-in user.

const jwt = require('jsonwebtoken');

/**
 * Verifies the JWT token sent in the Authorization header.
 * On success, attaches the decoded payload to req.user:
 *   { id, roles, tenantId, isSuperAdmin? }
 */
// A "Viewer-only" account has the Viewer role and nothing else. It may read the whole
// company but can never change anything (except raise a support ticket).
const isViewerOnly = (user) =>
  !!user && !user.isSuperAdmin &&
  Array.isArray(user.roles) && user.roles.length > 0 &&
  user.roles.every((r) => String(r).toLowerCase() === 'viewer');

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const VIEWER_WRITE_ALLOWLIST = [/\/tickets\/create\/?$/];

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    if (isViewerOnly(decoded) && !SAFE_METHODS.includes(req.method)) {
      const urlPath = String(req.originalUrl || req.url || '').split('?')[0];
      if (!VIEWER_WRITE_ALLOWLIST.some((re) => re.test(urlPath))) {
        return res.status(403).json({ message: 'View-only access: this account cannot make changes.' });
      }
    }
    next();
  } catch (err) {
    // Distinguish expired tokens from invalid ones for cleaner client UX
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ message: 'Invalid token.' });
  }
};

/**
 * Requires the authenticated user to be a SuperAdmin.
 * Must be used AFTER authMiddleware.
 */
const superAdminOnly = (req, res, next) => {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ message: 'Forbidden. SuperAdmin access required.' });
  }
  next();
};

/**
 * Verifies the authenticated user belongs to the tenant
 * identified by req.params.tenantId or req.body.tenantId.
 * FIX S-6: Prevents cross-tenant IDOR attacks.
 * Must be used AFTER authMiddleware.
 */
const sameTenantOnly = (req, res, next) => {
  // SuperAdmins can access any tenant
  if (req.user?.isSuperAdmin) return next();

  const requestedTenantId =
    req.params.tenantId ||
    req.body.tenantId ||
    req.query.tenantId;

  if (!requestedTenantId) return next(); // no tenant in route — let controller decide

  if (req.user?.tenantId?.toString() !== requestedTenantId.toString()) {
    return res.status(403).json({ message: 'Forbidden. You do not have access to this company.' });
  }
  next();
};

// ── Per-tenant DB switcher ────────────────────────────────────────────────────
// Add after authMiddleware to switch to tenant's custom DB if configured
const tenantDbMiddleware = async (req, res, next) => {
  try {
    if (!req.user?.tenantId) return next();
    const Tenant = require('../models/Tenant');
    const tenant = await Tenant.findById(req.user.tenantId)
      .select('superAdmin.customMongoUri')
      .lean();
    const customUri = tenant?.superAdmin?.customMongoUri;
    if (customUri) {
      const { getTenantConnection } = require('../utils/tenantDb');
      req.tenantDb = await getTenantConnection(req.user.tenantId.toString(), customUri);
    } else {
      req.tenantDb = null; // use default shared DB
    }
    next();
  } catch (err) {
    console.error('[TenantDB] Middleware error:', err.message);
    req.tenantDb = null;
    next();
  }
};

module.exports = { authMiddleware, superAdminOnly, sameTenantOnly, tenantDbMiddleware, isViewerOnly };
