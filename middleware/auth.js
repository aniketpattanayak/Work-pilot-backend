// server/middleware/auth.js
// FIX S-2: Authentication middleware — was completely missing from the project.
// Apply this to every route that requires a logged-in user.

const jwt = require('jsonwebtoken');

/**
 * Verifies the JWT token sent in the Authorization header.
 * On success, attaches the decoded payload to req.user:
 *   { id, roles, tenantId, isSuperAdmin? }
 */
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
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

module.exports = { authMiddleware, superAdminOnly, sameTenantOnly };
