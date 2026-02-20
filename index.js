// backend/index.js
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const multer = require('multer')
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcrypt')
const { PrismaClient } = require('@prisma/client')
require('dotenv').config()
const streamifier = require('streamifier') // ✅ const import style
const { v2: cloudinary } = require('cloudinary');
// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const axios = require('axios'); // used to fetch raw image server-side

// ✅ Re-enabled: Optimized Python rembg with heavy memory optimization
// Using remove_bg_buffer_optimized.py for streaming/chunked processing
// Reduces RAM footprint from 300MB to ~100MB for testing
const { removeBackgroundBuffer } = require('./py-tools/utils/runPython');
console.log('✅ Using optimized Python rembg with streaming for low-RAM systems');

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
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
    allowedHeaders: ["Content-Type", "Authorization"],
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



// Parse JSON / URL-encoded requests
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

// --------------------
// Serve static files
// --------------------
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))
// ensure photos directory exists (backend may run without it)
const photosDir = path.join(__dirname, 'photos');
if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });
// serve photos directory for locally processed ID card images
app.use('/photos', express.static(photosDir))


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

// Login → set cookie
app.post('/api/login', async (req, res) => {
  const { employeeNumber, password } = req.body
  try {
    const user = await prisma.user.findUnique({ where: { employeeNumber } })
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

// ---------- POST /submit-form ----------
app.post("/submit-form", uploadPDF.single("pdf"), async (req, res) => {
  try {
    // 1️⃣ Parse form JSON from frontend
    const form = JSON.parse(req.body.data);
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    // Verify Cloudinary is configured
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY) {
      console.error('❌ Cloudinary not configured. Missing env vars:', {
        CLOUDINARY_CLOUD_NAME: !!process.env.CLOUDINARY_CLOUD_NAME,
        CLOUDINARY_API_KEY: !!process.env.CLOUDINARY_API_KEY,
        CLOUDINARY_API_SECRET: !!process.env.CLOUDINARY_API_SECRET,
      });
      return res.status(500).json({ 
        error: 'Server misconfigured: Cloudinary not set up. Contact admin.',
        details: 'Missing Cloudinary environment variables'
      });
    }

    // ---------- GET /api/download/:id ----------
// Allow ADMIN/SUPERADMIN to download a submission's PDF
app.get('/api/download/:id', authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid submission ID' });

    const submission = await prisma.submission.findUnique({ where: { id } });
    if (!submission || !submission.pdfPath) {
      return res.status(404).json({ error: 'No PDF found for this submission' });
    }

    // Role check: clients can only download their own
    if (req.user.role === 'CLIENT' && req.user.employeeNumber !== submission.employeeNumber) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Redirect to Cloudinary secure URL
    return res.redirect(submission.pdfPath);
  } catch (err) {
    console.error('❌ GET /api/download/:id failed:', err);
    res.status(500).json({ error: 'Failed to download PDF' });
  }
});


    // 2️⃣ Prepare Cloudinary upload stream
    const publicId = `form_${form.employeeNumber}_${Date.now()}`;
    const uploadStream = () =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'raw',    // PDF or doc file
            folder: 'fibuca/forms',  // Cloudinary folder
            public_id: publicId,
            format: 'pdf',            // ensures .pdf extension
          },
          (error, result) => (error ? reject(error) : resolve(result))
        );
        streamifier.createReadStream(req.file.buffer).pipe(stream);
      });

    // 3️⃣ Upload PDF
    const uploadResult = await uploadStream();
    const pdfUrl = uploadResult.secure_url;

    // 4️⃣ Upsert submission record in database
    const submission = await prisma.submission.upsert({
      where: { employeeNumber: form.employeeNumber },
      update: {
        employeeName: form.employeeName,
        employerName: form.employerName,
        dues: form.dues,
        witness: form.witness,
        pdfPath: pdfUrl,
        submittedAt: new Date(),
      },
      create: {
        employeeName: form.employeeName,
        employeeNumber: form.employeeNumber,
        employerName: form.employerName,
        dues: form.dues,
        witness: form.witness,
        pdfPath: pdfUrl,
        submittedAt: new Date(),
      },
    });

    // 5️⃣ Check if user exists, else create
    let user = await prisma.user.findUnique({ where: { username: form.employeeNumber } });
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
    }

    // 6️⃣ Generate placeholder ID card if not exists
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
          rawPhotoUrl: "", // can be filled later after photo upload
          cleanPhotoUrl: "",
          company: submission.employerName,
          role: "Member",
          issuedAt: new Date(),
          cardNumber: makeCardNumber(),
        },
      });
    }

    // 7️⃣ Respond to frontend
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
            employeeName: record.employeeName || '',
            employeeNumber: record.employeeNumber || '',
            employerName: record.employerName || '',
            dues: record.dues || '1%',
            witness: record.witness || '',
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



/**
 * ✅ POST /api/idcards
 * Create a new ID card
 */
