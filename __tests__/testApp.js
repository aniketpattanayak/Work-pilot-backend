// Builds a minimal Express app wired exactly like the real server for the
// FMS route trees, so HTTP-level tests exercise the real middleware chain
// (authMiddleware -> subscriptionGuard -> tenantDbMiddleware -> controller).
const express = require('express');
const jwt = require('jsonwebtoken');

function buildApp() {
  const app = express();
  app.use(express.json());

  const fmsRoutes = require('../routes/fmsRoutes');
  const newFmsRoutes = require('../routes/newFmsRoutes');

  app.use('/api/fms', fmsRoutes);
  app.use('/api/fms2', newFmsRoutes);

  return app;
}

function tokenFor(user) {
  return jwt.sign(user, process.env.JWT_SECRET);
}

module.exports = { buildApp, tokenFor };
