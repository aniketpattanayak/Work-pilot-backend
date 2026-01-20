// server/utils/s3Uploader.js
const { S3Client } = require("@aws-sdk/client-s3");
const multer = require("multer");
const multerS3 = require("multer-s3");
require("dotenv").config();

// 1. Initialize S3 Client with Mumbai region for your new bucket
const s3 = new S3Client({
  region: process.env.AWS_REGION || "ap-south-1", // Updated to match your Mumbai bucket
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  },
});

// 2. Configure Multer-S3 for direct upload
const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_BUCKET_NAME,
    
    // CRITICAL: Automatically detects the file type (image/png, etc.) 
    // This prevents images from downloading instead of opening in the browser
    contentType: multerS3.AUTO_CONTENT_TYPE, 
    
    metadata: function (req, file, cb) {
      cb(null, { fieldName: file.fieldname });
    },
    
    key: function (req, file, cb) {
      /**
       * Create a unique filename: timestamp + original name
       * Stored in the 'task-evidence' folder inside your bucket
       */
      cb(null, `task-evidence/${Date.now().toString()}-${file.originalname}`);
    },
  }),
});

module.exports = upload;