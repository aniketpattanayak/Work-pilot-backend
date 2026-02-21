const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const cron = require('node-cron');

// --- 1. IMPORT ROUTE FILES ---
const fmsRoutes = require('./routes/fmsRoutes'); 
const ticketRoutes = require('./routes/ticketRoutes');
const taskRoutes = require('./routes/taskRoutes'); 
const reportRoutes = require('./routes/reportRoutes'); 

// --- 2. IMPORT SERVICES & SCHEDULERS ---
const initReportScheduler = require('./jobs/cronScheduler'); 
const { dispatchDailyBriefings } = require('./controllers/taskController'); // NEW: Added Briefing Service

// 3. Initialize Express App
const app = express();

/**
 * 4. CORS CONFIGURATION
 * This allows your frontend (Vite/localhost:5173) to talk to this backend.
 */
app.use(cors({
  origin: [
    "http://localhost:5173", 
    /^http:\/\/.*\.localhost:5173$/, // Allows all local subdomains
    "https://lrbcloud.ai",
    "https://www.lrbcloud.ai",
    /\.lrbcloud\.ai$/                // Allows any factory: lrbc, arv, colorplas, etc.
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

/**
 * 5. DATA PARSING MIDDLEWARE
 * Allows the server to read JSON and form-data sent from FMS forms.
 */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * 6. REGISTER ROUTES
 * Routes are mounted after CORS and Body Parser for correct operational flow.
 */

// FMS Logic
app.use('/api/fms', fmsRoutes);

// Support Ticketing System
app.use('/api/tickets', ticketRoutes); 

// Report & Analytics Routes
app.use('/api/reports', reportRoutes);

// Multi-tenant and Task Routes
app.use('/api/superadmin', taskRoutes);
app.use('/api/tasks', taskRoutes); 

// Debugging Middleware: Catch 404s (Preserved)
app.use((req, res) => {
    console.log(`404 Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ 
        message: `Route ${req.originalUrl} not found on this server.`,
        receivedPath: req.originalUrl 
    });
});

/**
 * 7. DATABASE & SCHEDULER INITIALIZATION
 */
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB Connected...");
    
    // --- START AUTOMATED REPORT SCHEDULER ---
    initReportScheduler();
    console.log("⏰ LRBC Report Scheduler Initiated.");

    // --- START DAILY MISSION BRIEFING ENGINE ---
    // Cron runs every minute to check factory-specific lead times (2h before opening).
    cron.schedule('* * * * *', () => {
      dispatchDailyBriefings();
    });
    console.log("🌅 LRBC Daily Briefing Engine Active.");
  })
  .catch(err => console.log("❌ DB Connection Error:", err));

// Server Initialization
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});