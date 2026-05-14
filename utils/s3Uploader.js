// server/utils/s3Uploader.js
// Safe file uploader — works with or without AWS S3 credentials.
// When S3 is configured: uploads to S3, gives file.location (S3 URL)
// When S3 is NOT configured: saves to local /uploads/ folder, gives file.location (local path)

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

const ALLOWED_TYPES = [
  'image/jpeg','image/png','image/webp','image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const hasAwsConfig = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.S3_BUCKET_NAME
);

let upload;

if (hasAwsConfig) {
  // ── S3 UPLOAD ─────────────────────────────────────────────────────────────
  const multerS3  = require('multer-s3');
  const { S3Client } = require('@aws-sdk/client-s3');

  const s3 = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  upload = multer({
    storage: multerS3({
      s3,
      bucket: process.env.S3_BUCKET_NAME,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      ALLOWED_TYPES.includes(file.mimetype) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.mimetype}`), false);
    },
  });

  console.log('✅ S3 uploader active');

} else {
  // ── LOCAL DISK FALLBACK ───────────────────────────────────────────────────
  // Saves files to /server/uploads/ and adds a .location field
  // so the taskController doesn't crash when reading file.location

  const uploadDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  });

  // Custom storage that adds .location so controller works identically
  const LocalStorage = function() {};
  LocalStorage.prototype._handleFile = function(req, file, cb) {
    diskStorage._handleFile(req, file, (err, info) => {
      if (err) return cb(err);
      // Add .location like S3 does, using a local server URL
      const host = process.env.SERVER_URL || 'http://localhost:5000';
      info.location = `${host}/uploads/${info.filename}`;
      cb(null, info);
    });
  };
  LocalStorage.prototype._removeFile = function(req, file, cb) {
    diskStorage._removeFile(req, file, cb);
  };

  upload = multer({
    storage: new LocalStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      ALLOWED_TYPES.includes(file.mimetype) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.mimetype}`), false);
    },
  });

  console.log('⚠️  AWS S3 not configured — files saved locally to /server/uploads/');
  console.log('    Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET_NAME in .env to enable S3');
}

module.exports = upload;