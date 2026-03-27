// backend/index.js
const express = require('express')
const nodemailer = require('nodemailer')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const slowDown = require('express-slow-down')
const cookieParser = require('cookie-parser')
const multer = require('multer')
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcrypt')
const IS_VERCEL = !!process.env.VERCEL;
const { PrismaClient } = require('@prisma/client')
require('dotenv').config()
//const pdfParse = require("pdf-parse");
//const Tesseract = require("tesseract.js");
let Tesseract = null;
const streamifier = require('streamifier') // ✅ const import style
const { v2: cloudinary } = require('cloudinary');
// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

//const PHOTO_MODE = process.env.PHOTO_MODE || "cloudinary";
const PHOTO_MODE = process.env.PHOTO_MODE || (process.env.VERCEL ? "cloudinary" : "vps");


// ------ Cloudinary folder configuration ------
// the root folder (usually 'fibuca') and subfolders may vary per project.
// allow overrides via env vars so the code can run in different accounts.
const CLOUDINARY_BASE_FOLDER = process.env.CLOUDINARY_BASE_FOLDER || 'fibuca';
const CLOUDINARY_FOLDERS = {
  photos: process.env.CLOUDINARY_PHOTOS_FOLDER || 'photo',      // user-submitted ID card photos
  forms: process.env.CLOUDINARY_FORMS_FOLDER || 'forms',      // PDF forms
  idcards: process.env.CLOUDINARY_IDCARDS_FOLDER || 'id',      // cleaned ID card images
  complaints: process.env.CLOUDINARY_COMPLAINTS_FOLDER || 'complaints', // complaint reply attachments
  profiles: process.env.CLOUDINARY_PROFILES_FOLDER || 'profiles', // user profile photos
  // if you ever want a separate folder for generated PDFs, add here
};

function cloudFolder(sub) {
  return `${CLOUDINARY_BASE_FOLDER}/${sub}`;
}

// helper for extracting a public_id from a Cloudinary URL.  the URL may
// include version numbers or query params, so we trim those off.  the
// resulting string is what `cloudinary.url()` expects when reapplying
// transformations.
function getCloudinaryPublicId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  // drop query string
  const url = rawUrl.split('?')[0];
  const m = url.match(/\/upload\/(?:v\d+\/)?(.+?)\.(?:jpg|jpeg|png|gif|webp)$/i);
  return m ? m[1] : null;
}

// Ensure a card has cloud-based URLs when running in cloudinary mode.  If we
// detect that rawPhotoUrl points at a local `/photos` path, we fetch the image
// (from disk or via HTTP), upload it to Cloudinary, update the database, and
// regenerate the cleaned URL.  This helper returns a fresh copy of the card
// (which may have been updated).
async function ensureCloudinaryUrls(card) {
  if (PHOTO_MODE !== 'cloudinary' || !card.rawPhotoUrl) return card;

  const isLocalRaw = card.rawPhotoUrl.startsWith('/photos/') ||
    card.rawPhotoUrl.includes(`${process.env.VITE_BACKEND_URL || ''}/photos/`);
  if (!isLocalRaw) return card;

  try {
    console.log(`📦 migrating existing rawPhotoUrl for card ${card.id} to Cloudinary`);
    let buf;
    if (/^https?:\/\//.test(card.rawPhotoUrl)) {
      const resp = await axios.get(card.rawPhotoUrl, {
        responseType: 'arraybuffer',
        timeout: 20000
      });
      buf = Buffer.from(resp.data);
    } else {
      const fname = path.basename(card.rawPhotoUrl);
      buf = fs.readFileSync(path.join(__dirname, 'photos', fname));
    }
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: cloudFolder(CLOUDINARY_FOLDERS.photos),
          resource_type: 'image'
        },
        (error, result) => error ? reject(error) : resolve(result)
      );
      streamifier.createReadStream(buf).pipe(stream);
    });
    card.rawPhotoUrl = uploadResult.secure_url;

    // update DB with new raw URL before regenerating clean
    await prisma.idCard.update({ where: { id: card.id }, data: { rawPhotoUrl: card.rawPhotoUrl } });

    const pub = getCloudinaryPublicId(card.rawPhotoUrl);
    if (pub) {
      card.cleanPhotoUrl = cloudinary.url(pub, {
        transformation: [
          { effect: "background_removal" },
          // must be AFTER background_removal (Cloudinary note)
          { effect: "dropshadow", azimuth: 220, elevation: 40, spread: 20 },
          { crop: "scale", height: 110 },
          { fetch_format: "png" }, // keep transparency
          { quality: "auto" },
        ]
      });
      await prisma.idCard.update({ where: { id: card.id }, data: { cleanPhotoUrl: card.cleanPhotoUrl } });
    }

    console.log(`✅ migration complete for card ${card.id}`);
  } catch (mErr) {
    console.warn('⚠️ failed to migrate card to Cloudinary:', mErr.message);
  }
  return card;
}

// ================= PHOTO PROCESSING MODE =================
// MODE = "vps"  -> Use Python + local disk
// MODE = "cloudinary" -> Use Cloudinary AI background removal

const axios = require('axios'); // used to fetch raw image server-side

console.log(`📸 PHOTO_MODE is set to '${PHOTO_MODE}' (VERCEL=${!!process.env.VERCEL})`);
if (process.env.VERCEL && PHOTO_MODE !== 'cloudinary') {
  console.warn('⚠️ Running on Vercel but PHOTO_MODE is', PHOTO_MODE, '– Cloudinary is recommended; set PHOTO_MODE=cloudinary');
}

// ✅ Re-enabled: Optimized Python rembg with heavy memory optimization
// Using remove_bg_buffer_optimized.py for streaming/chunked processing
// Reduces RAM footprint from 300MB to ~100MB for testing
const { removeBackgroundBuffer } = require('./py-tools/utils/runPython');
console.log('✅ Using optimized Python rembg with streaming for low-RAM systems');

// ================= STAFF LINK HELPER FUNCTION =================
// Refresh link status based on expiration time and max uses
// NOTE: Handles both new and old schema versions
// This function is CRITICAL for validating staff-generated share links
async function refreshLinkStatus(link) {
  try {
    if (!link || !link.id) {
      console.error('❌ refreshLinkStatus: Invalid link object');
      return link;
    }

    const now = new Date();

    // Safety check: expiresAt should be a valid Date
    let expiresAt = link.expiresAt;
    if (!expiresAt) {
      console.warn(`⚠️ Link ${link.id} has no expiresAt - treating as expired`);
      expiresAt = new Date(0); // Far past
    } else if (typeof expiresAt === 'string') {
      expiresAt = new Date(expiresAt);
    }

    const isExpired = expiresAt < now;
    // Safely check maxUses and usedCount (might not exist in old DB records)
    const maxUses = link.maxUses || null;
    const usedCount = link.usedCount || 0;
    const isMaxedOut = maxUses && usedCount >= maxUses;

    // Link should be active only if NOT expired and NOT maxed out
    const shouldBeActive = !isExpired && !isMaxedOut;

    console.log(`🔗 Link ${link.id}: expired=${isExpired} (expiry=${expiresAt.toISOString()}), maxedOut=${isMaxedOut} (uses=${usedCount}/${maxUses}), currentActive=${link.isActive}, shouldBeActive=${shouldBeActive}`);

    // Only update if status changed
    if (link.isActive !== shouldBeActive) {
      console.log(`📝 Updating link ${link.id}: isActive ${link.isActive} → ${shouldBeActive}`);
      try {
        const updated = await prisma.staffLink.update({
          where: { id: link.id },
          data: { isActive: shouldBeActive }
        });
        console.log(`✅ Link ${link.id} status updated in database`);
        return updated;
      } catch (updateErr) {
        console.error(`❌ Failed to update link ${link.id}:`, updateErr.message);
        // Return modified link object even if DB update fails
        return { ...link, isActive: shouldBeActive };
      }
    }

    console.log(`✅ Link ${link.id} status is current (no update needed)`);
    return link;
  } catch (err) {
    console.error('❌ refreshLinkStatus unexpected error:', err.message);
    console.error('Stack:', err.stack);
    // Always return the link, never fail - let validation use what we have
    return link;
  }
}

const app = express()

const MAX_JSON_BODY = process.env.MAX_JSON_BODY || '1mb';
const MAX_URLENCODED_BODY = process.env.MAX_URLENCODED_BODY || '1mb';
const LOGIN_MAX_ATTEMPTS = parseInt(process.env.LOGIN_MAX_ATTEMPTS || '5', 10);
const LOGIN_LOCK_MS = parseInt(process.env.LOGIN_LOCK_MS || String(15 * 60 * 1000), 10);
const loginAttemptStore = new Map();
const SECURITY_EVENT_LIMIT = parseInt(process.env.SECURITY_EVENT_LIMIT || '250', 10);
const REQUEST_SNAPSHOT_LIMIT = parseInt(process.env.REQUEST_SNAPSHOT_LIMIT || '400', 10);
const ACTIVE_SESSION_TIMEOUT_MS = parseInt(process.env.ACTIVE_SESSION_TIMEOUT_MS || String(2 * 60 * 60 * 1000), 10);
const securityEventStore = [];
const requestSnapshotStore = [];
const activeSessionStore = new Map(); // userId (string) → session record

function recordActiveSession(req) {
  if (!req.user?.id) return;
  activeSessionStore.set(String(req.user.id), {
    userId: req.user.id,
    employeeNumber: req.user.employeeNumber || null,
    role: req.user.role || 'UNKNOWN',
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || 'unknown',
    lastSeen: new Date().toISOString(),
    lastSeenMs: Date.now(),
  });
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

function recordSecurityEvent(type, req, details = {}) {
  securityEventStore.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    ip: getClientIp(req),
    path: req.originalUrl || req.url || '',
    method: req.method || 'UNKNOWN',
    userId: req.user?.id || null,
    role: req.user?.role || null,
    userAgent: req.headers['user-agent'] || 'unknown',
    createdAt: new Date().toISOString(),
    details,
  });

  if (securityEventStore.length > SECURITY_EVENT_LIMIT) {
    securityEventStore.length = SECURITY_EVENT_LIMIT;
  }
}

async function recordUserManagementEvent(type, req, targetUser, details = {}) {
  recordSecurityEvent(type, req, {
    actorId: req.user?.id || null,
    actorName: req.user?.name || null,
    actorRole: req.user?.role || null,
    targetUserId: targetUser?.id || null,
    targetName: targetUser?.name || null,
    targetUsername: targetUser?.username || null,
    targetEmployeeNumber: targetUser?.employeeNumber || null,
    targetRole: targetUser?.role || null,
    ...details,
  });
  // Persist to database
  try {
    await prisma.userAuditLog.create({
      data: {
        type,
        actorId: req.user?.id || null,
        actorName: req.user?.name || null,
        actorRole: req.user?.role || null,
        targetUserId: targetUser?.id || null,
        targetName: targetUser?.name || null,
        targetUsername: targetUser?.username || null,
        targetEmployeeNumber: targetUser?.employeeNumber || null,
        targetRole: targetUser?.role || null,
        details: details || {},
        ip: getClientIp(req),
      },
    });
  } catch (e) {
    console.error('❌ Failed to persist user audit log:', e.message);
  }
}

function recordRequestSnapshot(req, statusCode, latencyMs) {
  requestSnapshotStore.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    ip: getClientIp(req),
    path: req.originalUrl || req.url || '',
    method: req.method || 'UNKNOWN',
    statusCode,
    latencyMs,
    createdAt: new Date().toISOString(),
  });

  if (requestSnapshotStore.length > REQUEST_SNAPSHOT_LIMIT) {
    requestSnapshotStore.length = REQUEST_SNAPSHOT_LIMIT;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttemptStore.entries()) {
    if (!entry || !entry.lockUntil || entry.lockUntil < now) {
      loginAttemptStore.delete(key);
    }
  }
  for (const [userId, session] of activeSessionStore.entries()) {
    if (!session || now - session.lastSeenMs > ACTIVE_SESSION_TIMEOUT_MS) {
      activeSessionStore.delete(userId);
    }
  }
}, 10 * 60 * 1000);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    recordSecurityEvent('api_rate_limited', req, { windowMs: 60 * 1000, max: 300 });
    return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    recordSecurityEvent('auth_rate_limited', req, { windowMs: 15 * 60 * 1000, max: 30 });
    return res.status(429).json({ error: 'Too many authentication attempts. Please try again later.' });
  },
});

const publicVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    recordSecurityEvent('public_verify_rate_limited', req, { windowMs: 5 * 60 * 1000, max: 120 });
    return res.status(429).json({ error: 'Too many verification requests. Please try again shortly.' });
  },
});

const loginSlowdown = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 5,
  delayMs: () => 400,
  maxDelayMs: 5000,
});

app.use('/api', apiLimiter);
app.use('/api/login', authLimiter, loginSlowdown);
app.use('/api/auth/request-otp', authLimiter);
app.use('/api/auth/verify-otp', authLimiter);
app.use('/api/auth/reset-password-with-otp', authLimiter);

// ---------- CORS & upload configuration ----------
// Use environment variable CORS_ORIGIN when available; fall back to
// legacy VITE_FRONTEND_URL and hard‑coded production domains.
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(o => o.trim())
  : [
    process.env.VITE_FRONTEND_URL || "https://fibuca-frontend.vercel.app",
  ];

// Always ensure the official frontend host is present for quick verification/testing
if (!allowedOrigins.includes('https://fibuca-frontend.vercel.app')) {
  allowedOrigins.push('https://fibuca-frontend.vercel.app');
}

// Lightweight middleware to set basic CORS headers early (also handles OPTIONS)
// This helps ensure browsers see Access-Control headers even for simple
// errors that reach our server. Note: platform (Vercel) rejections before
// this code runs (e.g. very large body rejected by the platform) still
// won't include these headers.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Photo-Cleaned,X-Requested-With');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Attach CORS middleware globally.  This ensures headers are set on every
// response, including error cases such as multer size limits or Vercel
// platform rejections (413) so the browser doesn't complain about missing
// Access-Control-Allow-Origin.
app.use(
  cors({
    origin: (origin, callback) => {
      // allow requests with no origin (curl, mobile apps, same‑origin etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      console.warn("🚫 CORS origin rejected:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Photo-Cleaned", "X-Requested-With"],
  })
);

// parse upload size limit from environment or default to 3MB
const MAX_PHOTO_BYTES = parseInt(process.env.UPLOAD_SIZE_LIMIT || String(50 * 1024 * 1024), 10);
const MAX_COMPLAINT_ATTACHMENT_BYTES = parseInt(process.env.MAX_COMPLAINT_ATTACHMENT_BYTES || String(10 * 1024 * 1024), 10);
const MAX_OFFICIAL_DOCUMENT_BYTES = parseInt(process.env.MAX_OFFICIAL_DOCUMENT_BYTES || String(10 * 1024 * 1024), 10);

console.log('🛡️ CORS allowed origins:', allowedOrigins);
console.log('📦 upload size limit bytes:', MAX_PHOTO_BYTES);
console.log('📎 complaint attachment max bytes:', MAX_COMPLAINT_ATTACHMENT_BYTES);
console.log('📄 official document max bytes:', MAX_OFFICIAL_DOCUMENT_BYTES);
console.log('⚠️ Note: serverless platforms (Vercel) commonly enforce ~4.5MB request body limits; even with 50MB configured here, the platform may reject larger requests before this app runs.');

// memory storage for uploads uses the limit variable now
const uploadPDF = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES } });
const uploadPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES } });

const prisma = new PrismaClient()
const PORT = process.env.PORT
const JWT_SECRET = process.env.JWT_SECRET || 'fibuca_secret'

// Shared local upload paths for static serving and local-storage fallbacks.
const UPLOADS_DIR = path.join(__dirname, "uploads");
const PHOTOS_UPLOAD_DIR = path.join(UPLOADS_DIR, "photos");
const FORMS_UPLOAD_DIR = path.join(UPLOADS_DIR, "forms");
const IDCARDS_UPLOAD_DIR = path.join(UPLOADS_DIR, "idcards");
const COMPLAINTS_UPLOAD_DIR = path.join(UPLOADS_DIR, "complaints");
const PROFILES_UPLOAD_DIR = path.join(UPLOADS_DIR, "profiles");

[UPLOADS_DIR, PHOTOS_UPLOAD_DIR, FORMS_UPLOAD_DIR, IDCARDS_UPLOAD_DIR, COMPLAINTS_UPLOAD_DIR, PROFILES_UPLOAD_DIR].forEach((dir) => {
  if (!IS_VERCEL && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

function buildUploadUrl(req, relativePath) {
  const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
  return `${baseUrl}/uploads/${String(relativePath).replace(/^\/+/, "")}`;
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function parseReplyStorageMessage(raw = "") {
  const lines = String(raw || "").split(/\r?\n/);
  let attachmentFileUrl = "";
  let attachmentLinkUrl = "";
  let editedAt = "";
  let deletedAt = "";
  let deleted = false;
  const messageLines = [];

  lines.forEach((line) => {
    if (line.startsWith("__ATTACHMENT_FILE__:")) {
      attachmentFileUrl = line.replace("__ATTACHMENT_FILE__:", "").trim();
      return;
    }
    if (line.startsWith("__ATTACHMENT_LINK__:")) {
      attachmentLinkUrl = line.replace("__ATTACHMENT_LINK__:", "").trim();
      return;
    }
    if (line.startsWith("__EDITED_AT__:")) {
      editedAt = line.replace("__EDITED_AT__:", "").trim();
      return;
    }
    if (line.startsWith("__DELETED__:")) {
      deleted = line.replace("__DELETED__:", "").trim() === "true";
      return;
    }
    if (line.startsWith("__DELETED_AT__:")) {
      deletedAt = line.replace("__DELETED_AT__:", "").trim();
      return;
    }
    messageLines.push(line);
  });

  return {
    message: messageLines.join("\n").trim(),
    attachmentFileUrl,
    attachmentLinkUrl,
    editedAt,
    deleted,
    deletedAt,
  };
}

function buildReplyStorageMessage({
  message = "",
  attachmentFileUrl = "",
  attachmentLinkUrl = "",
  editedAt = "",
  deleted = false,
  deletedAt = "",
}) {
  const out = [];
  if (String(message || "").trim()) out.push(String(message).trim());
  if (String(attachmentFileUrl || "").trim()) out.push(`__ATTACHMENT_FILE__:${String(attachmentFileUrl).trim()}`);
  if (String(attachmentLinkUrl || "").trim()) out.push(`__ATTACHMENT_LINK__:${String(attachmentLinkUrl).trim()}`);
  if (String(editedAt || "").trim()) out.push(`__EDITED_AT__:${String(editedAt).trim()}`);
  if (deleted) out.push(`__DELETED__:true`);
  if (String(deletedAt || "").trim()) out.push(`__DELETED_AT__:${String(deletedAt).trim()}`);
  return out.join("\n");
}

async function uploadComplaintPdf(req, file, complaintId) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const original = String(file?.originalname || "").toLowerCase();
  const isPdf = mime === "application/pdf" || original.endsWith(".pdf");

  if (!isPdf) {
    throw new Error("Only PDF files are allowed for complaint attachments");
  }

  if (PHOTO_MODE === "cloudinary" || process.env.VERCEL) {
    const publicId = `complaint_${complaintId}_${Date.now()}`;
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "raw",
          folder: cloudFolder(CLOUDINARY_FOLDERS.complaints),
          public_id: publicId,
          format: "pdf",
        },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      streamifier.createReadStream(file.buffer).pipe(stream);
    });
    return uploadResult.secure_url;
  }

  const safeName = `complaint_${complaintId}_${Date.now()}.pdf`;
  const pdfDiskPath = path.join(COMPLAINTS_UPLOAD_DIR, safeName);
  await fs.promises.writeFile(pdfDiskPath, file.buffer);
  return buildUploadUrl(req, `complaints/${safeName}`);
}



