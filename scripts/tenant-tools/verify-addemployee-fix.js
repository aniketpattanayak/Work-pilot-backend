require('dotenv').config();
const mongoose = require('mongoose');

const ARV_TENANT_ID = '6ab234b5dfaa60ec91448715';
const TEST_PHONE    = process.argv[2] || '917008587132';

(async () => {
  let customConn;
  try {
    // Establish the DEFAULT connection (mongoose.connection) — this is what
    // require('../models/Tenant') now binds to, same as in production.
    await mongoose.connect(process.env.MONGO_URI);

    const Tenant = require('../../models/Tenant');
    const tenantDoc = await Tenant.findById(ARV_TENANT_ID).lean();
    const customUri = tenantDoc.superAdmin.customMongoUri;

    // Separately, ARV's dedicated connection — for the Employee document itself.
    customConn = await mongoose.createConnection(customUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    const modelFiles = ['Employee', 'DelegationTask', 'ChecklistTask', 'FlowInstance', 'FlowTemplate', 'Conversation', 'Message', 'OrderSubmission', 'Ticket'];
    for (const name of modelFiles) {
      if (!customConn.models[name]) {
        try { customConn.model(name, require(`../../models/${name}`).schema); } catch (e) {}
      }
    }

    const tenantController = require('../../controllers/tenantController');
    const uniqueEmail = `whatsapp-fix-test-${Date.now()}@arvcompanies.com`;

    const fakeReq = {
      body: {
        tenantId: ARV_TENANT_ID,
        name: 'WhatsApp Fix Verification',
        email: uniqueEmail,
        department: 'Testing',
        whatsappNumber: TEST_PHONE,
        roles: ['Doer'],
        password: 'TempPassword123!',
        managedDoers: [],
        managedAssigners: [],
        workOnSunday: false,
      },
      db: customConn,
    };

    const fakeRes = {
      status: (code) => ({
        json: (payload) => console.log(`\n[addEmployee responded] HTTP ${code}:`, JSON.stringify(payload).slice(0, 200)),
      }),
    };

    console.log(`Calling addEmployee() with req.db = ARV's real dedicated connection.\nEmail: ${uniqueEmail}\n`);
    await tenantController.addEmployee(fakeReq, fakeRes);
    console.log(`\nTo clean up: node scripts/tenant-tools/find-and-delete-test-employee.js ${uniqueEmail}`);
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
    if (customConn) await customConn.close();
  }
})();
