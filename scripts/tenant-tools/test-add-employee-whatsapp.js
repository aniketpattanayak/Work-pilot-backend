require('dotenv').config();
const mongoose = require('mongoose');

const ARV_TENANT_ID = '6ab234b5dfaa60ec91448715';
const TEST_PHONE    = process.argv[2] || '917008587132';

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const tenantController = require('../../controllers/tenantController');
    const uniqueEmail = `whatsapp-test-${Date.now()}@arvcompanies.com`;

    const fakeReq = {
      body: {
        tenantId: ARV_TENANT_ID,
        name: 'WhatsApp Test Employee',
        email: uniqueEmail,
        department: 'Testing',
        whatsappNumber: TEST_PHONE,
        roles: ['Doer'],
        password: 'TempPassword123!',
        managedDoers: [],
        managedAssigners: [],
        workOnSunday: false,
      },
      db: null,
    };

    let createdId = null;
    const fakeRes = {
      status: (code) => ({
        json: (payload) => {
          createdId = payload?._id || payload?.employee?._id || null;
          console.log(`\n[addEmployee responded] HTTP ${code}:`, JSON.stringify(payload).slice(0, 300));
        },
      }),
    };

    console.log(`Calling the real, deployed addEmployee() for ARV — email: ${uniqueEmail}, phone: ${TEST_PHONE}`);
    console.log('Watch for [Maytapi] / [DoubleTick] / "Welcome Template Failed" below:\n');

    await tenantController.addEmployee(fakeReq, fakeRes);

    console.log(`\nTo clean up this test employee afterward, delete by email in the DB:\n  ${uniqueEmail}`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
  } finally {
    await mongoose.disconnect();
  }
})();