// Parse JSON / URL-encoded requests
app.use(express.json({ limit: MAX_JSON_BODY }))
app.use(express.urlencoded({ extended: true, limit: MAX_URLENCODED_BODY }))
app.use(cookieParser())

function requireTrustedMutation(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const authHeader = req.headers.authorization || req.headers.Authorization;
  const hasBearerToken = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ');
  const hasCookieToken = !!req.cookies?.fibuca_token;

  if (!hasCookieToken || hasBearerToken) return next();

  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    recordSecurityEvent('blocked_origin', req, { origin });
    return res.status(403).json({ error: 'Blocked by origin policy' });
  }

  const requestedWith = req.headers['x-requested-with'];
  if (requestedWith !== 'XMLHttpRequest') {
    recordSecurityEvent('missing_trusted_header', req, { requestedWith: requestedWith || null });
    return res.status(403).json({ error: 'Missing trusted request header' });
  }

  return next();
}

app.use(requireTrustedMutation)

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const latencyMs = Date.now() - started;
    recordRequestSnapshot(req, res.statusCode, latencyMs);
  });
  next();
});

// --------------------
// Serve static files
// --------------------
app.use("/uploads", express.static(UPLOADS_DIR));


// ✅ Use memory storage for all uploads
// replaced above with environment-driven configuration



// --------------------
// Auth middleware
// --------------------
function authenticate(req, res, next) {
  // Accept token via Authorization header (Bearer ...) or cookie fibuca_token

  const authHeader = req.headers.authorization || req.headers.Authorization
  let token = null
  if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.slice(7)
  } else if (req.cookies && req.cookies.fibuca_token) {
    token = req.cookies.fibuca_token
  }

  if (!token) return res.status(401).json({ message: 'Not authenticated' })

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.user = payload
    recordActiveSession(req);
    next()
  } catch (err) {
    console.error('❌ Invalid JWT:', err)
    recordSecurityEvent('invalid_jwt', req, { message: err.message });
    // If the token came from cookie, clear it. If it was a header, nothing to clear.
    if (req.cookies && req.cookies.fibuca_token) res.clearCookie('fibuca_token')
    return res.status(401).json({ message: 'Invalid or expired token' })
  }
}

function requireRole(roles = []) {

  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    next();
  };
}

function canManageTargetUser(actor, target, options = {}) {
  const { allowSelf = false } = options;
  if (!actor || !target) return false;
  if (!allowSelf && actor.id === target.id) return false;
  if (actor.role === 'SUPERADMIN') return true;
  if (actor.role === 'ADMIN' && target.role === 'SUPERADMIN') return false;
  return actor.role === 'ADMIN';
}

async function getManageableUserOrReject(req, res, id, options = {}) {
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  if (!canManageTargetUser(req.user, target, options)) {
    res.status(403).json({
      error: req.user?.role === 'ADMIN'
        ? 'Admin cannot manage superadmin users'
        : 'You are not allowed to manage this user',
    });
    return null;
  }
  return target;
}


function normalizeSpaces(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function extractField(text, patterns = []) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeSpaces(match[1]);
  }
  return "";
}

function upperTrim(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim().toUpperCase();
}

function normalizeSubmissionPayload(input = {}) {
  return {
    employeeName: upperTrim(input.employeeName) || "",
    employeeNumber: upperTrim(input.employeeNumber) || "",
    employerName: upperTrim(input.employerName) || "",
    branchName: upperTrim(input.branchName),
    phoneNumber: upperTrim(input.phoneNumber),
    dues: upperTrim(input.dues) || "1%",
    witness: upperTrim(input.witness) || "",
  };
}

function parseScannedFormText(rawText = "") {
  const text = String(rawText || "").replace(/\r/g, "");
  const lines = text
    .split("\n")
    .map((l) => normalizeSpaces(l))
    .filter(Boolean);

  const fullText = lines.join("\n");

  const employeeName = extractField(fullText, [
    /EMPLOYEE['’]?\s*NAME\s*[:\-]?\s*(.+)/i,
    /NAME\s*[:\-]?\s*(.+)/i,
  ]);

  const employeeNumber = extractField(fullText, [
    /EMPLOYEE\s*NUMBER\s*[:\-]?\s*([A-Z0-9\/\-]+)/i,
    /EMPLOYEE\s*NO\.?\s*[:\-]?\s*([A-Z0-9\/\-]+)/i,
    /PAYROLL\s*NUMBER\s*[:\-]?\s*([A-Z0-9\/\-]+)/i,
  ]);

  const employerName = extractField(fullText, [
    /EMPLOYER\s*NAME\s*[:\-]?\s*(.+)/i,
    /BANK\s*NAME\s*[:\-]?\s*(.+)/i,
    /EMPLOYER\s*[:\-]?\s*(.+)/i,
  ]);

  const branchName = extractField(fullText, [
    /BRANCH\s*NAME\s*[:\-]?\s*(.+)/i,
    /BRANCH\s*[:\-]?\s*(.+)/i,
  ]);

  const phoneNumber = extractField(fullText, [
    /PHONE\s*NUMBER\s*[:\-]?\s*([+0-9][0-9\s\-]{7,})/i,
    /PHONE\s*[:\-]?\s*([+0-9][0-9\s\-]{7,})/i,
    /MOBILE\s*[:\-]?\s*([+0-9][0-9\s\-]{7,})/i,
    /TEL\s*[:\-]?\s*([+0-9][0-9\s\-]{7,})/i,
  ]);

  const dues = extractField(fullText, [
    /INITIAL\s*MONTHLY\s*UNION\s*DUES\s*[:\-]?\s*([0-9]+%?)/i,
    /DUES\s*[:\-]?\s*([0-9]+%?)/i,
  ]) || "1%";

  const witness = extractField(fullText, [
    /WITNESS\s*NAME\s*AND\s*SIGNATURE\s*[:\-]?\s*(.+)/i,
    /WITNESS\s*[:\-]?\s*(.+)/i,
  ]);

  const scoreParts = [
    employeeName,
    employeeNumber,
    employerName,
    dues,
    witness,
  ].filter(Boolean).length;

  const confidence = Math.min(0.25 + scoreParts * 0.15, 0.95);

  return {
    employeeName: upperTrim(employeeName) || "",
    employeeNumber: upperTrim(employeeNumber) || "",
    employerName: upperTrim(employerName) || "",
    branchName: upperTrim(branchName),
    phoneNumber: upperTrim(phoneNumber),
    dues: upperTrim(dues || "1%"),
    witness: upperTrim(witness) || "",
    confidence,
    rawText: fullText,
  };
}

async function extractTextFromUpload(file) {
  const mime = file.mimetype || "";
  const isPdf = mime.includes("pdf");
  const isImage = mime.startsWith("image/");

  if (isPdf) {
    // Lazy load only when needed
    let pdfParse;
    try {
      pdfParse = require("pdf-parse");
    } catch (err) {
      throw new Error(
        "PDF scanning is not available on this deployment yet. Please upload JPG or PNG for now."
      );
    }

    try {
      const parsed = await pdfParse(file.buffer);
      const text = normalizeSpaces(parsed?.text || "");
      if (text && text.length > 40) {
        return { text: parsed.text || "", source: "pdf-text" };
      }
    } catch (err) {
      console.warn("⚠️ pdf-parse failed, falling back:", err.message);
      throw new Error(
        "This PDF could not be parsed on the current server. Please upload JPG or PNG scan for now."
      );
    }
  }

  if (isImage) {
    if (!Tesseract) {
      Tesseract = require("tesseract.js");
    }

    const worker = await Tesseract.createWorker("eng");
    try {
      const result = await worker.recognize(file.buffer);
      return {
        text: result?.data?.text || "",
        source: "ocr-image",
      };
    } finally {
      await worker.terminate();
    }
  }

  throw new Error("Unsupported file type. Please upload PDF, JPG, JPEG, or PNG.");
}

// =========================
// ✅ SCAN PAPER FORM (MVP)
// =========================

// OCR / text extraction preview

app.post(
  "/api/forms/scan",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  uploadPDF.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      return res.status(400).json({
        error: "Auto scan is temporarily unavailable on this deployment",
        details:
          "Please use manual entry after upload, or move OCR/PDF extraction to VPS for heavy processing.",
      });
    } catch (err) {
      console.error("❌ scan form error:", err);
      return res.status(500).json({
        error: "Failed to scan form",
        details: err.message,
      });
    }
  }
);

// Save reviewed scan into Submission table
app.post(
  "/api/forms/scan/save",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const normalized = normalizeSubmissionPayload(req.body);
      const {
        employeeName,
        employeeNumber,
        employerName,
        branchName,
        phoneNumber,
        dues,
        witness,
      } = normalized;

      if (!employeeName || !employeeNumber || !employerName || !witness) {
        return res.status(400).json({
          error: "employeeName, employeeNumber, employerName and witness are required",
        });
      }

      const exists = await prisma.submission.findUnique({
        where: { employeeNumber },
      });

      if (exists) {
        return res.status(409).json({
          error: "Submission already exists for this employee number",
        });
      }

      const submission = await prisma.submission.create({
        data: {
          employeeName,
          employeeNumber,
          employerName,
          branchName,
          phoneNumber,
          dues,
          witness,
          pdfPath: null,
          submittedAt: new Date(),
          staffId: req.user.id,
        },
      });

      let user = await prisma.user.findUnique({
        where: { employeeNumber },
      });

      let tempPassword = null;

      if (!user) {
        const suffix = Math.floor(1000 + Math.random() * 9000);
        tempPassword = `${employeeNumber}${suffix}`;
        const hashedPassword = await bcrypt.hash(tempPassword, 10);
        user = await prisma.user.create({
          data: {
            name: employeeName,
            username: employeeNumber,
            employeeNumber,
            email: `${employeeNumber}@fibuca.com`,
            password: hashedPassword,
            role: "CLIENT",
          },
        });
      }

      let placeholderCard = await prisma.idCard.findFirst({
        where: { userId: user.id },
      });

      const makeCardNumber = () => {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const prefix = Array.from({ length: 2 })
          .map(() => letters[Math.floor(Math.random() * letters.length)])
          .join("");
        const digits = Math.floor(100000 + Math.random() * 900000);
        return `FIBUCA${prefix}${digits}`;
      };

      if (!placeholderCard) {
        placeholderCard = await prisma.idCard.create({
          data: {
            userId: user.id,
            fullName: user.name,
            rawPhotoUrl: "",
            cleanPhotoUrl: "",
            company: submission.employerName,
            role: "Member",
            issuedAt: new Date(),
            cardNumber: makeCardNumber(),
          },
        });
      }

      return res.status(201).json({
        message: "✅ Scanned form saved successfully",
        submission,
        user: {
          id: user.id,
          name: user.name,
          employeeNumber: user.employeeNumber,
          role: user.role,
        },
        loginCredentials: tempPassword
          ? { username: user.username, password: tempPassword }
          : null,
        idCard: placeholderCard,
      });
    } catch (err) {
      console.error("❌ save scanned form error:", err);
      return res.status(500).json({
        error: "Failed to save scanned form",
        details: err.message,
      });
    }
  }
);


// =========================
// ✅ COMPLAINTS (CLIENT + STAFF)
// =========================

// CLIENT: create complaint
app.post("/api/complaints", authenticate, async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ error: "subject and message are required" });
    }

    const created = await prisma.complaint.create({
      data: {
        userId: req.user.id,
        subject: String(subject).trim(),
        message: String(message).trim(),
        lastActivityAt: new Date(),
        clientLastReadAt: new Date(),
      },
    });

    return res.status(201).json({ message: "✅ Complaint submitted", complaint: created });
  } catch (err) {
    console.error("❌ create complaint error:", err);
    return res.status(500).json({ error: "Failed to submit complaint", details: err.message });
  }
});

// CLIENT: list my complaints
app.get("/api/complaints/mine", authenticate, async (req, res) => {
  try {
    const rows = await prisma.complaint.findMany({
      where: { userId: req.user.id },
      include: {
        replies: {
          include: {
            sender: {
              select: {
                id: true,
                name: true,
                role: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const mapped = rows.map((row) => {
      const lastActivity = row.lastActivityAt ? new Date(row.lastActivityAt).getTime() : 0;
      const lastRead = row.clientLastReadAt ? new Date(row.clientLastReadAt).getTime() : 0;
      return {
        ...row,
        unreadForClient: lastActivity > lastRead,
      };
    });

    return res.json(mapped);
  } catch (err) {
    console.error("❌ list my complaints error:", err);
    return res.status(500).json({
      error: "Failed to fetch complaints",
      details: err.message,
    });
  }
});

// STAFF/ADMIN: list all complaints
app.get(
  "/api/staff/complaints",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const rows = await prisma.complaint.findMany({
        include: {
          user: {
            select: {
              id: true,
              name: true,
              employeeNumber: true,
            },
          },
          replies: {
            include: {
              sender: {
                select: {
                  id: true,
                  name: true,
                  role: true,
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const mapped = rows.map((row) => {
        const lastActivity = row.lastActivityAt ? new Date(row.lastActivityAt).getTime() : 0;
        const lastRead = row.staffLastReadAt ? new Date(row.staffLastReadAt).getTime() : 0;
        return {
          ...row,
          unreadForStaff: lastActivity > lastRead,
        };
      });

      return res.json(mapped);
    } catch (err) {
      console.error("❌ staff complaints error:", err);
      return res.status(500).json({
        error: "Failed to fetch complaints",
        details: err.message,
      });
    }
  }
);




// STAFF/ADMIN: update complaint status
app.put(
  "/api/staff/complaints/:id/status",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { status } = req.body;

      if (!id) return res.status(400).json({ error: "Invalid complaint id" });

      const allowed = ["OPEN", "RESOLVED", "CLOSED"];
      if (!status || !allowed.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
      }

      const updated = await prisma.complaint.update({
        where: { id },
        data: { status },
      });

      return res.json({ message: "✅ Status updated", complaint: updated });
    } catch (err) {
      console.error("❌ update complaint status error:", err);
      return res.status(500).json({ error: "Failed to update complaint", details: err.message });
    }
  }
);

app.post(
  "/api/staff/complaints/:id/reply",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  uploadPDF.single("file"),
  async (req, res) => {
    try {
      const complaintId = Number(req.params.id);
      const rawMessage = req.body?.message;
      const rawLink = req.body?.attachmentLink;
      const message = String(rawMessage || "").trim();
      const attachmentLink = String(rawLink || "").trim();

      if (!complaintId) {
        return res.status(400).json({ error: "Invalid complaint id" });
      }

      if (!message && !req.file && !attachmentLink) {
        return res.status(400).json({ error: "Reply message, PDF file or attachment link is required" });
      }

      if (req.file && Number(req.file.size || 0) > MAX_COMPLAINT_ATTACHMENT_BYTES) {
        return res.status(413).json({ error: "Complaint attachment PDF is too large. Maximum size is 10MB." });
      }

      if (attachmentLink && !isValidHttpUrl(attachmentLink)) {
        return res.status(400).json({ error: "attachmentLink must be a valid http(s) URL" });
      }

      const complaint = await prisma.complaint.findUnique({
        where: { id: complaintId },
      });

      if (!complaint) {
        return res.status(404).json({ error: "Complaint not found" });
      }

      let uploadedFileUrl = "";
      if (req.file) {
        try {
          uploadedFileUrl = await uploadComplaintPdf(req, req.file, complaintId);
        } catch (uploadErr) {
          return res.status(400).json({ error: uploadErr.message || "Failed to upload attachment" });
        }
      }

      // Keep schema unchanged by storing metadata markers in message.
      // Frontend strips markers and renders attachment actions.
      const messageParts = [];
      if (message) messageParts.push(message);
      if (uploadedFileUrl) messageParts.push(`__ATTACHMENT_FILE__:${uploadedFileUrl}`);
      if (attachmentLink) messageParts.push(`__ATTACHMENT_LINK__:${attachmentLink}`);

      const reply = await prisma.complaintReply.create({
        data: {
          complaintId,
          senderId: req.user.id,
          message: messageParts.join("\n"),
        },
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              role: true,
            },
          },
        },
      });

      await prisma.complaint.update({
        where: { id: complaintId },
        data: {
          lastActivityAt: new Date(),
          staffLastReadAt: new Date(),
        },
      });

      return res.status(201).json({
        message: "✅ Reply sent",
        reply,
      });
    } catch (err) {
      console.error("❌ complaint reply error:", err);
      return res.status(500).json({
        error: "Failed to send reply",
        details: err.message,
      });
    }
  }
);

app.put(
  "/api/staff/complaint-replies/:id",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const replyId = Number(req.params.id);
      const message = String(req.body?.message || "").trim();

      if (!replyId) return res.status(400).json({ error: "Invalid reply id" });
      if (!message) return res.status(400).json({ error: "Reply message is required" });

      const existing = await prisma.complaintReply.findUnique({ where: { id: replyId } });
      if (!existing) return res.status(404).json({ error: "Reply not found" });

      const canManage = existing.senderId === req.user.id || ["ADMIN", "SUPERADMIN"].includes(req.user.role);
      if (!canManage) return res.status(403).json({ error: "You can only edit your own reply" });

      const parsed = parseReplyStorageMessage(existing.message);
      if (parsed.deleted) {
        return res.status(400).json({ error: "Deleted reply cannot be edited" });
      }

      const nextMessage = buildReplyStorageMessage({
        message,
        attachmentFileUrl: parsed.attachmentFileUrl,
        attachmentLinkUrl: parsed.attachmentLinkUrl,
        editedAt: new Date().toISOString(),
      });

      const updated = await prisma.complaintReply.update({
        where: { id: replyId },
        data: { message: nextMessage },
        include: {
          sender: { select: { id: true, name: true, role: true } },
        },
      });

      await prisma.complaint.update({
        where: { id: existing.complaintId },
        data: {
          lastActivityAt: new Date(),
          staffLastReadAt: new Date(),
        },
      });

      return res.json({ message: "✅ Reply updated", reply: updated });
    } catch (err) {
      console.error("❌ edit complaint reply error:", err);
      return res.status(500).json({ error: "Failed to edit reply", details: err.message });
    }
  }
);

app.delete(
  "/api/staff/complaint-replies/:id",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const replyId = Number(req.params.id);
      if (!replyId) return res.status(400).json({ error: "Invalid reply id" });

      const existing = await prisma.complaintReply.findUnique({ where: { id: replyId } });
      if (!existing) return res.status(404).json({ error: "Reply not found" });

      const canManage = existing.senderId === req.user.id || ["ADMIN", "SUPERADMIN"].includes(req.user.role);
      if (!canManage) return res.status(403).json({ error: "You can only delete your own reply" });

      const deletedMessage = buildReplyStorageMessage({
        message: "",
        deleted: true,
        deletedAt: new Date().toISOString(),
      });

      await prisma.complaintReply.update({ where: { id: replyId }, data: { message: deletedMessage } });
      await prisma.complaint.update({
        where: { id: existing.complaintId },
        data: {
          lastActivityAt: new Date(),
          staffLastReadAt: new Date(),
        },
      });
      return res.json({ message: "✅ Reply deleted" });
    } catch (err) {
      console.error("❌ delete complaint reply error:", err);
      return res.status(500).json({ error: "Failed to delete reply", details: err.message });
    }
  }
);

app.post(
  "/api/complaints/mark-read",
  authenticate,
  requireRole(["CLIENT"]),
  async (req, res) => {
    try {
      const now = new Date();
      await prisma.complaint.updateMany({
        where: { userId: req.user.id },
        data: { clientLastReadAt: now },
      });
      return res.json({ message: "✅ Client complaints marked as read" });
    } catch (err) {
      console.error("❌ mark client complaints read error:", err);
      return res.status(500).json({ error: "Failed to mark complaints as read", details: err.message });
    }
  }
);

app.post(
  "/api/staff/complaints/mark-read",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const now = new Date();
      await prisma.complaint.updateMany({
        data: { staffLastReadAt: now },
      });
      return res.json({ message: "✅ Staff complaints marked as read" });
    } catch (err) {
      console.error("❌ mark staff complaints read error:", err);
      return res.status(500).json({ error: "Failed to mark complaints as read", details: err.message });
    }
  }
);

// =========================
// OFFICIAL DOCUMENTS + NEWS UPDATES
// =========================

// CLIENT/STAFF/ADMIN: list official documents
app.get(
  "/api/client/documents",
  authenticate,
  requireRole(["CLIENT", "STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const rows = await prisma.officialDocument.findMany({
        include: {
          createdBy: {
            select: { id: true, name: true, role: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      return res.json(rows);
    } catch (err) {
      console.error("❌ list documents error:", err);
      return res.status(500).json({ error: "Failed to fetch documents", details: err.message });
    }
  }
);

// CLIENT/STAFF/ADMIN: list official updates/news
app.get(
  "/api/client/updates",
  authenticate,
  requireRole(["CLIENT", "STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const rows = await prisma.officialUpdate.findMany({
        include: {
          createdBy: {
            select: { id: true, name: true, role: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      return res.json(rows);
    } catch (err) {
      console.error("❌ list updates error:", err);
      return res.status(500).json({ error: "Failed to fetch updates", details: err.message });
    }
  }
);

// STAFF/ADMIN: publish official document
app.post(
  "/api/staff/documents",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  uploadPDF.single("file"),
  async (req, res) => {
    try {
      const title = String(req.body?.title || "").trim();
      const description = req.body?.description ? String(req.body.description).trim() : null;
      const providedFileUrl = String(req.body?.fileUrl || "").trim();

      if (!title) {
        return res.status(400).json({ error: "title is required" });
      }

      if (!req.file && !providedFileUrl) {
        return res.status(400).json({ error: "Provide either a PDF file or fileUrl" });
      }

      if (req.file && Number(req.file.size || 0) > MAX_OFFICIAL_DOCUMENT_BYTES) {
        return res.status(413).json({ error: "Official document PDF is too large. Maximum size is 10MB." });
      }

      if (providedFileUrl && !isValidHttpUrl(providedFileUrl)) {
        return res.status(400).json({ error: "fileUrl must be a valid http(s) URL" });
      }

      let finalFileUrl = providedFileUrl;

      if (req.file) {
        const mime = String(req.file?.mimetype || "").toLowerCase();
        const original = String(req.file?.originalname || "").toLowerCase();
        const isPdf = mime === "application/pdf" || original.endsWith(".pdf");

        if (!isPdf) {
          return res.status(400).json({ error: "Only PDF files are allowed" });
        }

        if (PHOTO_MODE === "cloudinary" || process.env.VERCEL) {
          const publicId = `official_doc_${Date.now()}`;
          const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              {
                resource_type: "raw",
                folder: cloudFolder(CLOUDINARY_FOLDERS.forms),
                public_id: publicId,
                format: "pdf",
              },
              (error, result) => (error ? reject(error) : resolve(result))
            );
            streamifier.createReadStream(req.file.buffer).pipe(stream);
          });
          finalFileUrl = uploadResult.secure_url;
        } else {
          const safeName = `official_doc_${Date.now()}.pdf`;
          const pdfDiskPath = path.join(FORMS_UPLOAD_DIR, safeName);
          await fs.promises.writeFile(pdfDiskPath, req.file.buffer);
          finalFileUrl = buildUploadUrl(req, `forms/${safeName}`);
        }
      }

      const created = await prisma.officialDocument.create({
        data: {
          title,
          description,
          fileUrl: finalFileUrl,
          createdById: req.user.id,
        },
      });

      return res.status(201).json({ message: "✅ Document published", document: created });
    } catch (err) {
      console.error("❌ create document error:", err);
      return res.status(500).json({ error: "Failed to publish document", details: err.message });
    }
  }
);

app.put(
  "/api/staff/documents/:id",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const title = String(req.body?.title || "").trim();
      const description = req.body?.description ? String(req.body.description).trim() : null;
      const fileUrl = String(req.body?.fileUrl || "").trim();

      if (!id) return res.status(400).json({ error: "Invalid document id" });
      if (!title || !fileUrl) return res.status(400).json({ error: "title and fileUrl are required" });
      if (!isValidHttpUrl(fileUrl)) return res.status(400).json({ error: "fileUrl must be a valid http(s) URL" });

      const existing = await prisma.officialDocument.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: "Document not found" });

      const canManage = existing.createdById === req.user.id || ["ADMIN", "SUPERADMIN"].includes(req.user.role);
      if (!canManage) return res.status(403).json({ error: "You can only edit your own document" });

      const updated = await prisma.officialDocument.update({
        where: { id },
        data: { title, description, fileUrl },
      });

      return res.json({ message: "✅ Document updated", document: updated });
    } catch (err) {
      console.error("❌ update document error:", err);
      return res.status(500).json({ error: "Failed to update document", details: err.message });
    }
  }
);

