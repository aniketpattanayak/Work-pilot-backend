// server/utils/s3Uploader.js
// Safe file uploader — works with or without AWS S3 credentials.
// When S3 is configured: uploads to S3, gives file.location (S3 URL)
// When S3 is NOT configured: saves to local /uploads/ folder, gives file.location (local path)

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

const hasAwsConfig = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.S3_BUCKET_NAME
);

// ── Any file type is accepted, EXCEPT things that can run code on a server or
// in a browser. Checked on the extension (browsers often send PDFs/Excel/CSV
// with a generic or wrong MIME type, so the MIME type is NOT used any more).
const BLOCKED_EXT = new Set([
  '.exe','.bat','.cmd','.com','.scr','.msi','.dll','.sh','.ps1','.vbs','.jar',
  '.php','.html','.htm','.xhtml','.svg','.js','.mjs',
]);
const blockedFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (BLOCKED_EXT.has(ext)) {
    const err = new Error('"' + file.originalname + '" (' + ext + ') is not allowed for security reasons. Please send it as a zip or choose another file.');
    err.code = 'FILE_TYPE_NOT_ALLOWED';
    return cb(err, false);
  }
  cb(null, true);
};

// ── Per-company size limit (set by Super Admin: Tenant.superAdmin.uploadLimitMb)
const DEFAULT_LIMIT_MB = 10;
const MIN_LIMIT_MB = 1;
const MAX_LIMIT_MB = 100;
const limitCache = new Map(); // tenantId -> { mb, at }
const CACHE_MS = 60 * 1000;

const clampMb = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT_MB;
  return Math.min(Math.max(n, MIN_LIMIT_MB), MAX_LIMIT_MB);
};

async function getUploadLimitMb(tenantId) {
  if (!tenantId) return DEFAULT_LIMIT_MB;
  const key = String(tenantId);
  const hit = limitCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.mb;
  try {
    const Tenant = require('../models/Tenant');
    const t = await Tenant.findById(key).select('superAdmin.uploadLimitMb').lean();
    const mb = clampMb(t && t.superAdmin && t.superAdmin.uploadLimitMb);
    limitCache.set(key, { mb, at: Date.now() });
    return mb;
  } catch (e) {
    return DEFAULT_LIMIT_MB;
  }
}
const clearUploadLimitCache = (tenantId) => {
  if (tenantId) limitCache.delete(String(tenantId)); else limitCache.clear();
};

let makeUpload;

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

  makeUpload = (mb) => multer({
    storage: multerS3({
      s3,
      bucket: process.env.S3_BUCKET_NAME,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      },
    }),
    limits: { fileSize: Math.floor(mb * 1024 * 1024) },
    fileFilter: blockedFilter,
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

  makeUpload = (mb) => multer({
    storage: new LocalStorage(),
    limits: { fileSize: Math.floor(mb * 1024 * 1024) },
    fileFilter: blockedFilter,
  });

  console.log('⚠️  AWS S3 not configured — files saved locally to /server/uploads/');
  console.log('    Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET_NAME in .env to enable S3');
}

const friendlyUploadError = (err, mb) => {
  if (err && err.code === 'FILE_TYPE_NOT_ALLOWED') return { status: 400, message: err.message };
  if (err && err.code === 'LIMIT_FILE_SIZE') return { status: 400, message: 'A file is larger than the ' + mb + ' MB limit set for your company. Please attach a smaller file.' };
  if (err && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) return { status: 400, message: 'Too many files attached. Please remove some and try again.' };
  console.error('Upload error:', err && err.message);
  return { status: 500, message: 'File upload failed. Please try again.' };
};

const instances = new Map(); // mb -> multer instance
const instanceFor = (mb) => {
  if (!instances.has(mb)) instances.set(mb, makeUpload(mb));
  return instances.get(mb);
};

// The size limit is looked up per request from the logged-in user's company.
const guard = (name) => (...args) => async (req, res, next) => {
  const mb = await getUploadLimitMb(req.user && req.user.tenantId);
  const mw = instanceFor(mb)[name](...args);
  mw(req, res, (err) => {
    if (!err) return next();
    const { status, message } = friendlyUploadError(err, mb);
    return res.status(status).json({ message });
  });
};

module.exports = {
  single: guard('single'),
  array:  guard('array'),
  fields: guard('fields'),
  any:    guard('any'),
  none:   guard('none'),
  getUploadLimitMb,
  clearUploadLimitCache,
  DEFAULT_LIMIT_MB, MIN_LIMIT_MB, MAX_LIMIT_MB,
};
