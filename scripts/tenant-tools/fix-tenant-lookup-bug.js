const path = require('path');
const safePatch = require('./safe-patch');
const SERVER_ROOT = path.join(__dirname, '..', '..');

safePatch(
  path.join(SERVER_ROOT, 'controllers/taskController.js'),
  `    Tenant:         safeModel(db, 'Tenant',         require('../models/Tenant')),`,
  `    Tenant:         require('../models/Tenant'), // Tenant records are platform metadata — always shared, never per-tenant-DB`
);

safePatch(
  path.join(SERVER_ROOT, 'controllers/tenantController.js'),
  `    Tenant:         safeModel(db, 'Tenant',         require('../models/Tenant')),`,
  `    Tenant:         require('../models/Tenant'), // Tenant records are platform metadata — always shared, never per-tenant-DB`
);
