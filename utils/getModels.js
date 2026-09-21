/**
 * getModels.js
 * Returns mongoose models bound to the correct DB connection.
 * If tenant has customMongoUri → uses their DB connection
 * Otherwise → uses the default shared connection
 */
const mongoose = require('mongoose');
const { getTenantConnection } = require('./tenantDb');

// Import schemas (not models) so we can bind them to any connection
const employeeSchema    = require('../models/Employee').schema;
const taskSchema        = require('../models/DelegationTask').schema;
const checklistSchema   = require('../models/ChecklistTask').schema;
const flowInstanceSchema= require('../models/FlowInstance').schema;
const flowTemplateSchema= require('../models/FlowTemplate').schema;
const tenantSchema      = require('../models/Tenant').schema;

async function getModels(tenantId, customMongoUri) {
  const conn = customMongoUri
    ? await getTenantConnection(tenantId, customMongoUri)
    : mongoose.connection;

  return {
    Employee:      conn.model('Employee',      employeeSchema),
    DelegationTask:conn.model('DelegationTask',taskSchema),
    ChecklistTask: conn.model('ChecklistTask', checklistSchema),
    FlowInstance:  conn.model('FlowInstance',  flowInstanceSchema),
    FlowTemplate:  conn.model('FlowTemplate',  flowTemplateSchema),
    Tenant:        conn.model('Tenant',        tenantSchema),
  };
}

module.exports = { getModels };