app.delete(
  "/api/staff/documents/:id",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid document id" });

      const existing = await prisma.officialDocument.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: "Document not found" });

      const canManage = existing.createdById === req.user.id || ["ADMIN", "SUPERADMIN"].includes(req.user.role);
      if (!canManage) return res.status(403).json({ error: "You can only delete your own document" });

      await prisma.officialDocument.delete({ where: { id } });
      return res.json({ message: "✅ Document deleted" });
    } catch (err) {
      console.error("❌ delete document error:", err);
      return res.status(500).json({ error: "Failed to delete document", details: err.message });
    }
  }
);

// STAFF/ADMIN: publish news update
app.post(
  "/api/staff/updates",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const { title, message, category } = req.body;
      if (!title || !message) {
        return res.status(400).json({ error: "title and message are required" });
      }

      const created = await prisma.officialUpdate.create({
        data: {
          title: String(title).trim(),
          message: String(message).trim(),
          category: category ? String(category).trim() : null,
          createdById: req.user.id,
        },
      });

      return res.status(201).json({ message: "✅ Update published", update: created });
    } catch (err) {
      console.error("❌ create update error:", err);
      return res.status(500).json({ error: "Failed to publish update", details: err.message });
    }
  }
);

app.put(
  "/api/staff/updates/:id",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const title = String(req.body?.title || "").trim();
      const message = String(req.body?.message || "").trim();
      const category = req.body?.category ? String(req.body.category).trim() : null;

      if (!id) return res.status(400).json({ error: "Invalid update id" });
      if (!title || !message) return res.status(400).json({ error: "title and message are required" });

      const existing = await prisma.officialUpdate.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: "Update not found" });

      const canManage = existing.createdById === req.user.id || ["ADMIN", "SUPERADMIN"].includes(req.user.role);
      if (!canManage) return res.status(403).json({ error: "You can only edit your own update" });

      const updated = await prisma.officialUpdate.update({
        where: { id },
        data: { title, message, category },
      });

      return res.json({ message: "✅ Update edited", update: updated });
    } catch (err) {
      console.error("❌ update news error:", err);
      return res.status(500).json({ error: "Failed to edit update", details: err.message });
    }
  }
);

app.delete(
  "/api/staff/updates/:id",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid update id" });

      const existing = await prisma.officialUpdate.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: "Update not found" });

      const canManage = existing.createdById === req.user.id || ["ADMIN", "SUPERADMIN"].includes(req.user.role);
      if (!canManage) return res.status(403).json({ error: "You can only delete your own update" });

      await prisma.officialUpdate.delete({ where: { id } });
      return res.json({ message: "✅ Update deleted" });
    } catch (err) {
      console.error("❌ delete news error:", err);
      return res.status(500).json({ error: "Failed to delete update", details: err.message });
    }
  }
);

// =========================
// ✅ TRANSFER (change employeeNumber + history)
// =========================

function parseTransferNoticeMessage(raw = "") {
  const text = String(raw || "");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const map = {};

  lines.forEach((line) => {
    const idx = line.indexOf(":");
    if (idx <= 0) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) map[key] = value;
  });

  return {
    transferType: map["Transfer Type"] || "",
    oldEmployeeNumber: map["Old Employee Number"] || "",
    newEmployeeNumber: map["New Employee Number"] || "",
    newEmployerName: map["New Employer/Bank"] || "",
    newBranchName: map["New Branch"] || "",
    workstation: map["New Workstation"] || "",
    reasonNote: map["Reason/Note"] || "",
  };
}

async function executeTransferForUser({ userId, performedById, newEmployeeNumber, newEmployerName, newBranchName, newPhoneNumber, note }) {
  if (!userId) {
    const err = new Error("Invalid user id");
    err.statusCode = 400;
    throw err;
  }

  if (!newEmployeeNumber) {
    const err = new Error("newEmployeeNumber is required");
    err.statusCode = 400;
    throw err;
  }

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  if (target.role !== "CLIENT") {
    const err = new Error("Only CLIENT users can be transferred");
    err.statusCode = 400;
    throw err;
  }

  const existingSubmission = await prisma.submission.findFirst({
    where: { employeeNumber: target.employeeNumber },
    orderBy: { submittedAt: "desc" },
  });

  const trimmedNewEmployeeNumber = String(newEmployeeNumber).trim();
  const trimmedNewEmployerName = newEmployerName ? String(newEmployerName).trim() : null;
  const trimmedNewBranchName = newBranchName ? String(newBranchName).trim() : null;
  const trimmedNewPhoneNumber = newPhoneNumber ? String(newPhoneNumber).trim() : null;
  const trimmedNote = note ? String(note).trim() : null;

  if (trimmedNewEmployeeNumber !== target.employeeNumber) {
    const existingUser = await prisma.user.findUnique({ where: { employeeNumber: trimmedNewEmployeeNumber } });
    if (existingUser) {
      const err = new Error("newEmployeeNumber already exists");
      err.statusCode = 409;
      throw err;
    }

    const existingSubmissionWithNewNumber = await prisma.submission.findUnique({
      where: { employeeNumber: trimmedNewEmployeeNumber },
    });
    if (existingSubmissionWithNewNumber) {
      const err = new Error("Submission already exists for newEmployeeNumber");
      err.statusCode = 409;
      throw err;
    }
  }

  const oldEmployeeNumber = target.employeeNumber;
  const oldEmployerName = existingSubmission?.employerName || null;
  const oldBranchName = existingSubmission?.branchName || null;
  const oldPhoneNumber = existingSubmission?.phoneNumber || null;

  const result = await prisma.$transaction(async (tx) => {
    const history = await tx.transferHistory.create({
      data: {
        userId: target.id,
        performedById,
        oldEmployerName,
        newEmployerName: trimmedNewEmployerName,
        oldBranchName,
        newBranchName: trimmedNewBranchName,
        oldPhoneNumber,
        newPhoneNumber: trimmedNewPhoneNumber,
        oldEmployeeNumber,
        newEmployeeNumber: trimmedNewEmployeeNumber,
        note: trimmedNote,
      },
    });

    const updatedUser = await tx.user.update({
      where: { id: target.id },
      data: {
        employeeNumber: trimmedNewEmployeeNumber,
        username: trimmedNewEmployeeNumber,
      },
      select: {
        id: true,
        name: true,
        employeeNumber: true,
        username: true,
        role: true,
      },
    });

    await tx.submission.updateMany({
      where: { employeeNumber: oldEmployeeNumber },
      data: {
        employeeNumber: trimmedNewEmployeeNumber,
        employerName: trimmedNewEmployerName ?? undefined,
        branchName: trimmedNewBranchName ?? undefined,
        phoneNumber: trimmedNewPhoneNumber ?? undefined,
      },
    });

    return { history, updatedUser };
  });

  return result;
}

// ADMIN/STAFF can transfer a CLIENT (bank change etc.)
app.post(
  "/api/users/:id/transfer",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const userId = Number(req.params.id);
      const {
        newEmployeeNumber,
        newEmployerName,
        newBranchName,
        newPhoneNumber,
        note,
      } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      const result = await executeTransferForUser({
        userId,
        performedById: req.user.id,
        newEmployeeNumber,
        newEmployerName,
        newBranchName,
        newPhoneNumber,
        note,
      });

      return res.json({
        message: "✅ Transfer completed",
        user: result.updatedUser,
        transfer: result.history,
      });
    } catch (err) {
      console.error("❌ transfer error:", err);

      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }

      if (err.code === "P2002") {
        return res.status(409).json({
          error: "Unique constraint failed",
          details: err.meta,
        });
      }

      return res.status(500).json({
        error: "Transfer failed",
        details: err.message,
      });
    }
  }
);

app.post(
  "/api/staff/complaints/:id/approve-transfer",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const complaintId = Number(req.params.id);
      if (!complaintId) return res.status(400).json({ error: "Invalid complaint id" });

      const complaint = await prisma.complaint.findUnique({
        where: { id: complaintId },
        include: {
          user: {
            select: { id: true, name: true, employeeNumber: true, role: true },
          },
          replies: {
            orderBy: { createdAt: "asc" },
          },
        },
      });

      if (!complaint) return res.status(404).json({ error: "Complaint not found" });
      if (!complaint.user) return res.status(400).json({ error: "Complaint has no linked user" });
      if (complaint.user.role !== "CLIENT") return res.status(400).json({ error: "Only client transfer notices can be approved" });
      if (String(complaint.subject || "").trim().toUpperCase() !== "TRANSFER NOTICE") {
        return res.status(400).json({ error: "This complaint is not a transfer notice" });
      }

      const alreadyApproved = complaint.replies.some((r) => String(r.message || "").includes("__TRANSFER_APPROVED__:true"));
      if (alreadyApproved) {
        return res.status(409).json({ error: "Transfer notice already approved" });
      }

      const parsed = parseTransferNoticeMessage(complaint.message);
      const isEmployerChange = String(parsed.transferType || "").toLowerCase().includes("employer");
      const targetNewEmployeeNumber = String(parsed.newEmployeeNumber || "").trim() || complaint.user.employeeNumber;
      const targetNewEmployer = String(parsed.newEmployerName || "").trim();
      const normalizedEmployer = !targetNewEmployer || /^no\s+change$/i.test(targetNewEmployer) ? null : targetNewEmployer;
      const targetNewBranch = String(parsed.newBranchName || "").trim() || null;

      if (!targetNewEmployeeNumber) {
        return res.status(400).json({ error: "Transfer notice missing new employee number" });
      }
      if (!targetNewBranch) {
        return res.status(400).json({ error: "Transfer notice missing new branch" });
      }
      if (isEmployerChange && !normalizedEmployer) {
        return res.status(400).json({ error: "Transfer notice missing new employer/bank for employer-change request" });
      }

      const noteParts = [];
      if (parsed.workstation) noteParts.push(`Workstation: ${parsed.workstation}`);
      if (parsed.reasonNote) noteParts.push(`Client Note: ${parsed.reasonNote}`);
      noteParts.push(`Approved via complaint #${complaint.id}`);

      const transferResult = await executeTransferForUser({
        userId: complaint.user.id,
        performedById: req.user.id,
        newEmployeeNumber: targetNewEmployeeNumber,
        newEmployerName: normalizedEmployer,
        newBranchName: targetNewBranch,
        note: noteParts.join(" | "),
      });

      const approvalReplyLines = [
        "Transfer notice approved and processed.",
        `Old Employee Number: ${parsed.oldEmployeeNumber || complaint.user.employeeNumber}`,
        `New Employee Number: ${transferResult.updatedUser.employeeNumber}`,
        `New Employer/Bank: ${normalizedEmployer || "No change"}`,
        `New Branch: ${targetNewBranch}`,
        "__TRANSFER_APPROVED__:true",
      ];

      const approvalReply = await prisma.complaintReply.create({
        data: {
          complaintId: complaint.id,
          senderId: req.user.id,
          message: approvalReplyLines.join("\n"),
        },
      });

      await prisma.complaint.update({
        where: { id: complaint.id },
        data: {
          status: "RESOLVED",
          lastActivityAt: new Date(),
          staffLastReadAt: new Date(),
        },
      });

      return res.json({
        message: "✅ Transfer notice approved and applied",
        transfer: transferResult.history,
        user: transferResult.updatedUser,
        reply: approvalReply,
      });
    } catch (err) {
      console.error("❌ approve transfer notice error:", err);

      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }

      if (err.code === "P2002") {
        return res.status(409).json({ error: "Unique constraint failed", details: err.meta });
      }

      return res.status(500).json({ error: "Failed to approve transfer notice", details: err.message });
    }
  }
);
// ADMIN/STAFF: view transfer history for a user
app.get(
  "/api/users/:id/transfers",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const userId = Number(req.params.id);
      if (!userId) return res.status(400).json({ error: "Invalid user id" });

      const rows = await prisma.transferHistory.findMany({
        where: { userId },
        include: {
          performedBy: { select: { id: true, name: true, employeeNumber: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return res.json(rows);
    } catch (err) {
      console.error("❌ get transfers error:", err);
      return res.status(500).json({ error: "Failed to fetch transfer history", details: err.message });
    }
  }
);



// --------------------
// PUBLIC ROUTES
// --------------------

// Register new user
app.post('/register', async (req, res) => {
  const { name, email, password, employeeNumber, role } = req.body
  if (!name || !email || !password || !employeeNumber) {
    return res.status(400).json({ error: 'All fields required' })
  }

  try {
    const exists = await prisma.user.findFirst({
      where: { OR: [{ email }, { employeeNumber }] }
    })
    if (exists) return res.status(409).json({ error: 'User already exists' })

    const hashed = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: {
        name,
        email,
        username: employeeNumber,
        employeeNumber,
        password: hashed,
        role: role || 'CLIENT',
        firstLogin: true
      }
    })

    return res.status(201).json({
      message: 'Registered successfully',
      user: { id: user.id, name: user.name, email: user.email }
    })
  } catch (err) {
    console.error('❌ Register error:', err)
    return res.status(500).json({ error: 'Failed to register user' })
  }
})

const OTP_PURPOSE = {
  FIRST_LOGIN: 'FIRST_LOGIN',
  FORGOT_PASSWORD: 'FORGOT_PASSWORD',
};

const OTP_CHANNEL = {
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
  SMS: 'SMS',
};

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
function isPlaceholderConfig(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;

  return [
    'your-email@gmail.com',
    'your-app-password-here',
    'your-callmebot-apikey-here',
    'your-meta-whatsapp-token-here',
    'your-meta-phone-number-id-here',
    'changeme',
    'example',
    'placeholder',
  ].some((token) => normalized.includes(token));
}

function hasUsableSmtpConfig() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    !isPlaceholderConfig(process.env.SMTP_HOST) &&
    !isPlaceholderConfig(process.env.SMTP_USER) &&
    !isPlaceholderConfig(process.env.SMTP_PASS)
  );
}

function hasUsableWhatsappConfig() {
  return Boolean(
    process.env.WHATSAPP_CALLMEBOT_APIKEY &&
    !isPlaceholderConfig(process.env.WHATSAPP_CALLMEBOT_APIKEY)
  );
}

function hasUsableWhatsappMetaConfig() {
  return Boolean(
    process.env.WHATSAPP_META_TOKEN &&
    process.env.WHATSAPP_META_PHONE_NUMBER_ID &&
    !isPlaceholderConfig(process.env.WHATSAPP_META_TOKEN) &&
    !isPlaceholderConfig(process.env.WHATSAPP_META_PHONE_NUMBER_ID)
  );
}

function getWhatsappProviderPreference() {
  const provider = String(process.env.OTP_WHATSAPP_PROVIDER || 'AUTO').trim().toUpperCase();
  return ['AUTO', 'META', 'CALLMEBOT', 'WEBHOOK'].includes(provider) ? provider : 'AUTO';
}

