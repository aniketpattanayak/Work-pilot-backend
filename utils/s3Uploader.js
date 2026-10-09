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
  'text/csv','application/csv',
  'text/plain',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip','application/x-zip-compressed',
];

const hasAwsConfig = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.S3_BUCKET_NAME
);

const ALLOWED_TYPES_LABEL = 'images, PDF, Word, Excel, PowerPoint, CSV, text and zip files';
const allowedFileFilter = (req, file, cb) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) return cb(null, true);
  const err = new Error('"' + file.originalname + '" is not an allowed file type. Allowed: ' + ALLOWED_TYPES_LABEL + '.');
  err.code = 'FILE_TYPE_NOT_ALLOWED';
  cb(err, false);
};

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
    fileFilter: allowedFileFilter,
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
    fileFilter: allowedFileFilter,
  });

  console.log('⚠️  AWS S3 not configured — files saved locally to /server/uploads/');
  console.log('    Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET_NAME in .env to enable S3');
}

const friendlyUploadError = (err) => {
  if (err && err.code === 'FILE_TYPE_NOT_ALLOWED') return { status: 400, message: err.message };
  if (err && err.code === 'LIMIT_FILE_SIZE') return { status: 400, message: 'A file is larger than the 10 MB limit. Please attach a smaller file.' };
  if (err && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) return { status: 400, message: 'Too many files attached. Please remove some and try again.' };
  console.error('Upload error:', err && err.message);
  return { status: 500, message: 'File upload failed. Please try again.' };
};
const guard = (name) => (...args) => {
  const mw = upload[name](...args);
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    const { status, message } = friendlyUploadError(err);
    return res.status(status).json({ message });
  });
};

module.exports = {
  single: guard('single'),
  array:  guard('array'),
  fields: guard('fields'),
  any:    guard('any'),
  none:   guard('none'),
};