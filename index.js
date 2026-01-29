const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

// 1. Import Route Files
const ticketRoutes = require('./routes/ticketRoutes');
// UPDATED: Points to taskRoutes.js where your review analytics route is defined
const taskRoutes = require('./routes/taskRoutes'); 

// 2. Initialize Express App FIRST
const app = express();

// --- CORS CONFIGURATION (Preserved) ---
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
app.use(express.urlencoded({ extended: true }));
/**
 * 3. REGISTER ROUTES
 * All routes are mounted after app initialization.
 */
app.use('/api/tickets', ticketRoutes); // Support Ticketing System

// Multi-tenant and Task Routes
/**
 * ROUTE CORRECTION:
 * Both /superadmin and /tasks prefixes are now directed to taskRoutes.js.
 * This ensures the '/review-analytics' endpoint is correctly found.
 */
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