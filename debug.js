// Run this from ~/Desktop/work-pilot/server/
// node debug.js

const files = [
    './routes/taskRoutes.js',
    './routes/tenantRoutes.js', 
    './routes/fmsRoutes.js',
    './routes/reportRoutes.js',
    './routes/ticketRoutes.js',
    './routes/newFmsRoutes.js',
    './middleware/auth.js',
    './middleware/subscriptionGuard.js',
    './controllers/tenantController.js',
    './utils/briefingEngine.js',
    './utils/fmsNotifier.js',
    './utils/flowEngine.js',
    './models/FlowTemplate.js',
    './models/FlowInstance.js',
  ];
  
  console.log('Testing each require...\n');
  files.forEach(f => {
    try {
      require(f);
      console.log('✅ OK:', f);
    } catch(e) {
      console.log('❌ FAIL:', f);
      console.log('   Error:', e.message);
    }
  });