async function sendWhatsappViaMeta({ to, message }) {
  const token = String(process.env.WHATSAPP_META_TOKEN || '').trim();
  const phoneNumberId = String(process.env.WHATSAPP_META_PHONE_NUMBER_ID || '').trim();
  const recipient = String(to || '').replace(/[^\d]/g, '');

  await axios.post(
    `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'text',
      text: { body: message, preview_url: false },
    },
    {
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

function canUseOtpConsoleFallback() {
  return process.env.NODE_ENV !== 'production';
}

function shouldExposeOtpCode(deliveryMode) {
  return process.env.EXPOSE_DEV_OTP === 'true' || deliveryMode === 'console';
}

function maskEmail(value = '') {
  const [name, domain] = String(value).split('@');
  if (!name || !domain) return value;
  const safeName = name.length <= 2 ? `${name[0] || '*'}*` : `${name.slice(0, 2)}***`;
  return `${safeName}@${domain}`;
}

function normalizePhone(value = '') {
  const clean = String(value).replace(/[^\d+]/g, '').trim();
  if (!clean) return '';
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('0')) return `+255${clean.slice(1)}`;
  return clean.startsWith('255') ? `+${clean}` : clean;
}

function maskPhone(value = '') {
  const clean = normalizePhone(value);
  if (!clean) return '';
  const tail = clean.slice(-3);
  return `***${tail}`;
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function resolveWhatsappPhoneForUser(user) {
  const latestSubmission = await prisma.submission.findFirst({
    where: { employeeNumber: user.employeeNumber },
    orderBy: { submittedAt: 'desc' },
    select: { phoneNumber: true },
  });
  return normalizePhone(latestSubmission?.phoneNumber || '');
}

async function sendOtpMessage({ user, channel, purpose, otpCode, target }) {
  const appName = 'FIBUCA';
  const purposeLabel = purpose.replace(/_/g, ' ');
  const msg = `${appName} OTP for ${purposeLabel} is ${otpCode}. Expires in ${OTP_TTL_MINUTES} minutes.`;
  const htmlMsg = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
      <h2 style="color:#1e3a5f;margin-bottom:8px">${appName} – Verification Code</h2>
      <p style="color:#374151">Hello ${user.name || ''},</p>
      <p style="color:#374151">Your OTP code for <strong>${purposeLabel}</strong> is:</p>
      <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#1e3a5f;padding:16px 0">${otpCode}</div>
      <p style="color:#6b7280;font-size:13px">This code expires in ${OTP_TTL_MINUTES} minutes. Do not share it with anyone.</p>
    </div>`;

  if (channel === OTP_CHANNEL.EMAIL) {
    // 1. Use nodemailer SMTP (preferred — set SMTP_HOST in .env)
    if (hasUsableSmtpConfig()) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: target,
        subject: `${appName} OTP Code`,
        text: msg,
        html: htmlMsg,
      });
      return { deliveryMode: 'smtp' };
    }

    // 2. Fallback to webhook
    if (process.env.OTP_EMAIL_WEBHOOK_URL) {
      await axios.post(process.env.OTP_EMAIL_WEBHOOK_URL, {
        to: target,
        subject: `${appName} OTP Code`,
        message: msg,
        html: htmlMsg,
        code: otpCode,
        purpose,
        user: { id: user.id, employeeNumber: user.employeeNumber, name: user.name },
      }, { timeout: 15000 });
      return { deliveryMode: 'webhook' };
    }

    if (canUseOtpConsoleFallback()) {
      console.info(`Email OTP provider not configured. OTP for ${target}: ${otpCode}`);
      return { deliveryMode: 'console' };
    }

    // No provider — fail loudly so the caller returns 500 to the client
    throw new Error('Email not configured. Add SMTP_HOST/SMTP_USER/SMTP_PASS (or OTP_EMAIL_WEBHOOK_URL) to your .env file.');
  }

  if (channel === OTP_CHANNEL.WHATSAPP) {
    const providerPref = getWhatsappProviderPreference();

    // 1. Custom webhook
    if ((providerPref === 'AUTO' || providerPref === 'WEBHOOK') && process.env.OTP_WHATSAPP_WEBHOOK_URL) {
      await axios.post(process.env.OTP_WHATSAPP_WEBHOOK_URL, {
        to: target,
        message: msg,
        code: otpCode,
        purpose,
        user: { id: user.id, employeeNumber: user.employeeNumber, name: user.name },
      }, { timeout: 15000 });
      return { deliveryMode: 'webhook' };
    }

    // 2. Meta WhatsApp Cloud API
    if ((providerPref === 'AUTO' || providerPref === 'META') && hasUsableWhatsappMetaConfig()) {
      await sendWhatsappViaMeta({ to: target, message: msg });
      return { deliveryMode: 'meta' };
    }

    // 3. CallMeBot
    if ((providerPref === 'AUTO' || providerPref === 'CALLMEBOT') && hasUsableWhatsappConfig()) {
      const safeMsg = encodeURIComponent(msg);
      const safePhone = encodeURIComponent(target.replace(/^\+/, ''));
      const apiKey = encodeURIComponent(process.env.WHATSAPP_CALLMEBOT_APIKEY);
      await axios.get(
        `https://api.callmebot.com/whatsapp.php?phone=${safePhone}&text=${safeMsg}&apikey=${apiKey}`,
        { timeout: 15000 }
      );
      return { deliveryMode: 'callmebot' };
    }

    if (canUseOtpConsoleFallback()) {
      console.info(`WhatsApp OTP provider not configured. OTP for ${target}: ${otpCode}`);
      return { deliveryMode: 'console' };
    }

    // No provider — fail loudly
    throw new Error('WhatsApp not configured. Add Meta (WHATSAPP_META_TOKEN + WHATSAPP_META_PHONE_NUMBER_ID), CallMeBot, or OTP_WHATSAPP_WEBHOOK_URL to your .env file.');
  }

  if (channel === OTP_CHANNEL.SMS) {
    if (process.env.OTP_SMS_WEBHOOK_URL) {
      await axios.post(process.env.OTP_SMS_WEBHOOK_URL, {
        to: target,
        message: msg,
        code: otpCode,
        purpose,
        user: { id: user.id, employeeNumber: user.employeeNumber, name: user.name },
      }, { timeout: 15000 });
      return { deliveryMode: 'webhook' };
    }

    if (canUseOtpConsoleFallback()) {
      console.info(`SMS OTP provider not configured. OTP for ${target}: ${otpCode}`);
      return { deliveryMode: 'console' };
    }

    throw new Error('SMS not configured. Add OTP_SMS_WEBHOOK_URL to your .env file.');
  }
}

// Send login credentials to a user via email, WhatsApp, and SMS (best-effort).
async function sendWelcomeCredentials({ user, username, password, phone }) {
  const appName = 'FIBUCA';
  const msg = `Welcome to ${appName}!\n\nYour login credentials:\nUsername: ${username}\nTemporary Password: ${password}\n\nPlease login and change your password immediately at ${process.env.VITE_FRONTEND_URL ? process.env.VITE_FRONTEND_URL.split(',')[0] : ''}`;
  const htmlMsg = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
      <h2 style="color:#1e3a5f;margin-bottom:8px">${appName} – Welcome!</h2>
      <p style="color:#374151">Hello ${user.name || ''},</p>
      <p style="color:#374151">Your account has been created. Here are your login credentials:</p>
      <div style="background:#f9fafb;padding:16px;border-radius:6px;margin:12px 0;border:1px solid #e5e7eb">
        <p style="margin:6px 0"><strong>Username:</strong> <code style="background:#fff;padding:3px 8px;border-radius:3px;border:1px solid #e5e7eb">${username}</code></p>
        <p style="margin:6px 0"><strong>Temporary Password:</strong> <code style="background:#fff;padding:3px 8px;border-radius:3px;border:1px solid #e5e7eb">${password}</code></p>
      </div>
      <p style="color:#dc2626;font-size:13px">&#9888;&#65039; This is a temporary password. Please login and change it immediately.</p>
    </div>`;

  // 1. Email (skip placeholder @fibuca.com addresses)
  if (user.email && !user.email.toLowerCase().endsWith('@fibuca.com')) {
    try {
      if (hasUsableSmtpConfig()) {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === 'true',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: user.email,
          subject: `Welcome to ${appName} – Your Login Credentials`,
          text: msg,
          html: htmlMsg,
        });
      } else if (process.env.OTP_EMAIL_WEBHOOK_URL) {
        await axios.post(process.env.OTP_EMAIL_WEBHOOK_URL, {
          to: user.email,
          subject: `Welcome to ${appName} – Your Login Credentials`,
          message: msg, html: htmlMsg, username, password,
          user: { id: user.id, employeeNumber: user.employeeNumber, name: user.name },
        }, { timeout: 15000 });
      } else {
        console.info(`📧 Email not configured. Credentials for ${user.email} — username: ${username}`);
      }
    } catch (e) {
      console.warn('⚠️ sendWelcomeCredentials email failed:', e.message);
    }
  }

  // 2. WhatsApp
  const waPhone = normalizePhone(phone || '');
  if (waPhone) {
    try {
      const providerPref = getWhatsappProviderPreference();

      if ((providerPref === 'AUTO' || providerPref === 'WEBHOOK') && process.env.OTP_WHATSAPP_WEBHOOK_URL) {
        await axios.post(process.env.OTP_WHATSAPP_WEBHOOK_URL, {
          to: waPhone, message: msg, username, password,
          user: { id: user.id, employeeNumber: user.employeeNumber, name: user.name },
        }, { timeout: 15000 });
      } else if ((providerPref === 'AUTO' || providerPref === 'META') && hasUsableWhatsappMetaConfig()) {
        await sendWhatsappViaMeta({ to: waPhone, message: msg });
      } else if ((providerPref === 'AUTO' || providerPref === 'CALLMEBOT') && hasUsableWhatsappConfig()) {
        const safeMsg = encodeURIComponent(msg);
        const safePhone = encodeURIComponent(waPhone.replace(/^\+/, ''));
        const apiKey = encodeURIComponent(process.env.WHATSAPP_CALLMEBOT_APIKEY);
        await axios.get(`https://api.callmebot.com/whatsapp.php?phone=${safePhone}&text=${safeMsg}&apikey=${apiKey}`, { timeout: 15000 });
      } else {
        console.info(`💬 WhatsApp not configured. Credentials for ${waPhone} — username: ${username}`);
      }
    } catch (e) {
      console.warn('⚠️ sendWelcomeCredentials WhatsApp failed:', e.message);
    }
  }

  // 3. SMS
  if (waPhone && process.env.OTP_SMS_WEBHOOK_URL) {
    try {
      await axios.post(process.env.OTP_SMS_WEBHOOK_URL, {
        to: waPhone, message: msg, username, password,
        user: { id: user.id, employeeNumber: user.employeeNumber, name: user.name },
      }, { timeout: 15000 });
    } catch (e) {
      console.warn('⚠️ sendWelcomeCredentials SMS failed:', e.message);
    }
  }
}

async function persistOtpForUser({ userId, purpose, channel, target, otpCode }) {
  const hash = await bcrypt.hash(otpCode, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await prisma.user.update({
    where: { id: userId },
    data: {
      otpCodeHash: hash,
      otpPurpose: purpose,
      otpChannel: channel,
      otpTarget: target,
      otpExpiresAt: expiresAt,
      otpAttempts: 0,
      otpVerifiedAt: null,
    },
  });

  return expiresAt;
}

async function validateOtpForUser({ user, purpose, otpCode }) {
  if (!user.otpCodeHash || !user.otpPurpose || !user.otpExpiresAt) {
    return { ok: false, status: 400, error: 'No OTP request found. Request OTP first.' };
  }

  if (user.otpPurpose !== purpose) {
    return { ok: false, status: 400, error: 'OTP purpose mismatch. Request a new OTP.' };
  }

  if (new Date(user.otpExpiresAt).getTime() < Date.now()) {
    return { ok: false, status: 400, error: 'OTP expired. Request a new OTP.' };
  }

  const attempts = Number(user.otpAttempts || 0);
  if (attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, status: 429, error: 'Too many OTP attempts. Request a new OTP.' };
  }

  const valid = await bcrypt.compare(String(otpCode || ''), user.otpCodeHash);
  if (!valid) {
    await prisma.user.update({
      where: { id: user.id },
      data: { otpAttempts: attempts + 1 },
    });
    return { ok: false, status: 401, error: 'Invalid OTP code.' };
  }

  return { ok: true };
}

function findUserByIdentifier(identifier = '') {
  const key = String(identifier || '').trim();
  if (!key) return null;

  return prisma.user.findFirst({
    where: {
      OR: [
        { employeeNumber: key },
        { username: key },
        { email: key },
      ],
    },
  });
}

// Request OTP for first-login or forgot-password.
app.post('/api/auth/request-otp', async (req, res) => {
  try {
    const { identifier, purpose, channel } = req.body;
    const otpPurpose = String(purpose || '').trim().toUpperCase();
    const otpChannel = String(channel || OTP_CHANNEL.EMAIL).trim().toUpperCase();

    if (!identifier || !otpPurpose) {
      return res.status(400).json({ error: 'identifier and purpose are required' });
    }

    if (!Object.values(OTP_PURPOSE).includes(otpPurpose)) {
      return res.status(400).json({ error: 'Unsupported OTP purpose' });
    }

    if (!Object.values(OTP_CHANNEL).includes(otpChannel)) {
      return res.status(400).json({ error: 'Unsupported OTP channel' });
    }

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (otpPurpose === OTP_PURPOSE.FIRST_LOGIN && !user.firstLogin) {
      return res.status(400).json({ error: 'First-login OTP is not required for this account' });
    }

    let effectiveChannel = otpChannel;
    let target = '';
    const whatsappPhone = await resolveWhatsappPhoneForUser(user);

    if (effectiveChannel === OTP_CHANNEL.EMAIL) {
      if (user.email) {
        target = user.email;
      } else if (whatsappPhone) {
        effectiveChannel = OTP_CHANNEL.WHATSAPP;
        target = whatsappPhone;
      } else {
        return res.status(400).json({ error: 'This account has no email or WhatsApp phone configured' });
      }
    } else {
      if (whatsappPhone) {
        target = whatsappPhone;
      } else if (user.email) {
        effectiveChannel = OTP_CHANNEL.EMAIL;
        target = user.email;
      } else {
        return res.status(400).json({ error: 'No WhatsApp phone or email found for this account' });
      }
    }

    const otpCode = generateOtpCode();
    let expiresAt = await persistOtpForUser({
      userId: user.id,
      purpose: otpPurpose,
      channel: effectiveChannel,
      target,
      otpCode,
    });

    let delivery;
    try {
      delivery = await sendOtpMessage({ user, channel: effectiveChannel, purpose: otpPurpose, otpCode, target });
    } catch (primaryErr) {
      if (effectiveChannel === OTP_CHANNEL.WHATSAPP && user.email) {
        effectiveChannel = OTP_CHANNEL.EMAIL;
        target = user.email;
        expiresAt = await persistOtpForUser({
          userId: user.id,
          purpose: otpPurpose,
          channel: effectiveChannel,
          target,
          otpCode,
        });
        delivery = await sendOtpMessage({ user, channel: effectiveChannel, purpose: otpPurpose, otpCode, target });
      } else {
        throw primaryErr;
      }
    }

    const maskedTarget = effectiveChannel === OTP_CHANNEL.EMAIL ? maskEmail(target) : maskPhone(target);
    const payload = {
      message: `OTP sent via ${effectiveChannel}`,
      channel: effectiveChannel,
      target: maskedTarget,
      expiresAt,
    };

    if (shouldExposeOtpCode(delivery?.deliveryMode)) {
      payload.devOtp = otpCode;
    }

    return res.json(payload);
  } catch (err) {
    console.error('❌ request-otp error:', err);
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify OTP only (optional step before reset).
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { identifier, purpose, otp } = req.body;
    const otpPurpose = String(purpose || '').trim().toUpperCase();

    if (!identifier || !otpPurpose || !otp) {
      return res.status(400).json({ error: 'identifier, purpose and otp are required' });
    }

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await validateOtpForUser({ user, purpose: otpPurpose, otpCode: otp });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { otpVerifiedAt: new Date() },
    });

    return res.json({ message: 'OTP verified successfully' });
  } catch (err) {
    console.error('❌ verify-otp error:', err);
    return res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// Forgot-password reset using OTP.
app.post('/api/auth/reset-password-with-otp', async (req, res) => {
  try {
    const { identifier, otp, newPassword } = req.body;

    if (!identifier || !otp || !newPassword) {
      return res.status(400).json({ error: 'identifier, otp and newPassword are required' });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await validateOtpForUser({
      user,
      purpose: OTP_PURPOSE.FORGOT_PASSWORD,
      otpCode: otp,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    const hash = await bcrypt.hash(String(newPassword), 10);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hash,
        firstLogin: false,
        otpCodeHash: null,
        otpPurpose: null,
        otpChannel: null,
        otpTarget: null,
        otpExpiresAt: null,
        otpAttempts: 0,
        otpVerifiedAt: null,
      },
    });

    return res.json({ message: 'Password reset successful. You can now login.' });
  } catch (err) {
    console.error('❌ reset-password-with-otp error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Authenticated first-login OTP request (for users who already logged in once with temp password).
app.post('/api/auth/request-first-login-otp', authenticate, async (req, res) => {
  try {
    const requestedChannel = String(req.body?.channel || OTP_CHANNEL.EMAIL).trim().toUpperCase();
    if (!Object.values(OTP_CHANNEL).includes(requestedChannel)) {
      return res.status(400).json({ error: 'Unsupported OTP channel' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.firstLogin) {
      return res.status(400).json({ error: 'First-login OTP is not required for this account' });
    }

    let channel = requestedChannel;
    let target = '';
    const whatsappPhone = await resolveWhatsappPhoneForUser(user);

    if (channel === OTP_CHANNEL.EMAIL) {
      if (user.email) {
        target = user.email;
      } else if (whatsappPhone) {
        channel = OTP_CHANNEL.WHATSAPP;
        target = whatsappPhone;
      } else {
        return res.status(400).json({ error: 'No email or WhatsApp phone configured for this account' });
      }
    } else {
      if (whatsappPhone) {
        target = whatsappPhone;
      } else if (user.email) {
        channel = OTP_CHANNEL.EMAIL;
        target = user.email;
      } else {
        return res.status(400).json({ error: 'No WhatsApp phone or email configured for this account' });
      }
    }

    const otpCode = generateOtpCode();
    let expiresAt = await persistOtpForUser({
      userId: user.id,
      purpose: OTP_PURPOSE.FIRST_LOGIN,
      channel,
      target,
      otpCode,
    });

    let delivery;
    try {
      delivery = await sendOtpMessage({ user, channel, purpose: OTP_PURPOSE.FIRST_LOGIN, otpCode, target });
    } catch (primaryErr) {
      if (channel === OTP_CHANNEL.WHATSAPP && user.email) {
        channel = OTP_CHANNEL.EMAIL;
        target = user.email;
        expiresAt = await persistOtpForUser({
          userId: user.id,
          purpose: OTP_PURPOSE.FIRST_LOGIN,
          channel,
          target,
          otpCode,
        });
        delivery = await sendOtpMessage({ user, channel, purpose: OTP_PURPOSE.FIRST_LOGIN, otpCode, target });
      } else {
        throw primaryErr;
      }
    }

    const payload = {
      message: `OTP sent via ${channel}`,
      channel,
      target: channel === OTP_CHANNEL.EMAIL ? maskEmail(target) : maskPhone(target),
      expiresAt,
    };
    if (shouldExposeOtpCode(delivery?.deliveryMode)) payload.devOtp = otpCode;

    return res.json(payload);
  } catch (err) {
    console.error('❌ request-first-login-otp error:', err);
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Authenticated completion of first-login password setup using OTP.
// Simple first-login password setup — no OTP required.
// Client is trusted because they just logged in with the temp credentials the admin gave them.
app.post('/api/auth/complete-first-login', authenticate, async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ error: 'newPassword is required' });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.firstLogin) {
      return res.status(400).json({ error: 'First-login flow is already completed' });
    }

    const hash = await bcrypt.hash(String(newPassword), 10);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hash,
        firstLogin: false,
        otpCodeHash: null,
        otpPurpose: null,
        otpChannel: null,
        otpTarget: null,
        otpExpiresAt: null,
        otpAttempts: 0,
        otpVerifiedAt: null,
      },
    });

    return res.json({ message: 'First-login setup complete. Password updated.' });
  } catch (err) {
    console.error('❌ complete-first-login error:', err);
    return res.status(500).json({ error: 'Failed to complete first login' });
  }
});

// Login → set cookie
app.post('/api/login', async (req, res) => {
  const { employeeNumber, username, password } = req.body
  try {
    const loginId = String(employeeNumber || username || '').trim()
    if (!loginId || !password) {
      return res.status(400).json({ error: 'employeeNumber/username and password are required' })
    }

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const attemptKey = `${loginId.toLowerCase()}|${clientIp}`;
    const now = Date.now();
    const attemptInfo = loginAttemptStore.get(attemptKey);

    if (attemptInfo?.lockUntil && attemptInfo.lockUntil > now) {
      const remainingSec = Math.ceil((attemptInfo.lockUntil - now) / 1000);
      recordSecurityEvent('login_locked_attempt', req, { loginId, remainingSec });
      return res.status(429).json({ error: `Account temporarily locked. Try again in ${remainingSec}s.` });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { employeeNumber: loginId },
          { username: loginId }
        ]
      }
    })
    if (!user) {
      const fail = (attemptInfo?.count || 0) + 1;
      const lockUntil = fail >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_LOCK_MS : 0;
      loginAttemptStore.set(attemptKey, { count: fail, lockUntil });
      recordSecurityEvent('login_user_not_found', req, { loginId, failures: fail, locked: !!lockUntil });
      return res.status(404).json({ error: 'User not found' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      const fail = (attemptInfo?.count || 0) + 1;
      const lockUntil = fail >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_LOCK_MS : 0;
      loginAttemptStore.set(attemptKey, { count: fail, lockUntil });
      recordSecurityEvent('login_invalid_password', req, {
        loginId,
        userId: user.id,
        failures: fail,
        locked: !!lockUntil,
      });
      return res.status(401).json({ error: 'Incorrect password' })
    }

    loginAttemptStore.delete(attemptKey)
    recordSecurityEvent('login_success', req, { userId: user.id, role: user.role });

    const token = jwt.sign(
      { id: user.id, employeeNumber: user.employeeNumber, name: user.name, role: user.role, firstLogin: user.firstLogin },
      JWT_SECRET,
      { expiresIn: '2h' }
    )

    res.cookie('fibuca_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none', // cross-origin
      maxAge: 7 * 24 * 60 * 60 * 1000
    })
    // last PDF path
    const last = await prisma.submission.findFirst({
      where: { employeeNumber: user.employeeNumber },
      orderBy: { submittedAt: 'desc' }
    })

    // Also return token in JSON as a fallback for clients where cookies are blocked
    res.json({
      token,
      user: {
        id: user.id,
        employeeNumber: user.employeeNumber,
        role: user.role,
        name: user.name,
        email: user.email,
        profilePhotoUrl: user.profilePhotoUrl || null,
        firstLogin: user.firstLogin,
        pdfPath: last?.pdfPath || null
      }
    })

  } catch (err) {
    console.error('❌ Login error:', err)
    return res.status(500).json({ error: 'Login failed' })
  }
})

