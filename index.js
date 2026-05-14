// server/index.js
// FIXES APPLIED:
//   S-3: CORS origin validator replaces leaky regex
//   B-2: runFmsSync() moved inside .then() callback so it runs after DB connects

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

// --- 1. IMPORT ROUTE FILES ---
const fmsRoutes    = require('./routes/fmsRoutes');
const newFmsRoutes = require('./routes/newFmsRoutes');
const ticketRoutes = require('./routes/ticketRoutes');
const taskRoutes = require('./routes/taskRoutes');
const reportRoutes = require('./routes/reportRoutes');

// --- 2. IMPORT SERVICES & SCHEDULERS ---
const initReportScheduler = require('./jobs/cronScheduler');
// FIX P-1: briefingEngine replaces the every-minute dispatchDailyBriefings polling.
//          Each tenant now gets its own cron job at exactly the right time.
const { scheduleBriefings } = require('./utils/briefingEngine');
const startFmsNotifier      = require('./utils/fmsNotifier');

// 3. Initialize Express App
const app = express();

/**
 * 4. CORS CONFIGURATION
 * FIX S-3: Replaced the /\.lrbcloud\.ai$/ regex which matched attacker-owned
 * domains like evillrbcloud.ai. Now uses an explicit allowlist + a validated
 * subdomain check that requires the host to be a STRICT subdomain.
 */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:5174',
  'https://lrbcloud.ai',
  'https://www.lrbcloud.ai',
]);

// Matches *.lrbcloud.ai subdomains (prod) AND *.localhost:PORT (local dev)
const SUBDOMAIN_RE = /^https?:\/\/[a-z0-9-]+\.(?:lrbcloud\.ai|localhost(?::\d+)?)$/;

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server / curl requests (no origin header)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.has(origin) || SUBDOMAIN_RE.test(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// 5. DATA PARSING MIDDLEWARE
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve locally uploaded files (used when S3 is not configured)
const path = require('path');
app.use('/uploads', require('express').static(path.join(__dirname, 'uploads')));

// 6. REGISTER ROUTES
app.use('/api/fms',  fmsRoutes);     // old FMS (kept for compatibility)
app.use('/api/fms2', newFmsRoutes);  // new FMS engine
app.use('/api/tickets', ticketRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/superadmin', taskRoutes);
app.use('/api/tasks', taskRoutes);

// Catch-all 404
app.use((req, res) => {
  console.log(`404 Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    message: `Route ${req.originalUrl} not found on this server.`,
    receivedPath: req.originalUrl,
  });
});

/**
 * 7. DATABASE & SCHEDULER INITIALIZATION
 * FIX B-2: ALL schedulers are now started inside the .then() callback,
 * guaranteeing MongoDB is connected before any cron job fires.
 * runFmsSync() was previously called at module level after this block,
 * meaning it ran before the DB was ready.
 */
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB Connected...');

    // Report scheduler
    initReportScheduler();
    console.log('⏰ LRBC Report Scheduler Initiated.');

    // FIX P-1: Per-tenant precision scheduling replaces the every-minute polling loop.
    // Old: cron every minute → check ALL tenants → N+1 DB queries per tick.
    // New: one cron job per tenant, fires exactly at their 2-hour lead time.
    scheduleBriefings().then(() => {
      console.log('🌅 LRBC Daily Briefing Engine Active (per-tenant scheduling).');
    });

    // FIX B-2: FMS sync now starts AFTER the DB is open
    const runFmsSync = require('./utils/fmsScheduler');
    runFmsSync();
    console.log('🔄 FMS Auto Sync Scheduler Active.');

    // New FMS WhatsApp notification engine
    startFmsNotifier();
  })
  .catch(err => console.log('❌ DB Connection Error:', err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});