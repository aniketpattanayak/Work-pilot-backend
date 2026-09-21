const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const { getTenantConnection } = require('../utils/tenantDb');

// Cache URIs for 5 minutes to avoid DB lookup every request
const uriCache = {};

const tenantDbMiddleware = async (req, res, next) => {
  try {
    const tenantId = req.user?.tenantId?.toString();
    if (!tenantId) return next();

    // Check cache first
    const now = Date.now();
    if (uriCache[tenantId] && uriCache[tenantId].expires > now) {
      req.customMongoUri = uriCache[tenantId].uri;
    } else {
      const tenant = await Tenant.findById(tenantId).select('superAdmin.customMongoUri').lean();
      const uri = tenant?.superAdmin?.customMongoUri || null;
      uriCache[tenantId] = { uri, expires: now + 5 * 60 * 1000 };
      req.customMongoUri = uri;
    }

    if (req.customMongoUri) {
      const conn = await getTenantConnection(tenantId, req.customMongoUri);
      // Register all models on this connection
      const schemas = {
        Employee:       require('../models/Employee').schema,
        DelegationTask: require('../models/DelegationTask').schema,
        ChecklistTask:  require('../models/ChecklistTask').schema,
        FlowInstance:   require('../models/FlowInstance').schema,
        FlowTemplate:   require('../models/FlowTemplate').schema,
      };
      for (const [name, schema] of Object.entries(schemas)) {
        if (!conn.models[name]) conn.model(name, schema);
      }
      req.db = conn;
    } else {
      req.db = null; // null = use default models via require()
    }
    next();
  } catch (err) {
    console.error('[TenantDB Middleware]', err.message);
    req.db = mongoose.connection;
    next();
  }
};

module.exports = tenantDbMiddleware;