// --------------------
// PROTECTED ROUTES
// --------------------

// WhoAmI
app.get('/api/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password: _p, otpCodeHash: _o, ...safe } = user;
  res.json({ user: safe })
})

// SUPERADMIN: unified monitoring + control center data
app.get('/api/superadmin/overview', authenticate, requireRole(['SUPERADMIN']), async (req, res) => {
  try {
    const now = Date.now();
    const oneHourAgoIso = new Date(now - (60 * 60 * 1000)).toISOString();

    const [
      totalUsers,
      activeUsers,
      archivedUsers,
      totalSubmissions,
      archivedSubmissions,
      totalComplaints,
      openComplaints,
      totalTransfers,
      allUsers,
      recentUsers,
      recentComplaints,
      recentTransfers,
      roleBreakdown,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { NOT: { deletedAt: null } } }),
      prisma.submission.count(),
      prisma.submission.count({ where: { NOT: { deletedAt: null } } }),
      prisma.complaint.count(),
      prisma.complaint.count({ where: { status: 'OPEN' } }),
      prisma.transferHistory.count(),
      prisma.user.findMany({
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          employeeNumber: true,
          role: true,
          createdAt: true,
          deletedAt: true,
        },
        orderBy: [
          { deletedAt: 'asc' },
          { createdAt: 'desc' },
        ],
      }),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          name: true,
          employeeNumber: true,
          role: true,
          createdAt: true,
          deletedAt: true,
        },
      }),
      prisma.complaint.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: {
          id: true,
          subject: true,
          status: true,
          updatedAt: true,
          user: {
            select: { id: true, name: true, employeeNumber: true },
          },
        },
      }),
      prisma.transferHistory.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          oldEmployerName: true,
          newEmployerName: true,
          oldEmployeeNumber: true,
          newEmployeeNumber: true,
          createdAt: true,
          user: { select: { id: true, name: true } },
          performedBy: { select: { id: true, name: true, role: true } },
        },
      }),
      prisma.user.groupBy({
        by: ['role'],
        _count: { role: true },
      }),
    ]);

    const lockouts = [];
    for (const [key, info] of loginAttemptStore.entries()) {
      if (info?.lockUntil && info.lockUntil > now) {
        lockouts.push({
          key,
          count: info.count || 0,
          lockUntil: new Date(info.lockUntil).toISOString(),
          remainingSec: Math.ceil((info.lockUntil - now) / 1000),
        });
      }
    }

    const latestSecurityEvents = securityEventStore.slice(0, 25);
    const latestRequests = requestSnapshotStore.slice(0, 60);
    const userAuditEvents = await prisma.userAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    const suspiciousLastHour = securityEventStore.filter((event) => {
      return event.createdAt >= oneHourAgoIso && event.type !== 'login_success';
    }).length;

    // Active sessions — who is currently logged in
    const ONLINE_THRESH = 5 * 60 * 1000;
    const IDLE_THRESH = 60 * 60 * 1000;
    const sessionEntries = [...activeSessionStore.values()].filter(
      (s) => s && (now - s.lastSeenMs) < ACTIVE_SESSION_TIMEOUT_MS
    );
    let activeSessions = [];
    if (sessionEntries.length > 0) {
      const userIds = sessionEntries.map((s) => s.userId);
      const dbUsers = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, employeeNumber: true, role: true },
      });
      const userMap = new Map(dbUsers.map((u) => [u.id, u]));
      activeSessions = sessionEntries.map((s) => {
        const dbUser = userMap.get(s.userId) || {};
        const idleMs = now - s.lastSeenMs;
        const status = idleMs < ONLINE_THRESH ? 'online' : idleMs < IDLE_THRESH ? 'idle' : 'away';
        return {
          userId: s.userId,
          name: dbUser.name || s.employeeNumber || String(s.userId),
          employeeNumber: dbUser.employeeNumber || s.employeeNumber,
          role: dbUser.role || s.role,
          ip: s.ip,
          userAgent: s.userAgent,
          lastSeen: s.lastSeen,
          lastSeenMs: s.lastSeenMs,
          status,
        };
      }).sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    }

    return res.json({
      generatedAt: new Date().toISOString(),
      metrics: {
        users: {
          total: totalUsers,
          active: activeUsers,
          archived: archivedUsers,
          byRole: roleBreakdown.reduce((acc, row) => {
            acc[row.role] = row._count.role;
            return acc;
          }, {}),
        },
        submissions: {
          total: totalSubmissions,
          archived: archivedSubmissions,
        },
        complaints: {
          total: totalComplaints,
          open: openComplaints,
        },
        transfers: {
          total: totalTransfers,
        },
        security: {
          activeLockouts: lockouts.length,
          suspiciousEventsLastHour: suspiciousLastHour,
          trackedEvents: securityEventStore.length,
          trackedRequests: requestSnapshotStore.length,
        },
      },
      allUsers,
      activeSessions,
      userAuditEvents,
      lockouts,
      securityEvents: latestSecurityEvents,
      recentRequests: latestRequests,
      recentUsers,
      recentComplaints,
      recentTransfers,
    });
  } catch (err) {
    console.error('❌ GET /api/superadmin/overview error:', err);
    return res.status(500).json({ error: 'Failed to load superadmin overview', details: err.message });
  }
});

// SUPERADMIN: reset in-memory security state (lockouts + telemetry buffers)
app.post('/api/superadmin/security/reset-state', authenticate, requireRole(['SUPERADMIN']), async (req, res) => {
  try {
    loginAttemptStore.clear();
    securityEventStore.length = 0;
    requestSnapshotStore.length = 0;

    recordSecurityEvent('security_state_reset', req, { byUserId: req.user.id });

    return res.json({
      message: '✅ Superadmin security state reset completed',
      reset: {
        loginLockoutsCleared: true,
        securityEventsCleared: true,
        requestSnapshotsCleared: true,
      },
    });
  } catch (err) {
    console.error('❌ POST /api/superadmin/security/reset-state error:', err);
    return res.status(500).json({ error: 'Failed to reset security state', details: err.message });
  }
});

// PUT /api/profile — update own name/email/phone/phone2 (cannot delete existing phone)
app.put('/api/profile', authenticate, async (req, res) => {
  try {
    const { name, email, phone, phone2 } = req.body;
    const current = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!current) return res.status(404).json({ error: 'User not found' });

    const data = {};

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ error: 'Name is required' });
      }
      if (trimmed.length < 2) {
        return res.status(400).json({ error: 'Name is too short' });
      }
      data.name = trimmed;
    }

    if (email !== undefined) {
      const trimmed = String(email).trim();
      if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      data.email = trimmed || null;
    }

    if (phone !== undefined) {
      const trimmed = String(phone).trim();
      if (!trimmed && current.phone) {
        return res.status(400).json({ error: 'Cannot remove existing phone number' });
      }
      if (trimmed) data.phone = trimmed;
    }

    if (phone2 !== undefined) {
      const trimmed = String(phone2).trim();
      if (!trimmed && current.phone2) {
        return res.status(400).json({ error: 'Cannot remove existing second phone number' });
      }
      if (trimmed) data.phone2 = trimmed;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No changes provided' });
    }

    const updated = await prisma.user.update({ where: { id: req.user.id }, data });
    const { password: _p, otpCodeHash: _o, ...safe } = updated;
    return res.json({ user: safe });
  } catch (err) {
    console.error('❌ PUT /api/profile error:', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

// PUT /api/profile/photo — upload own profile photo
app.put('/api/profile/photo', authenticate, uploadPhoto.single('photo'), async (req, res) => {
  try {
    const current = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!current) return res.status(404).json({ error: 'User not found' });

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    if (!String(req.file.mimetype || '').startsWith('image/')) {
      return res.status(400).json({ error: 'Uploaded file must be an image' });
    }

    let profilePhotoUrl = '';

    if (PHOTO_MODE === 'cloudinary') {
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: cloudFolder(CLOUDINARY_FOLDERS.profiles),
            resource_type: 'image',
          },
          (error, result) => (error ? reject(error) : resolve(result))
        );
        streamifier.createReadStream(req.file.buffer).pipe(stream);
      });

      profilePhotoUrl = uploadResult.secure_url;
    } else {
      const ext = path.extname(req.file.originalname || '').toLowerCase() || '.png';
      const safeExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';
      const fileName = `profile_${req.user.id}_${Date.now()}${safeExt}`;
      const diskPath = path.join(PROFILES_UPLOAD_DIR, fileName);
      await fs.promises.writeFile(diskPath, req.file.buffer);
      profilePhotoUrl = buildUploadUrl(req, `profiles/${fileName}`);
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { profilePhotoUrl },
    });

    const { password: _p, otpCodeHash: _o, ...safe } = updated;
    return res.json({ user: safe });
  } catch (err) {
    console.error('❌ PUT /api/profile/photo error:', err);
    return res.status(500).json({ error: 'Failed to upload profile photo' });
  }
});

// Runtime mode hints for frontend upload strategy (no auth needed — returns only config).
app.get('/api/photo-mode', (req, res) => {
  res.json({
    photoMode: PHOTO_MODE,
    isVercel: IS_VERCEL,
    preferClientBgRemoval: IS_VERCEL,
  })
})

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('fibuca_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'none'
  });
  res.status(200).json({ message: 'Logged out' });
});



// —–– PROTECTED: Change password
app.put('/api/change-password', authenticate, async (req, res) => {
  const { oldPassword, newPassword } = req.body
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Both fields required' })
  }
  try {
    const u = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!await bcrypt.compare(oldPassword, u.password)) {
      return res.status(401).json({ error: 'Current password incorrect' })
    }
    const hashed = await bcrypt.hash(newPassword, 10)
    await prisma.user.update({
      where: { id: req.user.id },
      data: { password: hashed, firstLogin: false }
    })
    return res.json({ message: 'Password changed' })
  } catch (err) {
    console.error('❌ change-password error:', err)
    return res.status(500).json({ error: 'Failed to change password' })
  }
})


// ---------- GET /api/submissions/:employeeNumber ----------
app.get('/api/submissions/:employeeNumber', authenticate, async (req, res) => {
  try {
    const submission = await prisma.submission.findUnique({
      where: { employeeNumber: req.params.employeeNumber },
    });
    if (!submission) return res.status(404).json({ error: 'No submission found' });
    res.json(submission);
  } catch (err) {
    console.error('❌ fetch submission failed:', err);
    res.status(500).json({ error: 'Failed to fetch submission' });
  }
});

app.get(
  "/api/submissions/search",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const { employerName, branchName, employeeName, employeeNumber, phoneNumber } = req.query;

      const where = {};

      if (employerName) {
        where.employerName = {
          contains: String(employerName).trim(),
          mode: "insensitive",
        };
      }

      if (branchName) {
        where.branchName = {
          contains: String(branchName).trim(),
          mode: "insensitive",
        };
      }

      if (employeeName) {
        where.employeeName = {
          contains: String(employeeName).trim(),
          mode: "insensitive",
        };
      }

      if (employeeNumber) {
        where.employeeNumber = {
          contains: String(employeeNumber).trim(),
          mode: "insensitive",
        };
      }

      if (phoneNumber) {
        where.phoneNumber = {
          contains: String(phoneNumber).trim(),
          mode: "insensitive",
        };
      }

      const rows = await prisma.submission.findMany({
        where,
        orderBy: { submittedAt: "desc" },
      });

      return res.json(rows);
    } catch (err) {
      console.error("❌ submission search error:", err);
      return res.status(500).json({ error: "Failed to search submissions", details: err.message });
    }
  }
);

// ---------- POST /submit-form ----------

app.post("/submit-form/:token", uploadPDF.single("pdf"), async (req, res) => {
  try {

    const { token } = req.params;

    let link = await prisma.staffLink.findUnique({
      where: { token },
    });

    if (!link) {
      return res.status(400).json({ error: "Invalid link" });
    }

    let updatedLink = link;
    try {
      updatedLink = await refreshLinkStatus(link);
    } catch (err) {
      console.error('❌ Failed to refresh link status:', err.message);
      updatedLink = link; // Use original if refresh fails
    }

    if (!updatedLink || !updatedLink.isActive) {
      return res.status(400).json({ error: "Link expired or inactive" });
    }


    // 1️⃣ Parse form JSON from frontend
    const form = normalizeSubmissionPayload(JSON.parse(req.body.data));
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    // Verify Cloudinary is configured
    let pdfUrl = "";

    if (PHOTO_MODE === "cloudinary" || process.env.VERCEL) {
      if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY) {
        console.error("❌ Cloudinary not configured. Missing env vars:", {
          CLOUDINARY_CLOUD_NAME: !!process.env.CLOUDINARY_CLOUD_NAME,
          CLOUDINARY_API_KEY: !!process.env.CLOUDINARY_API_KEY,
          CLOUDINARY_API_SECRET: !!process.env.CLOUDINARY_API_SECRET,
        });
        return res.status(500).json({
          error: "Server misconfigured: Cloudinary not set up. Contact admin.",
          details: "Missing Cloudinary environment variables",
        });
      }

      const publicId = `form_${form.employeeNumber}_${Date.now()}`;
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: "raw",
            folder: cloudFolder(CLOUDINARY_FOLDERS.forms),
            public_id: publicId,
            format: "pdf",
          },
          (error, result) => (error ? reject(error) : resolve(result))
        );
        streamifier.createReadStream(req.file.buffer).pipe(stream);
      });

      pdfUrl = uploadResult.secure_url;
    } else {
      const pdfFilename = `form_${form.employeeNumber}_${Date.now()}.pdf`;
      const pdfDiskPath = path.join(FORMS_UPLOAD_DIR, pdfFilename);

      await fs.promises.writeFile(pdfDiskPath, req.file.buffer);
      pdfUrl = buildUploadUrl(req, `forms/${pdfFilename}`);
    }

    // 4️⃣ Check for existing submission
    const existingSubmission = await prisma.submission.findUnique({
      where: { employeeNumber: form.employeeNumber },
    });

    if (existingSubmission) {
      // Only reject as a genuine duplicate if the ID card was also created successfully.
      // If the card is missing, this is a partial failure (submission saved but idCard.create
      // crashed) — allow recovery by falling through rather than returning 409.
      const existingUserForCheck = await prisma.user.findUnique({ where: { employeeNumber: form.employeeNumber } });
      const existingCardForCheck = existingUserForCheck
        ? await prisma.idCard.findFirst({ where: { userId: existingUserForCheck.id } })
        : null;

      if (existingCardForCheck) {
        return res.status(409).json({ error: 'Submission already exists for this employee number' });
      }
      // Partial failure detected — fall through to recover the missing ID card
    }

    // 5️⃣ Create new submission (skip if recovering from a partial failure)
    let submission = existingSubmission;
    if (!submission) {
      submission = await prisma.submission.create({
        data: {
          employeeName: form.employeeName,
          employeeNumber: form.employeeNumber,
          phoneNumber: form.phoneNumber,
          employerName: form.employerName,
          branchName: form.branchName,
          dues: form.dues,
          witness: form.witness,
          pdfPath: pdfUrl,
          submittedAt: new Date(),
          staffId: updatedLink.staffId,
        },
      });

      //increment link usage
      await prisma.staffLink.update({
        where: { id: updatedLink.id },
        data: { usedCount: { increment: 1 } }
      });
    }

    // 6️⃣ Check if user exists, else create
    let user = await prisma.user.findUnique({ where: { employeeNumber: form.employeeNumber } });
    let tempPassword = null;

    if (!user) {
      const suffix = Math.floor(1000 + Math.random() * 9000);
      tempPassword = form.employeeNumber + suffix;
      const hashedPassword = await bcrypt.hash(tempPassword.toString(), 10);

      user = await prisma.user.create({
        data: {
          name: form.employeeName,
          username: form.employeeNumber,
          email: `${form.employeeNumber}@fibuca.com`,
          password: hashedPassword,
          employeeNumber: form.employeeNumber,
          role: "CLIENT",
        },
      });

      // Send credentials via all configured channels (best-effort)
      sendWelcomeCredentials({
        user,
        username: user.username,
        password: tempPassword,
        phone: form.phoneNumber || '',
      }).catch((e) => console.warn('⚠️ sendWelcomeCredentials (submit-form) failed:', e.message));
    }

    // 7️⃣ Generate placeholder ID card if not exists
    const makeCardNumber = () => {
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const prefix = Array.from({ length: 2 })
        .map(() => letters[Math.floor(Math.random() * letters.length)])
        .join("");
      const digits = Math.floor(100000 + Math.random() * 900000);
      return `FIBUCA${prefix}${digits}`;
    };

    let placeholderCard = await prisma.idCard.findFirst({ where: { userId: user.id } });
    if (!placeholderCard) {
      placeholderCard = await prisma.idCard.create({
        data: {
          userId: user.id,
          fullName: user.name,
          rawPhotoUrl: "",
          cleanPhotoUrl: "",
          company: submission.employerName,
          role: "Member",
          issuedAt: new Date(),
          cardNumber: makeCardNumber(),
          verificationToken: generateIdCardVerificationToken(),
        },
      });
    }

    // 8️⃣ Respond to frontend
    res.status(200).json({
      message: "✅ Form submitted successfully",
      submission,
      user: {
        id: user.id,
        name: user.name,
        employeeNumber: user.employeeNumber,
        role: user.role,
        firstLogin: user.firstLogin,
        pdfUrl,
      },
      loginCredentials: tempPassword ? { username: user.username, password: tempPassword } : null,
      idCard: placeholderCard,
    });
  } catch (err) {
    console.error("❌ Submission error:", err);
    res.status(500).json({ error: "Failed to submit form", details: err.message });
  }
});

