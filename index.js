// backend/index.js
const express = require('express')
const nodemailer = require('nodemailer')
const cors = require('cors')
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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Photo-Cleaned');
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
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Photo-Cleaned"],
  })
);

// parse upload size limit from environment or default to 3MB
const MAX_PHOTO_BYTES = parseInt(process.env.UPLOAD_SIZE_LIMIT || String(50 * 1024 * 1024), 10);

console.log('🛡️ CORS allowed origins:', allowedOrigins);
console.log('📦 upload size limit bytes:', MAX_PHOTO_BYTES);
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

[UPLOADS_DIR, PHOTOS_UPLOAD_DIR, FORMS_UPLOAD_DIR, IDCARDS_UPLOAD_DIR].forEach((dir) => {
  if (!IS_VERCEL && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

function buildUploadUrl(req, relativePath) {
  const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
  return `${baseUrl}/uploads/${String(relativePath).replace(/^\/+/, "")}`;
}



// Parse JSON / URL-encoded requests
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

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
    next()
  } catch (err) {
    console.error('❌ Invalid JWT:', err)
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

    return res.json(rows);
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

      return res.json(rows);
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
  async (req, res) => {
    try {
      const complaintId = Number(req.params.id);
      const { message } = req.body;

      if (!complaintId) {
        return res.status(400).json({ error: "Invalid complaint id" });
      }

      if (!message || !String(message).trim()) {
        return res.status(400).json({ error: "Reply message is required" });
      }

      const complaint = await prisma.complaint.findUnique({
        where: { id: complaintId },
      });

      if (!complaint) {
        return res.status(404).json({ error: "Complaint not found" });
      }

      const reply = await prisma.complaintReply.create({
        data: {
          complaintId,
          senderId: req.user.id,
          message: String(message).trim(),
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

// =========================
// ✅ TRANSFER (change employeeNumber + history)
// =========================

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

      if (!newEmployeeNumber) {
        return res.status(400).json({ error: "newEmployeeNumber is required" });
      }

      const target = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!target) {
        return res.status(404).json({ error: "User not found" });
      }

      if (target.role !== "CLIENT") {
        return res.status(400).json({ error: "Only CLIENT users can be transferred" });
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
        const existingUser = await prisma.user.findUnique({
          where: { employeeNumber: trimmedNewEmployeeNumber },
        });
        if (existingUser) {
          return res.status(409).json({ error: "newEmployeeNumber already exists" });
        }

        const existingSubmissionWithNewNumber = await prisma.submission.findUnique({
          where: { employeeNumber: trimmedNewEmployeeNumber },
        });
        if (existingSubmissionWithNewNumber) {
          return res.status(409).json({ error: "Submission already exists for newEmployeeNumber" });
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
            performedById: req.user.id,
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

      return res.json({
        message: "✅ Transfer completed",
        user: result.updatedUser,
        transfer: result.history,
      });
    } catch (err) {
      console.error("❌ transfer error:", err);

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
    // 1. Custom webhook
    if (process.env.OTP_WHATSAPP_WEBHOOK_URL) {
      await axios.post(process.env.OTP_WHATSAPP_WEBHOOK_URL, {
        to: target,
        message: msg,
        code: otpCode,
        purpose,
        user: { id: user.id, employeeNumber: user.employeeNumber, name: user.name },
      }, { timeout: 15000 });
      return { deliveryMode: 'webhook' };
    }

    // 2. CallMeBot
    if (hasUsableWhatsappConfig()) {
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
    throw new Error('WhatsApp not configured. Add WHATSAPP_CALLMEBOT_APIKEY (or OTP_WHATSAPP_WEBHOOK_URL) to your .env file.');
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
      if (process.env.OTP_WHATSAPP_WEBHOOK_URL) {
        await axios.post(process.env.OTP_WHATSAPP_WEBHOOK_URL, {
          to: waPhone, message: msg, username, password,
          user: { id: user.id, employeeNumber: user.employeeNumber, name: user.name },
        }, { timeout: 15000 });
      } else if (hasUsableWhatsappConfig()) {
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
    const otpChannel = String(channel || '').trim().toUpperCase();

    if (!identifier || !otpPurpose || !otpChannel) {
      return res.status(400).json({ error: 'identifier, purpose and channel are required' });
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

    let target = '';
    if (otpChannel === OTP_CHANNEL.EMAIL) {
      if (!user.email) {
        return res.status(400).json({ error: 'This account has no email configured' });
      }
      target = user.email;
    } else {
      target = await resolveWhatsappPhoneForUser(user);
      if (!target) {
        return res.status(400).json({ error: 'No WhatsApp phone found for this account' });
      }
    }

    const otpCode = generateOtpCode();
    const expiresAt = await persistOtpForUser({
      userId: user.id,
      purpose: otpPurpose,
      channel: otpChannel,
      target,
      otpCode,
    });

    const delivery = await sendOtpMessage({ user, channel: otpChannel, purpose: otpPurpose, otpCode, target });

    const maskedTarget = otpChannel === OTP_CHANNEL.EMAIL ? maskEmail(target) : maskPhone(target);
    const payload = {
      message: `OTP sent via ${otpChannel}`,
      channel: otpChannel,
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
    const channel = String(req.body?.channel || '').trim().toUpperCase();
    if (!Object.values(OTP_CHANNEL).includes(channel)) {
      return res.status(400).json({ error: 'Unsupported OTP channel' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.firstLogin) {
      return res.status(400).json({ error: 'First-login OTP is not required for this account' });
    }

    let target = '';
    if (channel === OTP_CHANNEL.EMAIL) {
      if (!user.email) return res.status(400).json({ error: 'No email configured for this account' });
      target = user.email;
    } else {
      target = await resolveWhatsappPhoneForUser(user);
      if (!target) return res.status(400).json({ error: 'No WhatsApp phone found for this account' });
    }

    const otpCode = generateOtpCode();
    const expiresAt = await persistOtpForUser({
      userId: user.id,
      purpose: OTP_PURPOSE.FIRST_LOGIN,
      channel,
      target,
      otpCode,
    });

    const delivery = await sendOtpMessage({ user, channel, purpose: OTP_PURPOSE.FIRST_LOGIN, otpCode, target });

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

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { employeeNumber: loginId },
          { username: loginId }
        ]
      }
    })
    if (!user) return res.status(404).json({ error: 'User not found' })

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return res.status(401).json({ error: 'Incorrect password' })

    const token = jwt.sign(
      { id: user.id, employeeNumber: user.employeeNumber, role: user.role, firstLogin: user.firstLogin },
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
  res.json({ user })
})

// PUT /api/profile — update own email / phone / phone2 (cannot delete existing phone)
app.put('/api/profile', authenticate, async (req, res) => {
  try {
    const { email, phone, phone2 } = req.body;
    const current = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!current) return res.status(404).json({ error: 'User not found' });

    const data = {};

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
      return res.status(409).json({ error: 'Submission already exists for this employee number' });
    }

    // 5️⃣ Create new submission
    const submission = await prisma.submission.create({
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

// POST /api/staff/generate-link
app.post(
  "/api/staff/generate-link",
  authenticate,
  requireRole(["STAFF", "ADMIN", "SUPERADMIN"]),
  async (req, res) => {
    try {
      const { hoursValid, maxUses } = req.body;

      const token = crypto.randomBytes(32).toString("hex");

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
    res.json(cards);
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
      const existing = await prisma.user.findUnique({
        where: { id: Number(id) }
      })
      if (!existing) {
        return res.status(404).json({ error: 'User not found' })
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

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

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
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return res.status(404).json({ error: 'User not found' });

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

      return res.json({ message: 'Password reset successfully. Credentials sent to user.' });
    } catch (err) {
      console.error(`❌ POST /api/admin/users/${id}/reset-password error:`, err);
      return res.status(500).json({ error: 'Failed to reset password', details: err.message });
    }
  });

// ——————————————————————————
// DELETE /api/admin/users/:id
// Delete a user by ID (supports cascade or soft delete)
app.delete('/api/admin/users/:id',
  authenticate, requireRole(['ADMIN', 'SUPERADMIN']), async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid user ID' });

    try {
      const existing = await prisma.user.findUnique({
        where: { id },
        include: {
          idCards: true,
          submissions: true
        }
      });

      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Optional soft delete: uncomment if using deletedAt
      /*
      await prisma.user.update({
        where: { id },
        data: { deletedAt: new Date() }
      });
      return res.json({ message: 'User soft-deleted successfully', id });
      */

      // Hard delete (with cascade on IdCards & Submissions if schema is updated)
      await prisma.user.delete({
        where: { id }
      });

      console.log(`✅ User ${id} deleted. Cascade removed ${existing.idCards.length} idCards and ${existing.submissions.length} submissions.`);

      res.json({ message: 'User deleted successfully', id });
    } catch (err) {
      console.error(`❌ DELETE /api/admin/users/${id} error:`, err);

      // Detect FK error (for safety if cascade is missing)
      if (err.code === 'P2003') {
        return res.status(409).json({
          error: 'Cannot delete user: dependent records exist. Enable cascade deletes or use soft delete.'
        });
      }

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
        where: { employeeNumber: req.user.employeeNumber },
        orderBy: { submittedAt: 'desc' }
      })
      return res.json(subs)
    }

    // ADMIN / SUPERADMIN -> all
    const subs = await prisma.submission.findMany({
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
    await prisma.submission.delete({ where: { id } })
    res.json({ message: 'Submission deleted', id })
  } catch (err) {
    console.error(`❌ DELETE /submissions/${id} error:`, err)
    res.status(500).json({ error: 'Failed to delete submission' })
  }
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

// global error handler (must come after all route definitions)
app.use((err, req, res, next) => {
  if (!err) return next();
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
