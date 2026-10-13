// Boots an in-memory MongoDB (no local mongod available in this sandbox),
// points MONGO_URI at it, then requires the actual regression test so it
// runs against a real, empty Mongo instance.
const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  const mongod = await MongoMemoryServer.create({ instance: { port: 27018, dbName: 'workpilot_test' } });
  process.env.MONGO_URI = mongod.getUri('workpilot_test');
  console.log('In-memory MongoDB ready at', process.env.MONGO_URI);
  require('./test-respond-multi-evidence-regression.js');
})().catch(e => { console.error('Could not start in-memory MongoDB:', e); process.exit(1); });