const crypto = require("crypto");

function generateIdCardVerificationToken() {
  return crypto.randomBytes(18).toString("base64url");
}

async function ensureIdCardVerificationToken(card) {
  if (!card || card.verificationToken) return card;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const verificationToken = generateIdCardVerificationToken();
      const updated = await prisma.idCard.update({
        where: { id: card.id },
        data: { verificationToken },
      });
      return { ...card, verificationToken: updated.verificationToken };
    } catch (err) {
      if (err?.code !== 'P2002') {
        throw err;
      }
    }
  }

  throw new Error(`Failed to assign verification token for ID card ${card.id}`);
}

async function ensureIdCardVerificationTokens(cards = []) {
  return Promise.all(cards.map((card) => ensureIdCardVerificationToken(card)));
}

function getPublicIdCardStatus(card) {
  if (!card) return 'NOT_FOUND';
  if (!card.isActive || card.revokedAt) return 'REVOKED';
  if (card.expiresAt && new Date(card.expiresAt).getTime() < Date.now()) return 'EXPIRED';
  return 'VALID';
}

function buildPublicIdCardResponse(card) {
  const status = getPublicIdCardStatus(card);
  const valid = status === 'VALID';

  if (!card) {
    return {
      valid: false,
      status,
      message: 'ID card not found',
      card: null,
    };
  }

  return {
    valid,
    status,
    message:
      status === 'VALID'
        ? 'Verified genuine ID card'
        : status === 'REVOKED'
        ? 'This ID card has been revoked'
        : 'This ID card has expired',
    card: {
      fullName: card.fullName,
      role: card.role,
      company: card.company,
      cardNumber: card.cardNumber,
      issuedAt: card.issuedAt,
      expiresAt: card.expiresAt,
      photoUrl: card.cleanPhotoUrl || card.rawPhotoUrl || null,
    },
  };
}

app.get('/api/public/idcards/verify/:token', publicVerifyLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 12 || token.length > 200) {
      return res.status(400).json({ valid: false, status: 'INVALID_REQUEST', message: 'Invalid verification token' });
    }

    const card = await prisma.idCard.findUnique({
      where: { verificationToken: token },
    });

    if (!card) {
      recordSecurityEvent('public_idcard_verify_not_found', req, { tokenPrefix: token.slice(0, 8) });
      return res.json(buildPublicIdCardResponse(null));
    }

    return res.json(buildPublicIdCardResponse(card));
  } catch (err) {
    console.error('❌ GET /api/public/idcards/verify/:token error:', err);
    return res.status(500).json({ valid: false, status: 'ERROR', message: 'Failed to verify ID card' });
  }
});

// POST /api/staff/generate-link
app.post(
  "/api/staff/generate-link",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const { hoursValid, maxUses } = req.body;

      // Short, URL-safe code (still cryptographically random)
      const token = crypto.randomBytes(12).toString("base64url");

      const expiresAt = new Date(
        Date.now() + (hoursValid || 24) * 60 * 60 * 1000
      );

      const link = await prisma.staffLink.create({
        data: {
          token,
          staffId: req.user.id,
          expiresAt,
          maxUses: maxUses || null,
        },
      });

      // Generate frontend URL with simplified fallback
      let frontendUrl = process.env.VITE_FRONTEND_URL;

      // If env var not set and on Vercel, use production URL
      if (!frontendUrl && process.env.VERCEL) {
        frontendUrl = "https://www.fibucatumis.or.tz,https://fibuca-frontend.vercel.app";
      }

      // Otherwise use request origin for local development
      if (!frontendUrl) {
        frontendUrl = `${req.protocol}://${req.get('host')}`;
      }

      console.log(`✅ Generate-link: frontendUrl="${frontendUrl}", VERCEL=${process.env.VERCEL}, VITE_FRONTEND_URL="${process.env.VITE_FRONTEND_URL}"`);

      res.json({
        message: "✅ Link created",
        code: token,
        link: `${frontendUrl}/submission/${token}`,
        expiresAt,
        maxUses: link.maxUses,
      });
    } catch (err) {
      console.error("❌ generate-link error:", err);
      res.status(500).json({ error: "Failed to generate link" });
    }
  }
);


// GET /api/staff/validate/:token
app.get("/api/staff/validate/:token", async (req, res) => {
  try {
    const { token } = req.params;

    console.log(`🔍 Validate request: token="${token ? token.substring(0, 16) + '...' : 'NONE'}"`);

    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      console.warn('❌ Invalid or empty token parameter');
      return res.status(400).json({ error: "Token is required" });
    }

    let link = null;
    try {
      link = await prisma.staffLink.findUnique({
        where: { token },
      });
    } catch (dbErr) {
      console.error('❌ Database error finding link:', dbErr.message);
      return res.status(500).json({ error: "Database error", details: dbErr.message });
    }

    if (!link) {
      console.warn(`❌ Link not found for token: ${token.substring(0, 16)}...`);
      return res.status(400).json({ error: "Invalid link" });
    }

    console.log(`✅ Link found: id=${link.id}, active=${link.isActive}, expires=${link.expiresAt}`);

    // Refresh and validate link status (but don't let failures stop validation)
    let validLink = link;
    try {
      validLink = await refreshLinkStatus(link);
      console.log(`✅ Link status refreshed: isActive=${validLink.isActive}`);
    } catch (refreshErr) {
      console.error('❌ Link status refresh threw error (using current status):', refreshErr.message);
      validLink = link;
    }

    if (!validLink) {
      console.error('❌ Link validation returned null');
      return res.status(400).json({ error: "Link validation failed" });
    }

    if (!validLink.isActive) {
      console.warn(`❌ Link ${validLink.id} is not active`);
      return res.status(400).json({ error: "Link expired or inactive" });
    }

    console.log(`✅ Link ${validLink.id} is valid and active - VALIDATION PASSED`);
    res.json({ valid: true });

  } catch (err) {
    console.error("❌ Validate endpoint unhandled error:", err.message);
    console.error("Stack trace:", err.stack);
    res.status(500).json({ error: "Validation failed", details: err.message });
  }
});

// GET /api/staff/links
app.get(
  "/api/staff/links",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const links = await prisma.staffLink.findMany({
        where: { staffId: req.user.id },
        orderBy: { createdAt: "desc" },
      });

      res.json(links);
    } catch (err) {
      console.error("❌ fetch staff links error:", err);
      res.status(500).json({ error: "Failed to fetch links" });
    }
  }
);


// GET /api/staff/submissions
app.get(
  "/api/staff/submissions",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const submissions = await prisma.submission.findMany({
        where: { staffId: req.user.id },
        orderBy: { submittedAt: "desc" },
      });

      res.json(submissions);
    } catch (err) {
      console.error("❌ fetch staff submissions error:", err);
      res.status(500).json({ error: "Failed to fetch submissions" });
    }
  }
);

app.get(
  "/api/staff/stats",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const staffId = req.user.id;

      const totalLinks = await prisma.staffLink.count({
        where: { staffId }
      });

      const activeLinks = await prisma.staffLink.count({
        where: {
          staffId,
          isActive: true
        }
      });

      const totalClients = await prisma.submission.count({
        where: { staffId }
      });

      res.json({
        totalLinks,
        activeLinks,
        expiredLinks: totalLinks - activeLinks,
        totalClients
      });

    } catch (err) {
      console.error("❌ staff stats error:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  }
);

// ——————————————————————————
// GET /api/staff/leaderboard
// Get all staff users ranked by active links count
app.get(
  "/api/staff/leaderboard",
  authenticate,
  requireRole(["ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      console.log("📊 Fetching staff leaderboard...");
      const staffUsers = await prisma.user.findMany({
        where: { role: "STAFF" },
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          employeeNumber: true,
          createdAt: true
        }
      });

      console.log(`✅ Found ${staffUsers.length} STAFF users`);

      // For each staff user, count their active links
      const staffWithLinks = await Promise.all(
        staffUsers.map(async (staff) => {
          const activeLinks = await prisma.staffLink.count({
            where: {
              staffId: staff.id,
              isActive: true
            }
          });

          const totalLinks = await prisma.staffLink.count({
            where: { staffId: staff.id }
          });

          const totalClients = await prisma.submission.count({
            where: { staffId: staff.id }
          });

          console.log(`  Staff: ${staff.name} - Active: ${activeLinks}, Total: ${totalLinks}, Clients: ${totalClients}`);

          return {
            ...staff,
            activeLinks,
            totalLinks,
            totalClients
          };
        })
      );

      // Sort by activeLinks descending
      const ranked = staffWithLinks.sort((a, b) => b.activeLinks - a.activeLinks);

      console.log(`📈 Returning ${ranked.length} ranked staff members`);
      res.json(ranked);
    } catch (err) {
      console.error("❌ staff leaderboard error:", err);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  }
);

app.delete(
  "/api/staff/link/:id",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid ID" });

      const link = await prisma.staffLink.findUnique({
        where: { id }
      });

      if (!link) return res.status(404).json({ error: "Link not found" });

      if (link.staffId !== req.user.id && req.user.role === "STAFF") {
        return res.status(403).json({ error: "Forbidden" });
      }

      if (link.usedCount > 0) {
        return res.status(400).json({
          error: "Cannot delete a used link"
        });
      }

      await prisma.staffLink.delete({
        where: { id }
      });

      res.json({ message: "Link deleted successfully" });

    } catch (err) {
      console.error("❌ delete link error:", err);
      res.status(500).json({ error: "Failed to delete link" });
    }
  }
);




/**
 * ✅ POST /bulk-upload
 * Receives an array of user records from Excel and saves them
 */
app.post('/bulk-upload', async (req, res) => {
  try {
    const { records } = req.body;
    if (!Array.isArray(records)) {
      return res.status(400).json({ error: 'Invalid data format' });
    }

    const saved = await prisma.$transaction(
      records.map(record =>
        prisma.submission.create({
          data: {
            employeeName: upperTrim(record.employeeName) || '',
            employeeNumber: upperTrim(record.employeeNumber) || '',
            phoneNumber: upperTrim(record.phoneNumber || record.phone),
            pdfPath: record.pdfPath || '',
            employerName: upperTrim(record.employerName) || '',
            branchName: upperTrim(record.branchName || record.branch),
            dues: upperTrim(record.dues) || '1%',
            witness: upperTrim(record.witness) || '',
            submittedAt: new Date()
          }
        })
      )
    );

    res.status(200).json({ message: 'Bulk upload successful', count: saved.length });
  } catch (err) {
    console.error('❌ Bulk upload error:', err);
    res.status(500).json({ error: 'Bulk upload failed' });
  }
});


// ---------- GET /api/admin/idcards  (all cards, admin only) ----------
app.get('/api/admin/idcards', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try {
    const cards = await prisma.idCard.findMany({
      orderBy: { issuedAt: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, employeeNumber: true, email: true }
        }
      }
    });
    const cardsWithTokens = await ensureIdCardVerificationTokens(cards);
    res.json(cardsWithTokens);
  } catch (err) {
    console.error('❌ GET /api/admin/idcards error:', err);
    res.status(500).json({ error: 'Failed to fetch ID cards' });
  }
});

async function updateIdCardRoleByAdmin(req, res) {
  try {
    const id = Number(req.params.id);
    const incomingRole = typeof req.body?.role === 'string' ? req.body.role.trim() : '';

    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid ID card id' });
    }

    if (!incomingRole) {
      return res.status(400).json({ error: 'Role is required' });
    }

    if (incomingRole.length > 50) {
      return res.status(400).json({ error: 'Role must be 50 characters or less' });
    }

    const existing = await prisma.idCard.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'ID card not found' });
    }

    const normalizedRole = incomingRole
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

    const updated = await prisma.idCard.update({
      where: { id },
      data: { role: normalizedRole },
      include: {
        user: {
          select: { id: true, name: true, employeeNumber: true, email: true }
        }
      }
    });

    return res.json({
      message: '✅ ID card role updated',
      card: updated,
    });
  } catch (err) {
    console.error('❌ PUT /api/admin/idcards role update error:', err);
    return res.status(500).json({ error: 'Failed to update ID card role', details: err.message });
  }
}

// ---------- PUT /api/admin/idcards/:id/role  (admin only) ----------
app.put('/api/admin/idcards/:id/role', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), updateIdCardRoleByAdmin);

// Backward-compatible endpoint in case frontend/server versions are mixed.
app.put('/api/admin/idcards/:id', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), updateIdCardRoleByAdmin);

// ---------- GET /api/idcards/:userId ----------
app.get('/api/idcards/:userId', authenticate, async (req, res) => {
  try {
    const uid = parseInt(req.params.userId);
    if (isNaN(uid)) return res.status(400).json({ error: 'Invalid userId' });

    if (req.user.role === 'CLIENT' && req.user.id !== uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let cards = await prisma.idCard.findMany({
      where: { userId: uid },
      orderBy: { issuedAt: 'desc' }
    });

    cards = await ensureIdCardVerificationTokens(cards);

    console.log(`🔍 fetched ${cards.length} cards for user ${uid} (PHOTO_MODE=${PHOTO_MODE})`);

    // if we're in cloudinary mode, migrate any old local URLs before returning
    if (PHOTO_MODE === 'cloudinary') {
      await Promise.all(cards.map(async (c, i) => {
        const updated = await ensureCloudinaryUrls(c);
        cards[i] = updated;
      }));
    }

    res.json(cards);
  } catch (err) {
    console.error('❌ GET /api/idcards/:userId error:', err);
    res.status(500).json({ error: 'Failed to fetch ID cards' });
  }
});

// ========================
// ✅ Cloudinary clean URL helper (TRANSPARENT PNG)
// ========================
function makeTransparentCleanUrl(publicIdOrUploadResult) {
  const publicId =
    typeof publicIdOrUploadResult === "string"
      ? publicIdOrUploadResult
      : publicIdOrUploadResult?.public_id;

  if (!publicId) return "";

  // ✅ Transparent PNG background removal
  // - NO background:"white"
  // - NO crop pad (pad often introduces matte/flat background)
  return cloudinary.url(publicId, {
    format: "png",
    transformation: [
      { effect: "background_removal" },
      // must be AFTER background_removal (Cloudinary note)
      { effect: "dropshadow", azimuth: 220, elevation: 40, spread: 20 },
      { crop: "scale", height: 110 },
      { fetch_format: "png" }, // keep transparency
      { quality: "auto" },
    ],
  });
}
app.post('/api/idcards', authenticate, uploadPhoto.single('photo'), async (req, res) => {
  try {
    const { userId, fullName, company, role, cardNumber } = req.body;

    if (!userId || !fullName || !company || !role || !cardNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create card first (without photo)
    let card = await prisma.idCard.create({
      data: {
        userId: parseInt(userId),
        fullName,
        company,
        role,
        cardNumber,
        verificationToken: generateIdCardVerificationToken(),
        isActive: true,
        rawPhotoUrl: '',
        cleanPhotoUrl: '',
      }
    });

    let rawPhotoUrl = '';
    let cleanPhotoUrl = '';

    if (req.file && req.file.buffer) {
      if (PHOTO_MODE === "cloudinary") {
        console.log("☁️ POST using Cloudinary AI mode");

        const uploadResult = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: cloudFolder(CLOUDINARY_FOLDERS.photos),
              resource_type: "image",
            },
            (error, result) => (error ? reject(error) : resolve(result))
          );
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });

        rawPhotoUrl = uploadResult.secure_url;
        cleanPhotoUrl = makeTransparentCleanUrl(uploadResult);
      } else {
        const rawFilename = `raw_${card.id}_${Date.now()}.png`;
        const rawDiskPath = path.join(PHOTOS_UPLOAD_DIR, rawFilename);

        await fs.promises.writeFile(rawDiskPath, req.file.buffer);
        rawPhotoUrl = buildUploadUrl(req, `photos/${rawFilename}`);

        // In VPS mode keep cleanPhotoUrl empty until cleaning is done
        cleanPhotoUrl = "";
      }
      // Update card with photo URLs
      card = await prisma.idCard.update({
        where: { id: card.id },
        data: { rawPhotoUrl, cleanPhotoUrl },
      });
    }

    res.status(201).json({
      message: `✅ ID card created using ${PHOTO_MODE} mode`,
      card
    });

  } catch (err) {
    console.error('❌ POST /api/idcards error:', err);
    res.status(500).json({ error: 'Failed to create ID card', details: err.message });
  }
});

/**
 * ✅ PUT /api/idcards/:id/photo
 * Upload a raw ID card photo and generate cleaned version.
 */
app.put('/api/idcards/:id/photo', authenticate, uploadPhoto.single('photo'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });

    if (req.user.role === 'CLIENT' && req.user.id !== card.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Clients may upload only once; staff/admin can update freely
    if (req.user.role === 'CLIENT' && card.rawPhotoUrl) {
      return res.status(403).json({ error: 'You have already uploaded your ID photo. Contact staff to update it.' });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    const clientCleaned = String(req.headers['x-photo-cleaned'] || '').trim() === '1';

    let rawPhotoUrl = '';
    let cleanPhotoUrl = '';

    if (PHOTO_MODE === "cloudinary") {
      console.log("☁️ Using Cloudinary AI mode");

      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: cloudFolder(CLOUDINARY_FOLDERS.photos),
            resource_type: "image",
          },
          (error, result) => (error ? reject(error) : resolve(result))
        );
        streamifier.createReadStream(req.file.buffer).pipe(stream);
      });

      rawPhotoUrl = uploadResult.secure_url;
      // If client already removed the background in browser, reuse uploaded PNG.
      cleanPhotoUrl = clientCleaned ? rawPhotoUrl : makeTransparentCleanUrl(uploadResult);
    } else {
      const rawFilename = `raw_${id}_${Date.now()}.png`;
      const rawDiskPath = path.join(PHOTOS_UPLOAD_DIR, rawFilename);

      await fs.promises.writeFile(rawDiskPath, req.file.buffer);
      rawPhotoUrl = buildUploadUrl(req, `photos/${rawFilename}`);
      cleanPhotoUrl = card.cleanPhotoUrl || "";
    }

    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: { rawPhotoUrl, cleanPhotoUrl },
    });

    // Sync ID card photo to user profile photo so avatar reflects it
    const displayPhoto = cleanPhotoUrl || rawPhotoUrl;
    if (displayPhoto) {
      await prisma.user.update({
        where: { id: card.userId },
        data: { profilePhotoUrl: displayPhoto },
      }).catch((e) => console.warn('⚠️ profilePhotoUrl sync skipped:', e.message));
    }

    res.json({
      message: `✅ Photo uploaded using ${PHOTO_MODE} mode`,
      card: updatedCard,
    });

  } catch (err) {
    console.error("❌ Photo upload failed:", err);
    res.status(500).json({ error: 'Failed to upload photo', details: err.message });
  }
});

