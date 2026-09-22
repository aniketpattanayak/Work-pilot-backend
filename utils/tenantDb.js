/**
 * tenantDb.js
 * Manages per-tenant MongoDB connections.
 * If tenant has customMongoUri, uses that. Otherwise uses the default connection.
 */
const mongoose = require('mongoose');

const connections = {}; // cache of tenantId -> mongoose connection

async function getTenantConnection(tenantId, mongoUri) {
  if (!mongoUri) return mongoose.connection; // use default shared DB
  
  if (connections[tenantId]) {
    // Return cached connection if still open
    if (connections[tenantId].readyState === 1) return connections[tenantId];
  }

  try {
    const conn = await mongoose.createConnection(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    }).asPromise();
    connections[tenantId] = conn;
    console.log(`[TenantDB] Connected to custom DB for tenant ${tenantId}`);
    return conn;
  } catch (err) {
    console.error(`[TenantDB] Failed to connect custom DB for tenant ${tenantId}:`, err.message);
    throw err; // let middleware handle fallback
  }
}

module.exports = { getTenantConnection };
