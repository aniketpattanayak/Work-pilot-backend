const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

// 1. Import your unified Route file
const tenantRoutes = require('./routes/tenantRoutes');

const app = express();

// Middleware
// --- UPDATED CORS CONFIGURATION ---
app.use(cors({
  origin: [
    "https://www.lrbcloud.ai",
    "https://lrbcloud.ai",
    /\.lrbcloud\.ai$/   // This Regex allows all subdomains (e.g., test.lrbcloud.ai)
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
// ----------------------------------

app.use(express.json());

// 2. Register Routes
app.use('/api/superadmin', tenantRoutes);
app.use('/api/tasks', tenantRoutes); 

// Debugging Middleware: Catch 404s
app.use((req, res) => {
    console.log(`404 Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ message: `Route ${req.originalUrl} not found on this server.` });
});

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected..."))
  .catch(err => console.log("❌ DB Connection Error:", err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});