app.put('/api/idcards/:id/clean-photo', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });
    if (!card.rawPhotoUrl) return res.status(400).json({ error: 'No raw photo to clean' });

    let cleanPhotoUrl = '';

    if (PHOTO_MODE === "cloudinary") {
      if (IS_VERCEL) {
        return res.status(400).json({
          error: 'Re-clean is disabled in browser-clean mode on Vercel. Upload a new photo to re-clean.',
        });
      }

      console.log("☁️ Re-clean using Cloudinary AI");

      const publicId = getCloudinaryPublicId(card.rawPhotoUrl);
      if (!publicId) {
        throw new Error(`Unable to parse public_id from url ${card.rawPhotoUrl}`);
      }

      // ✅ Transparent PNG background removal
      cleanPhotoUrl = makeTransparentCleanUrl(publicId);
    }

    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: { cleanPhotoUrl },
    });

    res.json({
      message: `✅ Photo re-cleaned using ${PHOTO_MODE}`,
      card: updatedCard
    });

  } catch (err) {
    console.error('❌ PUT /api/idcards/:id/clean-photo failed:', err);
    res.status(500).json({ error: 'Failed to re-clean photo', details: err.message });
  }
});

// ---------- DELETE /api/idcards/:id ----------
app.delete('/api/idcards/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });

    if (req.user.role === 'CLIENT' && req.user.id !== card.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.idCard.delete({ where: { id } });
    res.json({ message: '✅ ID card deleted' });
  } catch (err) {
    console.error('❌ DELETE /api/idcards/:id failed:', err);
    res.status(500).json({ error: 'Failed to delete ID card', details: err.message });
  }
});

// GET   /api/admin/users
// List all users (omit password)

app.get('/api/admin/users',
  authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          employeeNumber: true,
          role: true,
          firstLogin: true,
          createdAt: true
        },
        orderBy: { createdAt: 'desc' }
      })
      res.json(users)
    } catch (err) {
      console.error('❌ GET /api/admin/users error:', err)
      res.status(500).json({ error: 'Failed to fetch users' })
    }
  })

// ——————————————————————————
// POST  /api/admin/users
// Create a new user
app.post('/api/admin/users',
  authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
    const { name, username, email, password, role, employeeNumber } = req.body

    if (!name || !username || !password || !employeeNumber) {
      return res.status(400).json({
        error: 'name, username, password and employeeNumber are required'
      })
    }

    try {
      if (req.user.role === 'ADMIN' && role === 'SUPERADMIN') {
        return res.status(403).json({ error: 'Admin cannot create superadmin users' })
      }

      // ensure username & employeeNumber are unique
      const conflict = await prisma.user.findFirst({
        where: {
          OR: [
            { username },
            { employeeNumber }
          ]
        }
      })
      if (conflict) {
        return res
          .status(409)
          .json({ error: 'username or employeeNumber already in use' })
      }

      // hash the password
      const hash = await bcrypt.hash(password, 10)

      const user = await prisma.user.create({
        data: {
          name,
          username,
          email,
          password: hash,
          role: role || 'CLIENT',
          employeeNumber
        },
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          employeeNumber: true,
          role: true,
          firstLogin: true,
          createdAt: true
        }
      })

      // Send welcome credentials via all configured channels (best-effort)
      sendWelcomeCredentials({ user, username, password, phone: null }).catch((e) =>
        console.warn('⚠️ sendWelcomeCredentials (admin create user) failed:', e.message)
      );

      await recordUserManagementEvent('user_created', req, user, {
        createdRole: user.role,
      });

      res.status(201).json(user)
    } catch (err) {
      console.error('❌ POST /api/admin/users error:', err)
      res.status(500).json({ error: 'Failed to create user' })
    }
  })

// ——————————————————————————
// PUT   /api/admin/users/:id
// Update name, email, role or employeeNumber
app.put('/api/admin/users/:id',
  authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
    const { id } = req.params
    const { name, email, role, employeeNumber } = req.body

    try {
      const existing = await getManageableUserOrReject(req, res, Number(id))
      if (!existing) return

      if (req.user.role === 'ADMIN' && role === 'SUPERADMIN') {
        return res.status(403).json({ error: 'Admin cannot assign superadmin role' })
      }

      // if employeeNumber changed, check uniqueness
      if (employeeNumber && employeeNumber !== existing.employeeNumber) {
        const dup = await prisma.user.findUnique({
          where: { employeeNumber }
        })
        if (dup) {
          return res
            .status(409)
            .json({ error: 'employeeNumber already in use' })
        }
      }

      const updated = await prisma.user.update({
        where: { id: Number(id) },
        data: {
          name: name ?? existing.name,
          email: email ?? existing.email,
          role: role ?? existing.role,
          employeeNumber: employeeNumber ?? existing.employeeNumber
        },
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          employeeNumber: true,
          role: true,
          firstLogin: true,
          createdAt: true
        }
      })

      await recordUserManagementEvent('user_updated', req, updated, {
        previousRole: existing.role,
        previousEmployeeNumber: existing.employeeNumber,
      });

      res.json(updated)
    } catch (err) {
      console.error(`❌ PUT /api/admin/users/${id} error:`, err)
      res.status(500).json({ error: 'Failed to update user' })
    }
  })

// POST  /api/admin/users/:id/reset-first-login-otp
// Force first-login flow and send OTP via selected channel.
app.post('/api/admin/users/:id/reset-first-login-otp',
  authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id || Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      const channel = String(req.body?.channel || OTP_CHANNEL.EMAIL).trim().toUpperCase();
      if (!Object.values(OTP_CHANNEL).includes(channel)) {
        return res.status(400).json({ error: 'Unsupported OTP channel' });
      }

      const user = await getManageableUserOrReject(req, res, id);
      if (!user) return;

      let target = '';
      if (channel === OTP_CHANNEL.EMAIL) {
        if (!user.email) {
          return res.status(400).json({ error: 'This user has no email configured' });
        }
        target = user.email;
      } else {
        target = await resolveWhatsappPhoneForUser(user);
        if (!target) {
          return res.status(400).json({ error: 'No WhatsApp phone found for this user' });
        }
      }

      const otpCode = generateOtpCode();

      await prisma.user.update({
        where: { id: user.id },
        data: { firstLogin: true },
      });

      const expiresAt = await persistOtpForUser({
        userId: user.id,
        purpose: OTP_PURPOSE.FIRST_LOGIN,
        channel,
        target,
        otpCode,
      });

      const delivery = await sendOtpMessage({
        user,
        channel,
        purpose: OTP_PURPOSE.FIRST_LOGIN,
        otpCode,
        target,
      });

      const payload = {
        message: 'First-login OTP sent successfully',
        user: {
          id: user.id,
          employeeNumber: user.employeeNumber,
          name: user.name,
          firstLogin: true,
        },
        channel,
        target: channel === OTP_CHANNEL.EMAIL ? maskEmail(target) : maskPhone(target),
        expiresAt,
      };

      if (shouldExposeOtpCode(delivery?.deliveryMode)) payload.devOtp = otpCode;

      await recordUserManagementEvent('user_first_login_otp_reset', req, user, {
        channel,
      });

      return res.json(payload);
    } catch (err) {
      console.error('❌ POST /api/admin/users/:id/reset-first-login-otp error:', err);
      return res.status(500).json({ error: 'Failed to reset first-login OTP', details: err.message });
    }
  });
// ——————————————————————————
// POST /api/admin/users/:id/reset-password
// Admin directly sets a temporary password; user is forced to change on next login.
app.post('/api/admin/users/:id/reset-password',
  authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid user ID' });

    const { newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    try {
      const hash = await bcrypt.hash(String(newPassword), 10);
      const user = await getManageableUserOrReject(req, res, id);
      if (!user) return;

      await prisma.user.update({
        where: { id },
        data: {
          password: hash,
          firstLogin: true,
          otpCodeHash: null,
          otpPurpose: null,
          otpChannel: null,
          otpTarget: null,
          otpExpiresAt: null,
          otpAttempts: 0,
          otpVerifiedAt: null,
        },
      });

      // Send new credentials via all configured channels (best-effort)
      const latestSub = await prisma.submission.findFirst({
        where: { employeeNumber: user.employeeNumber },
        orderBy: { submittedAt: 'desc' },
        select: { phoneNumber: true },
      });
      sendWelcomeCredentials({
        user,
        username: user.username,
        password: newPassword,
        phone: latestSub?.phoneNumber || '',
      }).catch((e) => console.warn('⚠️ sendWelcomeCredentials (reset-password) failed:', e.message));

      await recordUserManagementEvent('user_password_reset', req, user);

      return res.json({ message: 'Password reset successfully. Credentials sent to user.' });
    } catch (err) {
      console.error(`❌ POST /api/admin/users/${id}/reset-password error:`, err);
      return res.status(500).json({ error: 'Failed to reset password', details: err.message });
    }
  });

// ——————————————————————————
// DELETE /api/admin/users/:id
// Soft delete a user by ID and track in submissions
app.delete('/api/admin/users/:id',
  authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid user ID' });

    try {
      const basicTarget = await getManageableUserOrReject(req, res, id)
      if (!basicTarget) return

      const existing = await prisma.user.findUnique({
        where: { id },
        include: {
          idCards: true,
          submissions: true
        }
      });

      const deletionTime = new Date();

      // Soft delete user
      await prisma.user.update({
        where: { id },
        data: { deletedAt: deletionTime }
      });

      // Mark user deletion time on all their submissions
      await prisma.submission.updateMany({
        where: { userId: id, userDeletedAt: null },
        data: { userDeletedAt: deletionTime }
      });

      console.log(`✅ User ${id} soft-deleted. Marked ${existing.submissions.length} submissions with userDeletedAt.`);

      await recordUserManagementEvent('user_soft_deleted', req, existing, {
        submissionsMarked: existing.submissions.length,
        idCardsRetained: existing.idCards.length,
      });

      res.json({ 
        message: 'User soft-deleted successfully', 
        id,
        submissionsMarked: existing.submissions.length,
        idCardsRetained: existing.idCards.length
      });
    } catch (err) {
      console.error(`❌ DELETE /api/admin/users/${id} error:`, err);
      res.status(500).json({ error: 'Failed to delete user', details: err.message });
    }
  });


// ——————————————————————————
// Submissions endpoints (used by frontend at '/submissions')
// GET /submissions -> ADMIN: all submissions; CLIENT: their own submissions
app.get('/submissions', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'CLIENT') {
      const subs = await prisma.submission.findMany({
        where: {
          employeeNumber: req.user.employeeNumber,
          deletedAt: null
        },
        orderBy: { submittedAt: 'desc' }
      })
      return res.json(subs)
    }

    // ADMIN / SUPERADMIN -> all
    const subs = await prisma.submission.findMany({
      where: { deletedAt: null },
      orderBy: { submittedAt: 'desc' }
    })
    res.json(subs)
  } catch (err) {
    console.error('❌ GET /submissions error:', err)
    res.status(500).json({ error: 'Failed to fetch submissions' })
  }
})

app.get(
  "/api/admin/submissions/search",
  authenticate,
  requireRole(["ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const {
        employerName,
        branchName,
        employeeName,
        employeeNumber,
        phoneNumber,
      } = req.query;

      const where = {};
      where.deletedAt = null;

      if (employerName) {
        where.employerName = {
          contains: String(employerName).trim(),
          mode: "insensitive",
        };
      }

      if (branchName) {
        where.branchName = {
          contains: String(branchName).trim(),
          mode: "insensitive",
        };
      }

      if (employeeName) {
        where.employeeName = {
          contains: String(employeeName).trim(),
          mode: "insensitive",
        };
      }

      if (employeeNumber) {
        where.employeeNumber = {
          contains: String(employeeNumber).trim(),
          mode: "insensitive",
        };
      }

      if (phoneNumber) {
        where.phoneNumber = {
          contains: String(phoneNumber).trim(),
          mode: "insensitive",
        };
      }

      const rows = await prisma.submission.findMany({
        where,
        orderBy: { submittedAt: "desc" },
      });

      res.json(rows);
    } catch (err) {
      console.error("❌ admin submission search error:", err);
      res.status(500).json({
        error: "Failed to search submissions",
        details: err.message,
      });
    }
  }
);

// PUT /submissions/:id -> update submission (admin only)
app.put('/submissions/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id)
  if (!['ADMIN', 'SUPERADMIN'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const normalized = normalizeSubmissionPayload(req.body);
  const { employeeName, employeeNumber, employerName, branchName, phoneNumber, dues, witness } = normalized;
    try {
    const updated = await prisma.submission.update({
      where: { id },
      data: {
        employeeName: employeeName ?? undefined,
        employeeNumber: employeeNumber ?? undefined,
        employerName: employerName ?? undefined,
        branchName: branchName ?? undefined,
        phoneNumber: phoneNumber ?? undefined,
        dues: dues ?? undefined,
        witness: witness ?? undefined
      }
    })
    res.json(updated)
  } catch (err) {
    console.error(`❌ PUT /submissions/${id} error:`, err)
    res.status(500).json({ error: 'Failed to update submission' })
  }
})

// DELETE /submissions/:id -> delete submission (admin only)
app.delete('/submissions/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id)
  if (!['ADMIN', 'SUPERADMIN'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    const existing = await prisma.submission.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            deletedAt: true
          }
        }
      }
    })

    if (!existing) {
      return res.status(404).json({ error: 'Submission not found' })
    }

    if (existing.deletedAt) {
      return res.status(409).json({ error: 'Submission is already deleted' })
    }

    // Safety rule: submission deletion is allowed only after linked user is safely deleted.
    if (existing.userId && existing.user && !existing.user.deletedAt) {
      return res.status(409).json({
        error: 'Cannot delete submission while user account is active. Delete the user first from Admin Users for safe tracking.'
      })
    }

    const deletedAt = new Date()
    await prisma.submission.update({
      where: { id },
      data: {
        deletedAt,
        userDeletedAt: existing.user?.deletedAt || existing.userDeletedAt || null
      }
    })

    res.json({
      message: 'Submission soft-deleted successfully',
      id,
      deletedAt: deletedAt.toISOString()
    })
  } catch (err) {
    console.error(`❌ DELETE /submissions/${id} error:`, err)
    res.status(500).json({ error: 'Failed to delete submission' })
  }
})

// GET /submissions/archived/list -> fetch deleted/archived submissions (admin only)
app.get('/submissions/archived/list', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try {
    const archived = await prisma.submission.findMany({
      where: { deletedAt: { not: null } },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            deletedAt: true
          }
        }
      },
      orderBy: { deletedAt: 'desc' }
    })

    res.json(archived)
  } catch (err) {
    console.error('❌ GET /submissions/archived/list error:', err)
    res.status(500).json({ error: 'Failed to fetch archived submissions', details: err.message })
  }
})

// PATCH /submissions/:id/restore -> restore soft-deleted submission
app.patch('/submissions/:id/restore', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid submission ID' })

  try {
    const existing = await prisma.submission.findUnique({ where: { id } })

    if (!existing) return res.status(404).json({ error: 'Submission not found' })
    if (!existing.deletedAt) return res.status(409).json({ error: 'Submission is not archived' })

    await prisma.submission.update({
      where: { id },
      data: { deletedAt: null }
    })

    res.json({ message: 'Submission restored successfully', id })
  } catch (err) {
    console.error(`❌ PATCH /submissions/${id}/restore error:`, err)
    res.status(500).json({ error: 'Failed to restore submission', details: err.message })
  }
})

// DELETE /submissions/:id/permanent -> permanently delete archived submission (admin only)
app.delete('/submissions/:id/permanent', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid submission ID' })

  try {
    const existing = await prisma.submission.findUnique({ where: { id } })

    if (!existing) return res.status(404).json({ error: 'Submission not found' })
    if (!existing.deletedAt) return res.status(409).json({ error: 'Only archived submissions can be permanently deleted' })

    await prisma.submission.delete({ where: { id } })

    res.json({ message: 'Submission permanently deleted', id })
  } catch (err) {
    console.error(`❌ DELETE /submissions/${id}/permanent error:`, err)
    res.status(500).json({ error: 'Failed to permanently delete submission', details: err.message })
  }
})

// GET /api/admin/users/archived/list -> fetch soft-deleted users (admin only)
app.get('/api/admin/users/archived/list', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try {
    const archived = await prisma.user.findMany({
      where: { deletedAt: { not: null } },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        employeeNumber: true,
        role: true,
        deletedAt: true,
        submissions: { select: { id: true } }
      },
      orderBy: { deletedAt: 'desc' }
    })

    res.json(archived.map(u => ({
      ...u,
      submissionsCount: u.submissions.length,
      submissions: undefined
    })))
  } catch (err) {
    console.error('❌ GET /api/admin/users/archived/list error:', err)
    res.status(500).json({ error: 'Failed to fetch archived users', details: err.message })
  }
})

// PATCH /api/admin/users/:id/restore -> restore soft-deleted user
app.patch('/api/admin/users/:id/restore', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid user ID' })

  try {
    const existing = await getManageableUserOrReject(req, res, id)
    if (!existing) return
    if (!existing.deletedAt) return res.status(409).json({ error: 'User is not archived' })

    await prisma.user.update({
      where: { id },
      data: { deletedAt: null }
    })

    await recordUserManagementEvent('user_restored', req, existing)

    res.json({ message: 'User restored successfully', id })
  } catch (err) {
    console.error(`❌ PATCH /api/admin/users/${id}/restore error:`, err)
    res.status(500).json({ error: 'Failed to restore user', details: err.message })
  }
})

// DELETE /api/admin/users/:id/permanent -> permanently delete archived user (admin only)
app.delete('/api/admin/users/:id/permanent', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid user ID' })

  try {
    const existing = await getManageableUserOrReject(req, res, id)
    if (!existing) return
    if (!existing.deletedAt) return res.status(409).json({ error: 'Only archived users can be permanently deleted' })

    await recordUserManagementEvent('user_permanently_deleted', req, existing)

    await prisma.user.delete({ where: { id } })

    res.json({ message: 'User permanently deleted', id })
  } catch (err) {
    console.error(`❌ DELETE /api/admin/users/${id}/permanent error:`, err)
    res.status(500).json({ error: 'Failed to permanently delete user', details: err.message })
  }
})

// POST /api/admin/users/bulk -> bulk operations on multiple users
app.post('/api/admin/users/bulk', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const { action, userIds } = req.body;

  if (!action || !Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'action and userIds[] are required' });
  }

  const validActions = ['delete', 'restore', 'permanent_delete'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: 'Invalid action. Use: delete, restore, or permanent_delete' });
  }

  const ids = userIds.map(Number).filter((n) => !isNaN(n));
  if (ids.length === 0) return res.status(400).json({ error: 'No valid user IDs provided' });

  const results = { success: [], failed: [] };

  for (const id of ids) {
    try {
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target) { results.failed.push({ id, reason: 'Not found' }); continue; }
      if (!canManageTargetUser(req.user, target)) { results.failed.push({ id, reason: 'Permission denied' }); continue; }

      if (action === 'delete') {
        if (target.deletedAt) { results.failed.push({ id, reason: 'Already archived' }); continue; }
        await prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
        await recordUserManagementEvent('user_soft_deleted', req, target, { bulk: true });
        results.success.push(id);
      } else if (action === 'restore') {
        if (!target.deletedAt) { results.failed.push({ id, reason: 'Not archived' }); continue; }
        await prisma.user.update({ where: { id }, data: { deletedAt: null } });
        await recordUserManagementEvent('user_restored', req, target, { bulk: true });
        results.success.push(id);
      } else if (action === 'permanent_delete') {
        if (!target.deletedAt) { results.failed.push({ id, reason: 'Must be archived first' }); continue; }
        await recordUserManagementEvent('user_permanently_deleted', req, target, { bulk: true });
        await prisma.user.delete({ where: { id } });
        results.success.push(id);
      }
    } catch (e) {
      results.failed.push({ id, reason: e.message });
    }
  }

  res.json({ results, message: `${results.success.length} succeeded, ${results.failed.length} failed` });
})

