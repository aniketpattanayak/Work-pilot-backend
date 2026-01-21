const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

// 1. Import Route Files
const ticketRoutes = require('./routes/ticketRoutes');
const tenantRoutes = require('./routes/tenantRoutes');

// 2. Initialize Express App FIRST
// This fixes the "ReferenceError: Cannot access 'app' before initialization"
const app = express();

// --- UPDATED CORS CONFIGURATION (Preserved) ---
app.use(cors({
  origin: [
    "http://localhost:5173", 
    /^http:\/\/.*\.localhost:5173$/,
    "https://www.lrbcloud.ai",
    "https://lrbcloud.ai",
    /\.lrbcloud\.ai$/   // Allows test.lrbcloud.ai, etc.
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
// ----------------------------------

// Middleware
app.use(express.json());

/**
 * 3. REGISTER ROUTES
 * All routes are mounted after app initialization.
 */
app.use('/api/tickets', ticketRoutes); // Support Ticketing System

// Multi-tenant and Task Routes
// Matches VITE_API_URL=https://api.lrbcloud.ai/api
app.use('/api/superadmin', tenantRoutes);
app.use('/api/tasks', tenantRoutes); 

// Debugging Middleware: Catch 404s (Preserved)
app.use((req, res) => {
    console.log(`404 Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ 
        message: `Route ${req.originalUrl} not found on this server.`,
        receivedPath: req.originalUrl 
    });
});

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected..."))
  .catch(err => console.log("❌ DB Connection Error:", err));

// Server Initialization
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});