// Python processing completely removed for Vercel compatibility




// ---------- GET /api/idcards/:userId ----------
app.get('/api/idcards/:userId', authenticate, async (req, res) => {
  try {
    const uid = parseInt(req.params.userId);
    if (isNaN(uid)) return res.status(400).json({ error: 'Invalid userId' });

    if (req.user.role === 'CLIENT' && req.user.id !== uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const cards = await prisma.idCard.findMany({
      where: { userId: uid },
      orderBy: { issuedAt: 'desc' }
    });

    res.json(cards);
  } catch (err) {
    console.error('❌ GET /api/idcards/:userId error:', err);
    res.status(500).json({ error: 'Failed to fetch ID cards' });
  }
});

// ---------- POST /api/idcards (create new card) ----------
app.post('/api/idcards', authenticate, async (req, res) => {
  try {
    const { userId, fullName, company, role, cardNumber } = req.body;
    if (!userId || !fullName || !company || !role || !cardNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const card = await prisma.idCard.create({
      data: {
        userId: parseInt(userId),
        fullName,
        company,
        role,
        cardNumber,
        photoUrl: '',
        // photoStatus is no longer needed with synchronous Uploadcare processing
      }
    });

    res.status(201).json({ message: 'ID card created', card });
  } catch (err) {
    console.error('❌ POST /api/idcards error:', err);
    res.status(500).json({ error: 'Failed to create ID card' });
  }
});

/**
 * ✅ PUT /api/idcards/:id/photo
 * Upload a raw ID card photo, run Python rembg to remove background, and save both
* raw and cleaned images to the local `photos/` folder.  Updates DB with local URLs.
*/

// new endpoint: upload raw image and clean locally
app.put('/api/idcards/:id/photo', authenticate, uploadPhoto.single('photo'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });
    if (req.user.role === 'CLIENT' && req.user.id !== card.userId)
      return res.status(403).json({ error: 'Forbidden' });

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No photo file uploaded' });
    }

    // ensure photos directory exists
    const photosDir = path.join(__dirname, 'photos');
    if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });

    const ext = path.extname(req.file.originalname) || '.png';
    const rawFilename = `idcard_${id}_raw_${Date.now()}${ext}`;
    const rawPath = path.join(photosDir, rawFilename);
    fs.writeFileSync(rawPath, req.file.buffer);

    let cleanedBuffer;
    try {
      cleanedBuffer = await removeBackgroundBuffer(req.file.buffer);
    } catch (pyErr) {
      console.warn('[idcard/photo] Python rembg failed, proceeding without clean image:', pyErr.message);
    }

    let cleanUrl = '';
    if (cleanedBuffer) {
      const cleanFilename = `idcard_${id}_clean_${Date.now()}.png`;
      const cleanPath = path.join(photosDir, cleanFilename);
      fs.writeFileSync(cleanPath, cleanedBuffer);
      cleanUrl = `${process.env.VITE_BACKEND_URL || `${req.protocol}://${req.get('host')}`}/photos/${cleanFilename}`;
    }

    const rawUrl = `${process.env.VITE_BACKEND_URL || `${req.protocol}://${req.get('host')}`}/photos/${rawFilename}`;

    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: {
        rawPhotoUrl: rawUrl,
        cleanPhotoUrl: cleanUrl,
      },
    });

    res.json({ message: '✅ Photo uploaded and processed locally', card: updatedCard });
  } catch (err) {
    console.error('❌ PUT /api/idcards/:id/photo failed:', err);
    res.status(500).json({ error: 'Failed to save photo', details: err.message });
  }
});

/**
 * ✅ PUT /api/idcards/:id/clean-photo
 * Re-run Python rembg on the existing raw photo and overwrite the clean image
 * (useful if the backend Python script or parameters change).  Works with
 * locally stored photos or remote URLs.
 */
app.put('/api/idcards/:id/clean-photo', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });

    if (!card.rawPhotoUrl)
      return res.status(400).json({ error: 'No raw photo URL found to clean' });

    // fetch raw bytes (either local file or remote URL)
    let buf;
    if (/^https?:\/\//.test(card.rawPhotoUrl)) {
      const resp = await axios.get(card.rawPhotoUrl, { responseType: 'arraybuffer', timeout: 20000 });
      buf = Buffer.from(resp.data);
    } else {
      const fname = path.basename(card.rawPhotoUrl);
      buf = fs.readFileSync(path.join(__dirname, 'photos', fname));
    }

    const cleaned = await removeBackgroundBuffer(buf);
    const cleanFilename = `idcard_${id}_clean_${Date.now()}.png`;
    const cleanPath = path.join(__dirname, 'photos', cleanFilename);
    fs.writeFileSync(cleanPath, cleaned);
    const cleanPhotoUrl = `${process.env.VITE_BACKEND_URL || `${req.protocol}://${req.get('host')}`}/photos/${cleanFilename}`;

    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: { cleanPhotoUrl },
    });

    res.json({
      message: '✅ Photo re-cleaned using Cloudinary background removal.',
      card: updatedCard,
    });
  } catch (err) {
    console.error('❌ PUT /api/idcards/:id/clean-photo failed:', err);
    res.status(500).json({ error: 'Failed to clean photo', details: err.message });
  }
});

