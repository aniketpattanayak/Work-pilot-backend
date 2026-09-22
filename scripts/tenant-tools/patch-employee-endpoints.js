const path = require('path');
const safePatch = require('./safe-patch');

const SERVER_ROOT = path.join(__dirname, '..', '..'); // scripts/tenant-tools -> ../.. -> server/

// 1. routes/chatRoutes.js — attach tenantDbMiddleware to the /employees route
safePatch(
  path.join(SERVER_ROOT, 'routes/chatRoutes.js'),
  `const { authMiddleware } = require('../middleware/auth');`,
  `const { authMiddleware } = require('../middleware/auth');\nconst tenantDbMiddleware = require('../middleware/tenantDb');`
);
safePatch(
  path.join(SERVER_ROOT, 'routes/chatRoutes.js'),
  `router.get ('/employees',                  authMiddleware, c.getEmployees);`,
  `router.get ('/employees',                  authMiddleware, tenantDbMiddleware, c.getEmployees);`
);

// 2. controllers/chatController.js — getEmployees() now uses req.db when present
safePatch(
  path.join(SERVER_ROOT, 'controllers/chatController.js'),
  `exports.getEmployees = async (req, res) => {
  try {
    const tenantId   = req.user.tenantId;
    const employeeId = req.user.id;

    const employees = await Employee.find({`,
  `exports.getEmployees = async (req, res) => {
  try {
    const tenantId   = req.user.tenantId;
    const employeeId = req.user.id;
    const EmployeeModel = req.db ? req.db.model('Employee') : Employee;

    const employees = await EmployeeModel.find({`
);

// 3. routes/taskRoutes.js — the /employees (no tenantId) handler now uses req.db
safePatch(
  path.join(SERVER_ROOT, 'routes/taskRoutes.js'),
  `    const Employee = require('../models/Employee');`,
  `    const Employee = req.db ? req.db.model('Employee') : require('../models/Employee');`
);
