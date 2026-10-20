// routes/configRoutes.js  (mounted at /api/config)
// Tenant configuration: custom fields and table column preferences.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const subscriptionGuard = require('../middleware/subscriptionGuard');
const tenantDbMiddleware = require('../middleware/tenantDb');
const c = require('../controllers/configController');
const st = require('../controllers/settingsController');
const fm = require('../controllers/formController');
const _upload = require('../utils/s3Uploader');

const base = [authMiddleware, subscriptionGuard, tenantDbMiddleware];

router.get('/fields/:entity',  ...base, c.getFields);
router.post('/fields/:entity', ...base, c.saveFields);

router.get('/table-preferences/:tableKey',    ...base, c.getTablePreference);
router.post('/table-preferences/:tableKey',   ...base, c.saveTablePreference);
router.delete('/table-preferences/:tableKey', ...base, c.resetTablePreference);

// Form designer: layout of every form, lists a dropdown can be linked to, uploads for file fields
router.get('/forms', ...base, fm.listForms);
router.get('/forms/:form', ...base, fm.getForm);
router.put('/forms/:form', ...base, fm.saveForm);
router.delete('/forms/:form', ...base, fm.resetForm);
router.get('/master-lists', ...base, fm.getMasterLists);
router.put('/master-lists', ...base, fm.saveMasterLists);
router.get('/lookup/:source', ...base, fm.getLookup);
router.post('/field-upload', ...base, _upload.single('file'), fm.uploadFieldFile);

router.get('/settings/effective', ...base, st.getEffective);
router.get('/settings', ...base, st.getSettings);
router.put('/settings/switches', ...base, st.saveSwitches);
router.put('/settings/date-reasons', ...base, st.saveDateReasons);
router.put('/settings/whatsapp-templates/:key', ...base, st.saveTemplate);
router.delete('/settings/whatsapp-templates/:key', ...base, st.resetTemplate);

module.exports = router;
