// server/routes/orderFormRoutes.js

const express    = require('express');
const router     = express.Router();
const c          = require('../controllers/orderFormController');
const { authMiddleware, sameTenantOnly } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');

const protect = [authMiddleware, subscriptionGuard];

// Form management (admin)
router.post  ('/forms',                         ...protect, c.upsertForm);
router.get   ('/forms/:tenantId',               ...protect, sameTenantOnly, c.getForms);
router.get   ('/forms/template/:templateId',    ...protect, c.getFormByTemplate);
router.delete('/forms/:formId',                 ...protect, c.deleteForm);

// Order submission (employee/admin)
router.post  ('/forms/submit',                  ...protect, c.submitOrder);

// Submissions list
router.get   ('/submissions/:tenantId',         ...protect, sameTenantOnly, c.getSubmissions);
router.get   ('/submissions/detail/:submissionId', ...protect, c.getSubmissionDetail);

module.exports = router;