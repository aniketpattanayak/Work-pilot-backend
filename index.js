const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

// 1. Import Route Files
const fmsRoutes = require('./routes/fmsRoutes'); //
const ticketRoutes = require('./routes/ticketRoutes');
const taskRoutes = require('./routes/taskRoutes'); 

// 2. Initialize Express App
const app = express();

/**
 * 3. CORS CONFIGURATION (Critical: Must be defined before routes)
 * This allows your frontend (Vite/localhost:5173) to talk to this backend.
 */
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

/**
 * 4. DATA PARSING MIDDLEWARE (Critical: Must be defined before routes)
 * This allows the server to read JSON data sent from your FMS Blueprint forms.
 */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * 5. REGISTER ROUTES
 * Routes are now mounted after the CORS and Body Parser middleware to ensure
 * they function correctly.
 */

// FMS Logic
app.use('/api/fms', fmsRoutes);

// Support Ticketing System
app.use('/api/tickets', ticketRoutes); 

// Multi-tenant and Task Routes
// Both /superadmin and /tasks prefixes are directed to taskRoutes.js.
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

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected..."))
  .catch(err => console.log("❌ DB Connection Error:", err));

// Server Initialization
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});