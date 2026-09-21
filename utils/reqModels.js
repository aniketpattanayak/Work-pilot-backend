/**
 * reqModels.js
 * Provides request-scoped models that use the correct DB connection.
 * Usage in controller: const M = await getReqModels(req);
 * Then use M.Employee, M.FlowInstance etc. instead of direct imports.
 */
const mongoose = require('mongoose');
const { getTenantConnection } = require('./tenantDb');
const Tenant = require('../models/Tenant');

// Cache connection URIs to avoid DB lookup every request
const tenantUriCache = {}; // tenantId -> { uri, expires }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getTenantUri(tenantId) {
  const now = Date.now();
  const cached = tenantUriCache[tenantId];
  if (cached && cached.expires > now) return cached.uri;

  const tenant = await Tenant.findById(tenantId)
    .select('superAdmin.customMongoUri')
    .lean();
  const uri = tenant?.superAdmin?.customMongoUri || null;

  tenantUriCache[tenantId] = { uri, expires: now + CACHE_TTL };
  return uri;
}

async function getReqModels(req) {
  const tenantId = req.user?.tenantId?.toString();
  if (!tenantId) return getDefaultModels();

  const customUri = await getTenantUri(tenantId);
  if (!customUri) return getDefaultModels();

  // Use tenant's custom DB connection
  const conn = await getTenantConnection(tenantId, customUri);
  return getModelsForConnection(conn);
}

function getDefaultModels() {
  return {
    Employee:       require('../models/Employee'),
    DelegationTask: require('../models/DelegationTask'),
    ChecklistTask:  require('../models/ChecklistTask'),
    FlowInstance:   require('../models/FlowInstance'),
    FlowTemplate:   require('../models/FlowTemplate'),
    Tenant:         require('../models/Tenant'),
    Chat:           require('../models/Chat'),
    OrderForm:      require('../models/OrderForm'),
    Ticket:         require('../models/Ticket'),
  };
}

function getModelsForConnection(conn) {
  const modelDefs = [
    ['Employee',       '../models/Employee'],
    ['DelegationTask', '../models/DelegationTask'],
    ['ChecklistTask',  '../models/ChecklistTask'],
    ['FlowInstance',   '../models/FlowInstance'],
    ['FlowTemplate',   '../models/FlowTemplate'],
    ['Tenant',         '../models/Tenant'],
    ['Chat',           '../models/Chat'],
    ['OrderForm',      '../models/OrderForm'],
    ['Ticket',         '../models/Ticket'],
  ];

  const models = {};
  for (const [name, path] of modelDefs) {
    try {
      const schema = require(path).schema;
      // Use existing model if already registered on this connection
      models[name] = conn.models[name] || conn.model(name, schema);
    } catch {
      models[name] = require(path); // fallback to default
    }
  }
  return models;
}

module.exports = { getReqModels };
