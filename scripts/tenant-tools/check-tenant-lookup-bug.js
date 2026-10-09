require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');

const ARV_TENANT_ID = '6ab234b5dfaa60ec91448715';

(async () => {
  try {
    const sharedConn = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
    const SharedTenant = sharedConn.models.Tenant || sharedConn.model('Tenant', Tenant.schema);
    const tenantDoc = await SharedTenant.findById(ARV_TENANT_ID).lean();
    const customUri = tenantDoc.superAdmin.customMongoUri;

    // Replicate exactly what tenantDbMiddleware does for a real ARV request
    const customConn = await mongoose.createConnection(customUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    const DedicatedTenant = customConn.models.Tenant || customConn.model('Tenant', Tenant.schema);

    console.log('Looking up ARV\'s own Tenant record on the SHARED connection (what my direct test used):');
    console.log('  Found:', !!tenantDoc, tenantDoc ? `(${tenantDoc.companyName})` : '');

    console.log('\nLooking up ARV\'s own Tenant record on ARV\'s DEDICATED connection (what a real browser request uses):');
    const dedicatedResult = await DedicatedTenant.findById(ARV_TENANT_ID).lean();
    console.log('  Found:', !!dedicatedResult, dedicatedResult ? `(${dedicatedResult.companyName})` : '(null — this is the bug, if so)');

    await sharedConn.close();
    await customConn.close();
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
})();