// ---------- DELETE /api/idcards/:id ----------
app.delete('/api/idcards/:id', authenticate, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });

    if (req.user.role === 'CLIENT' && req.user.id !== card.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.idCard.delete({ where: { id } });

    res.json({ message: 'ID card deleted' });
  } catch (err) {
    console.error('❌ DELETE /api/idcards/:id failed:', err);
    res.status(500).json({ error: 'Failed to delete ID card' });
  }
});

// GET   /api/admin/users
// List all users (omit password)
app.get('/api/admin/users', /* requireAuth, requireRole(['ADMIN','SUPERADMIN']), */ async (req, res) => {
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
app.post('/api/admin/users', /* requireAuth, requireRole(['ADMIN','SUPERADMIN']), */ async (req, res) => {
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

    res.status(201).json(user)
  } catch (err) {
    console.error('❌ POST /api/admin/users error:', err)
    res.status(500).json({ error: 'Failed to create user' })
  }
})

// ——————————————————————————
// PUT   /api/admin/users/:id
// Update name, email, role or employeeNumber
app.put('/api/admin/users/:id', /* requireAuth, requireRole(['ADMIN','SUPERADMIN']), */ async (req, res) => {
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

// ——————————————————————————
// DELETE /api/admin/users/:id
// Delete a user by ID
app.delete('/api/admin/users/:id', /* requireAuth, requireRole(['ADMIN','SUPERADMIN']), */ async (req, res) => {
  const { id } = req.params

  try {
    const existing = await prisma.user.findUnique({
      where: { id: Number(id) }
    })
    if (!existing) {
      return res.status(404).json({ error: 'User not found' })
    }

    await prisma.user.delete({
      where: { id: Number(id) }
    })

    res.json({ message: 'User deleted successfully', id: Number(id) })
  } catch (err) {
    console.error(`❌ DELETE /api/admin/users/${id} error:`, err)
    res.status(500).json({ error: 'Failed to delete user' })
  }
})

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

// PUT /submissions/:id -> update submission (admin only)
app.put('/submissions/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id)
  if (!['ADMIN', 'SUPERADMIN'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const { employeeName, employeeNumber, employerName, dues, witness } = req.body
  try {
    const updated = await prisma.submission.update({
      where: { id },
      data: {
        employeeName: employeeName ?? undefined,
        employeeNumber: employeeNumber ?? undefined,
        employerName: employerName ?? undefined,
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
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const { rawPhotoUrl } = req.body;
    if (!rawPhotoUrl) return res.status(400).json({ error: 'Missing rawPhotoUrl' });

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });

    if (req.user.role === 'CLIENT' && req.user.id !== card.userId)
      return res.status(403).json({ error: 'Forbidden' });

    console.log(`[fetch-and-clean] fetching image from: ${rawPhotoUrl}`);

    // 1) Fetch image bytes from rawPhotoUrl
    const resp = await axios.get(rawPhotoUrl, { responseType: 'arraybuffer', timeout: 20000 });
    let buf = Buffer.from(resp.data);
    console.log(`[fetch-and-clean] downloaded ${buf.length} bytes`);

    // 2) Apply optimized Python background removal (streaming/chunked processing)
    let cleanedBuffer;
    try {
      console.log('[fetch-and-clean] Applying optimized Python rembg...');
      cleanedBuffer = await removeBackgroundBuffer(buf);
      console.log(`[fetch-and-clean] ✅ Python processing complete: ${cleanedBuffer.length} bytes`);
      buf = null; // Free memory after processing
    } catch (pythonErr) {
      console.warn('[fetch-and-clean] ⚠️ Python processing failed, using original image:', pythonErr.message);
      cleanedBuffer = Buffer.from(resp.data); // Use original if Python fails
    }

    // 3) save cleaned buffer locally in photos directory
    const photosDir = path.join(__dirname, 'photos');
    if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });
    const cleanFilename = `idcard_fetched_${id}_${Date.now()}.png`;
    const cleanPath = path.join(photosDir, cleanFilename);
    fs.writeFileSync(cleanPath, cleanedBuffer);
    const cleanUrl = `${process.env.VITE_BACKEND_URL || `${req.protocol}://${req.get('host')}`}/photos/${cleanFilename}`;

    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: { cleanPhotoUrl: cleanUrl, rawPhotoUrl: rawPhotoUrl },
    });

    res.json({ message: '✅ Fetched, cleaned with Python rembg, and saved locally', card: updatedCard });
  } catch (err) {
    console.error('❌ fetch-and-clean failed:', err);
    res.status(500).json({ error: 'Failed to fetch or clean image', details: err.message });
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