// (photos directory is now served above; cleaned images saved locally)

/**
 * POST /api/idcards/:id/fetch-and-clean
 * Fetch raw image server-side, use optimized Python rembg for cleaning,
 * upload cleaned PNG to Cloudinary and update idCard.cleanPhotoUrl.
 */
app.post('/api/idcards/:id/fetch-and-clean', authenticate, async (req, res) => {
  try {
    const isVercel = !!process.env.VERCEL;
    const id = Number(req.params.id);

    if (!id) return res.status(400).json({ error: 'Invalid ID' });
    if (!req.body || !req.body.rawPhotoUrl)
      return res.status(400).json({ error: 'Missing rawPhotoUrl' });

    const { rawPhotoUrl } = req.body;

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });

    if (req.user.role === 'CLIENT' && req.user.id !== card.userId)
      return res.status(403).json({ error: 'Forbidden' });

    console.log(`[ENV: ${isVercel ? "VERCEL" : "VPS"}] Fetching image...`);

    // 1️⃣ Download image
    const response = await axios.get(rawPhotoUrl, {
      responseType: 'arraybuffer',
      timeout: 20000
    });

    const originalBuffer = Buffer.from(response.data);

    let finalBuffer = originalBuffer;

    // 2️⃣ If NOT Vercel → use Python
    if (!isVercel) {
      try {
        console.log("Running Python background removal...");
        finalBuffer = await removeBackgroundBuffer(originalBuffer);
        console.log("✅ Python success");
      } catch (err) {
        console.warn("⚠️ Python failed, using original image");
      }
    }

    let cleanUrl;

    // ==========================
    // 🚀 VPS MODE
    // ==========================
    if (!isVercel) {
      const filename = `idcard_clean_${id}_${Date.now()}.png`;
      const filePath = path.join(IDCARDS_UPLOAD_DIR, filename);

      await fs.promises.writeFile(filePath, finalBuffer);
      cleanUrl = buildUploadUrl(req, `idcards/${filename}`);
    }

    // ==========================
    // ☁️ VERCEL MODE
    // ==========================
    if (isVercel) {

      const uploadResult = await cloudinary.uploader.upload_stream(
        { folder: cloudFolder(CLOUDINARY_FOLDERS.idcards) + '_cleaned' },
        async (error, result) => {
          if (error) throw error;
          cleanUrl = result.secure_url;

          const updatedCard = await prisma.idCard.update({
            where: { id },
            data: {
              cleanPhotoUrl: cleanUrl,
              rawPhotoUrl
            }
          });

          return res.json({
            message: "✅ Image processed (Cloudinary)",
            card: updatedCard
          });
        }
      );

      uploadResult.end(finalBuffer);
      return; // prevent double response
    }

    // ==========================
    // Update DB (VPS)
    // ==========================
    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: {
        cleanPhotoUrl: cleanUrl,
        rawPhotoUrl
      }
    });

    return res.json({
      message: "✅ Image processed (VPS)",
      card: updatedCard
    });

  } catch (err) {
    console.error("❌ fetch-and-clean failed:", err);
    return res.status(500).json({
      error: "Failed to fetch or clean image",
      details: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VOTING SYSTEM — Blockchain-secured staff voting
// ─────────────────────────────────────────────────────────────────────────────

const VOTE_SECRET = process.env.VOTE_SECRET || 'fibuca-vote-secret-2026';
const voteSha256 = (str) => require('crypto').createHash('sha256').update(str).digest('hex');
const voteVoterHash = (userId, sessionId) => voteSha256(`${userId}:${sessionId}:${VOTE_SECRET}`);
const normalizeVotingCandidates = (sessionLike) => {
  const rawCandidates = Array.isArray(sessionLike?.candidates) ? sessionLike.candidates : [];
  const fallbackTitle = sessionLike?.position || 'General';
  return rawCandidates.map((candidate, index) => ({
    ...candidate,
    id: candidate.id || `candidate-${index + 1}`,
    positionKey: candidate.positionKey || 'default',
    positionTitle: candidate.positionTitle || fallbackTitle,
  }));
};

const buildVotingGroups = (sessionLike, votes = []) => {
  const candidates = normalizeVotingCandidates(sessionLike);
  const groups = new Map();

  for (const candidate of candidates) {
    const key = candidate.positionKey;
    if (!groups.has(key)) {
      groups.set(key, {
        positionKey: key,
        positionTitle: candidate.positionTitle,
        items: [],
      });
    }
    groups.get(key).items.push({ candidate, count: 0 });
  }

  for (const vote of votes) {
    const key = vote.positionKey || 'default';
    const group = groups.get(key);
    if (!group) continue;
    const item = group.items.find((entry) => entry.candidate.id === vote.candidateId);
    if (item) item.count += 1;
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    items: group.items.sort((a, b) => b.count - a.count),
  }));
};

// ── Admin: Create a voting session ──────────────────────────────────────────
app.post('/api/admin/voting/sessions', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const { title, position, description, candidates } = req.body;
  if (!title || !Array.isArray(candidates) || candidates.length < 2) {
    return res.status(400).json({ error: 'title and at least 2 candidates required' });
  }

  const normalizedCandidates = candidates.map((candidate, index) => ({
    id: candidate.id || `candidate-${index + 1}`,
    name: candidate.name,
    description: candidate.description || null,
    positionKey: candidate.positionKey || 'default',
    positionTitle: candidate.positionTitle || position || 'General',
  }));

  for (const c of candidates) {
    if (!c.id || !c.name) return res.status(400).json({ error: 'Each candidate needs id and name' });
  }
  const distinctPositions = new Set(normalizedCandidates.map((candidate) => candidate.positionKey));
  if (distinctPositions.size < 1) {
    return res.status(400).json({ error: 'At least one position is required' });
  }

  const countsByPosition = new Map();
  for (const candidate of normalizedCandidates) {
    countsByPosition.set(candidate.positionKey, (countsByPosition.get(candidate.positionKey) || 0) + 1);
  }
  for (const [positionKey, count] of countsByPosition.entries()) {
    if (count < 2) {
      return res.status(400).json({ error: `Position ${positionKey} must have at least 2 candidates` });
    }
  }

  const genesisHash = voteSha256(JSON.stringify({ title, position, candidates: normalizedCandidates, createdBy: req.user.id, ts: Date.now() }));
  const session = await prisma.votingSession.create({
    data: { title, position: position || null, description: description || null, candidates: normalizedCandidates, status: 'PENDING', genesisHash, createdById: req.user.id },
    include: { createdBy: { select: { id: true, name: true, role: true } } },
  });
  res.json({ session });
});

// ── Admin: List all sessions ─────────────────────────────────────────────────
app.get('/api/admin/voting/sessions', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const sessions = await prisma.votingSession.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
      _count: { select: { votes: true } },
    },
  });
  res.json({ sessions });
});

// ── Admin: Start a session (PENDING → ACTIVE) ────────────────────────────────
app.post('/api/admin/voting/sessions/:id/start', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const id = parseInt(req.params.id);
  const session = await prisma.votingSession.findUnique({ where: { id } });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'PENDING') return res.status(400).json({ error: `Session is already ${session.status}` });
  const updated = await prisma.votingSession.update({
    where: { id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
  res.json({ session: updated });
});

// ── Admin: End a session (ACTIVE → ENDED) ────────────────────────────────────
app.post('/api/admin/voting/sessions/:id/end', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const id = parseInt(req.params.id);
  const session = await prisma.votingSession.findUnique({ where: { id } });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'ACTIVE') return res.status(400).json({ error: `Session is not ACTIVE (current: ${session.status})` });
  const updated = await prisma.votingSession.update({
    where: { id },
    data: { status: 'ENDED', endedAt: new Date() },
  });
  res.json({ session: updated });
});

// ── Admin: Session results + chain verification ──────────────────────────────
app.get('/api/admin/voting/sessions/:id/results', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const id = parseInt(req.params.id);
  const session = await prisma.votingSession.findUnique({
    where: { id },
    include: {
      votes: { orderBy: { blockIndex: 'asc' } },
      createdBy: { select: { id: true, name: true, role: true } },
    },
  });
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Verify chain integrity
  let chainValid = true;
  let prevHash = session.genesisHash;
  for (const vote of session.votes) {
    const expectedHash = voteSha256(`${prevHash}|${vote.voterHash}|${vote.positionKey || 'default'}|${vote.candidateId}|${vote.createdAt.toISOString()}`);
    if (expectedHash !== vote.blockHash || vote.prevHash !== prevHash) {
      chainValid = false;
      break;
    }
    prevHash = vote.blockHash;
  }

  const tallyByPosition = buildVotingGroups(session, session.votes);

  res.json({
    session: { ...session, votes: undefined },
    totalVotes: session.votes.length,
    chainValid,
    tallyByPosition,
    blocks: session.votes.map((v) => ({
      blockIndex: v.blockIndex,
      blockHash: v.blockHash,
      prevHash: v.prevHash,
      positionKey: v.positionKey,
      candidateId: v.candidateId,
      createdAt: v.createdAt,
    })),
  });
});

// ── Staff: List accessible sessions ─────────────────────────────────────────
app.get('/api/voting/sessions', authenticate, async (req, res) => {
  const sessions = await prisma.votingSession.findMany({
    where: { status: { in: ['ACTIVE', 'ENDED'] } },
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: { select: { id: true, name: true } },
      _count: { select: { votes: true } },
    },
  });

  const myVotes = sessions.length > 0
    ? await prisma.voteRecord.findMany({
        where: { OR: sessions.map((s) => ({ sessionId: s.id, voterHash: voteVoterHash(req.user.id, s.id) })) },
        select: { sessionId: true, positionKey: true },
      })
    : [];
  const votedMap = new Map();
  for (const vote of myVotes) {
    if (!votedMap.has(vote.sessionId)) votedMap.set(vote.sessionId, []);
    votedMap.get(vote.sessionId).push(vote.positionKey || 'default');
  }

  res.json({ sessions: sessions.map((s) => ({ ...s, votedPositionKeys: votedMap.get(s.id) || [], hasVoted: (votedMap.get(s.id) || []).length > 0 })) });
});

// ── Staff: Get single session detail ─────────────────────────────────────────
app.get('/api/voting/sessions/:id', authenticate, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = await prisma.votingSession.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } }, _count: { select: { votes: true } } },
  });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status === 'PENDING') return res.status(403).json({ error: 'Session not started yet' });

  const vh = voteVoterHash(req.user.id, id);
  const myVotes = await prisma.voteRecord.findMany({
    where: { sessionId: id, voterHash: vh },
    orderBy: { createdAt: 'asc' },
  });

  let tallyByPosition = null;
  if (session.status === 'ACTIVE' || session.status === 'ENDED') {
    const votes = await prisma.voteRecord.findMany({ where: { sessionId: id } });
    tallyByPosition = buildVotingGroups(session, votes);
  }

  const votedPositionKeys = myVotes.map((vote) => vote.positionKey || 'default');
  const receiptHashesByPosition = myVotes.reduce((acc, vote) => {
    acc[vote.positionKey || 'default'] = vote.blockHash;
    return acc;
  }, {});
  const votedCandidateIdsByPosition = myVotes.reduce((acc, vote) => {
    acc[vote.positionKey || 'default'] = vote.candidateId;
    return acc;
  }, {});

  res.json({
    session,
    hasVoted: myVotes.length > 0,
    votedPositionKeys,
    votedCandidateIdsByPosition,
    receiptHashesByPosition,
    tallyByPosition,
  });
});

// ── Staff: Cast a vote ────────────────────────────────────────────────────────
app.post('/api/voting/sessions/:id/vote', authenticate, requireRole(['STAFF']), async (req, res) => {
  const id = parseInt(req.params.id);
  const { candidateId } = req.body;
  if (!candidateId) return res.status(400).json({ error: 'candidateId required' });

  const session = await prisma.votingSession.findUnique({
    where: { id },
    include: { votes: { orderBy: { blockIndex: 'desc' }, take: 1 } },
  });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'ACTIVE') return res.status(400).json({ error: 'Voting is not open for this session' });

  const candidates = normalizeVotingCandidates(session);
  const selectedCandidate = candidates.find((c) => c.id === candidateId);
  if (!selectedCandidate) return res.status(400).json({ error: 'Invalid candidateId' });

  const vh = voteVoterHash(req.user.id, id);
  const prevHash = session.votes.length > 0 ? session.votes[0].blockHash : session.genesisHash;
  const blockIndex = session.votes.length > 0 ? session.votes[0].blockIndex + 1 : 0;
  const now = new Date();
  const blockHash = voteSha256(`${prevHash}|${vh}|${selectedCandidate.positionKey}|${candidateId}|${now.toISOString()}`);

  try {
    const vote = await prisma.voteRecord.create({
      data: {
        sessionId: id,
        voterHash: vh,
        positionKey: selectedCandidate.positionKey,
        candidateId,
        blockIndex,
        prevHash,
        blockHash,
        createdAt: now,
      },
    });
    res.json({ success: true, blockHash: vote.blockHash, blockIndex: vote.blockIndex, positionKey: selectedCandidate.positionKey });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'You have already voted for this position' });
    throw err;
  }
});

// ── Admin: Delete a PENDING/ENDED session ───────────────────────────────────
app.delete('/api/admin/voting/sessions/:id', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  const id = parseInt(req.params.id);
  const session = await prisma.votingSession.findUnique({ where: { id } });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!['PENDING', 'ENDED'].includes(session.status)) {
    return res.status(400).json({ error: 'Can only delete PENDING or ENDED sessions' });
  }
  await prisma.votingSession.delete({ where: { id } });
  res.json({ success: true });
});

// ── Staff/Admin Contributions (Michango) ────────────────────────────────────
app.get('/api/staff/contributions', authenticate, requireRole(['STAFF']), async (req, res) => {
  try {
    const contributions = await prisma.contribution.findMany({
      where: { isActive: true },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      include: {
        payments: {
          where: { userId: req.user.id },
          take: 1,
        },
      },
    });

    const rows = contributions.map((item) => {
      const payment = item.payments?.[0] || null;
      return {
        id: item.id,
        title: item.title,
        description: item.description,
        amount: item.amount,
        dueDate: item.dueDate,
        status: payment?.status || 'UNPAID',
        paidAt: payment?.paidAt || null,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/staff/contributions failed:', err);
    res.status(500).json({ error: 'Failed to fetch contributions' });
  }
});

app.get('/api/admin/contributions', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try {
    const [staffCount, contributions] = await Promise.all([
      prisma.user.count({ where: { role: 'STAFF', deletedAt: null } }),
      prisma.contribution.findMany({
        orderBy: [{ createdAt: 'desc' }],
        include: {
          payments: {
            where: { status: 'PAID' },
            select: { id: true },
          },
          createdBy: {
            select: { id: true, name: true, role: true },
          },
        },
      }),
    ]);

    const rows = contributions.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      amount: item.amount,
      dueDate: item.dueDate,
      isActive: item.isActive,
      createdAt: item.createdAt,
      createdBy: item.createdBy,
      staffCount,
      paidCount: item.payments?.length || 0,
    }));

    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/admin/contributions failed:', err);
    res.status(500).json({ error: 'Failed to fetch contributions' });
  }
});

app.post('/api/admin/contributions', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim() || null;
    const amount = Number(req.body?.amount);
    const dueDateRaw = req.body?.dueDate ? String(req.body.dueDate) : '';
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;

    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Amount must be a valid non-negative number' });
    }
    if (dueDateRaw && Number.isNaN(dueDate.getTime())) {
      return res.status(400).json({ error: 'Invalid due date' });
    }

    const created = await prisma.contribution.create({
      data: {
        title,
        description,
        amount,
        dueDate,
        createdById: req.user.id,
      },
    });

    res.status(201).json(created);
  } catch (err) {
    console.error('❌ POST /api/admin/contributions failed:', err);
    res.status(500).json({ error: 'Failed to create contribution' });
  }
});

app.delete('/api/admin/contributions/:id', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid contribution id' });

    const existing = await prisma.contribution.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Contribution not found' });

    await prisma.contribution.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ DELETE /api/admin/contributions/:id failed:', err);
    res.status(500).json({ error: 'Failed to delete contribution' });
  }
});

app.get('/api/admin/contributions/:id/contributors', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid contribution id' });

    const contribution = await prisma.contribution.findUnique({ where: { id } });
    if (!contribution) return res.status(404).json({ error: 'Contribution not found' });

    const [staffUsers, payments] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'STAFF', deletedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, username: true, employeeNumber: true },
      }),
      prisma.contributionPayment.findMany({
        where: { contributionId: id },
        select: { userId: true, status: true, paidAt: true, notes: true, recordedById: true },
      }),
    ]);

    const paymentByUserId = new Map(payments.map((p) => [p.userId, p]));

    const contributors = staffUsers.map((u) => {
      const p = paymentByUserId.get(u.id);
      return {
        userId: u.id,
        name: u.name,
        username: u.username,
        employeeNumber: u.employeeNumber,
        status: p?.status || 'UNPAID',
        paidAt: p?.paidAt || null,
        notes: p?.notes || null,
        recordedById: p?.recordedById || null,
      };
    });

    res.json({ contribution, contributors });
  } catch (err) {
    console.error('❌ GET /api/admin/contributions/:id/contributors failed:', err);
    res.status(500).json({ error: 'Failed to fetch contributors' });
  }
});

app.put('/api/admin/contributions/:id/contributors/:userId', authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try {
    const contributionId = parseInt(req.params.id, 10);
    const userId = parseInt(req.params.userId, 10);
    if (Number.isNaN(contributionId) || Number.isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid contribution/user id' });
    }

    const status = String(req.body?.status || '').toUpperCase();
    if (!['PAID', 'UNPAID'].includes(status)) {
      return res.status(400).json({ error: 'Status must be PAID or UNPAID' });
    }

    const [contribution, targetUser] = await Promise.all([
      prisma.contribution.findUnique({ where: { id: contributionId } }),
      prisma.user.findUnique({ where: { id: userId } }),
    ]);

    if (!contribution) return res.status(404).json({ error: 'Contribution not found' });
    if (!targetUser || targetUser.role !== 'STAFF' || targetUser.deletedAt) {
      return res.status(404).json({ error: 'Staff user not found' });
    }

    const paidAt = status === 'PAID'
      ? (req.body?.paidAt ? new Date(req.body.paidAt) : new Date())
      : null;
    if (status === 'PAID' && Number.isNaN(paidAt.getTime())) {
      return res.status(400).json({ error: 'Invalid paidAt date' });
    }

    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : null;

    const payment = await prisma.contributionPayment.upsert({
      where: {
        contributionId_userId: {
          contributionId,
          userId,
        },
      },
      create: {
        contributionId,
        userId,
        status,
        paidAt,
        notes,
        recordedById: req.user.id,
      },
      update: {
        status,
        paidAt,
        notes,
        recordedById: req.user.id,
      },
    });

    res.json(payment);
  } catch (err) {
    console.error('❌ PUT /api/admin/contributions/:id/contributors/:userId failed:', err);
    res.status(500).json({ error: 'Failed to update contribution payment status' });
  }
});

// global error handler (must come after all route definitions)
app.use((err, req, res, next) => {
  // multer file size limit error
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    console.warn('⚠️ upload rejected - file too large:', err.message);
    return res.status(413).json({
      error: 'File too large',
      maxBytes: MAX_PHOTO_BYTES,
    });
  }

  // explicit CORS rejection is generated above; convert to 403 for clarity
  if (err.message && err.message.includes('Not allowed by CORS')) {
    return res.status(403).json({ error: 'CORS origin not permitted' });
  }

  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Server error', details: err.message });
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ FIBUCA backend running at http://localhost:${PORT}`);
});
