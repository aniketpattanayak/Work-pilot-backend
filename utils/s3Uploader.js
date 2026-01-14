// server/utils/s3Uploader.js
const { S3Client } = require("@aws-sdk/client-s3");
const multer = require("multer");
const multerS3 = require("multer-s3");
require("dotenv").config();

// 1. Initialize S3 Client with your .env credentials
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
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
    // REMOVED: acl: "public-read"
    // Modern S3 buckets do not support ACLs by default. 
    // Use Bucket Policies to make files public if needed.
    
    metadata: function (req, file, cb) {
      cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
      // Create a unique filename: timestamp + original name
      // Files will be stored in the 'task-evidence' folder inside your bucket
      cb(null, `task-evidence/${Date.now().toString()}-${file.originalname}`);
    },
  }),
});

module.exports = upload;