const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const { getTenantConnection } = require('../utils/tenantDb');

const uriCache = {};

const tenantDbMiddleware = async (req, res, next) => {
  try {
    const tenantId = req.user?.tenantId?.toString();
    if (!tenantId) return next();

    const now = Date.now();
    if (!uriCache[tenantId] || uriCache[tenantId].expires < now) {
      const tenant = await Tenant.findById(tenantId).select('superAdmin.customMongoUri').lean();
      uriCache[tenantId] = {
        uri: tenant?.superAdmin?.customMongoUri || null,
        expires: now + 5 * 60 * 1000
      };
    }

    const customUri = uriCache[tenantId].uri;
    console.log('[TenantDB] tenant:', tenantId, 'customUri:', customUri ? 'SET' : 'NULL');
    if (customUri) {
      const conn = await getTenantConnection(tenantId, customUri);
      // Register all models on this connection
      const modelFiles = [
        'Employee', 'DelegationTask', 'ChecklistTask',
        'FlowInstance', 'FlowTemplate', 'Tenant',
        'Chat', 'Conversation', 'OrderSubmission', 'Ticket'
      ];
      for (const name of modelFiles) {
        if (!conn.models[name]) {
          try {
            const schema = require(`../models/${name}`).schema;
            conn.model(name, schema);
          } catch(e) {}
        }
      }
      req.db = conn;
    } else {
      req.db = null;
    }
    next();
  } catch (err) {
    console.error('[TenantDB]', err.message);
    req.db = null;
    next();
  }
};

module.exports = tenantDbMiddleware;
