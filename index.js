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

// Python rembg removed - using Uploadcare backend filter instead
// This eliminates ~300MB RAM overhead from Render/Vercel
console.log('✅ Using Uploadcare backend filter for image processing (zero local overhead)');

const app = express()

// ---------- CORS Setup ----------
const allowedOrigins = [
  process.env.VITE_FRONTEND_URL || "http://localhost:5173",
  "https://fibuca-frontend.vercel.app"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  if (!origin || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

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
// no local /photos static hosting anymore — cleaned images are uploaded to Cloudinary


// ✅ Use memory storage for all uploads
const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // 3MB
const uploadPDF = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES } });
const uploadPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES } });


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
 * Save Uploadcare photo URLs to ID card. The clean URL is derived using Uploadcare's transformation.
 */

app.put('/api/idcards/:id/photo', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const { rawPhotoUrl } = req.body;
    if (!rawPhotoUrl)
      return res.status(400).json({ error: 'Missing rawPhotoUrl from frontend' });

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });

    if (req.user.role === 'CLIENT' && req.user.id !== card.userId)
      return res.status(403).json({ error: 'Forbidden' });

    console.log(`PUT /api/idcards/${id}/photo received rawPhotoUrl:`, rawPhotoUrl);

    // Normalize rawPhotoUrl - support direct URLs
    const isAbsolute = /^https?:\/\//i.test(String(rawPhotoUrl));
    let normalizedRaw = String(rawPhotoUrl);

    if (!isAbsolute) {
      // treat as backend-relative path
      const backendUrl = (process.env.VITE_BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      normalizedRaw = `${backendUrl}/${String(normalizedRaw).replace(/^\/+/, '')}`;
      console.log('Normalized relative path to absolute URL:', normalizedRaw);
    }

    // Generate clean URL using Cloudinary's FREE background removal effect
    const cleanPhotoUrl = `${normalizedRaw}?effect=background_removal`;
    console.log('✅ Clean URL with Cloudinary effect:', cleanPhotoUrl);

    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: {
        rawPhotoUrl: normalizedRaw,
        cleanPhotoUrl,
      },
    });

    res.json({
      message: '✅ Photo URLs saved successfully (normalized).',
      card: updatedCard,
    });
  } catch (err) {
    console.error('❌ PUT /api/idcards/:id/photo failed:', err);
    res.status(500).json({ error: 'Failed to save photo URLs', details: err.message });
  }
});

/**
 * ✅ PUT /api/idcards/:id/clean-photo
 * Re-generate the clean photo URL using Uploadcare's remove_bg filter.
 */
app.put('/api/idcards/:id/clean-photo', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });

    if (!card.rawPhotoUrl)
      return res.status(400).json({ error: 'No raw photo URL found to clean' });

    // Re-construct the clean URL using Cloudinary's free background removal effect
    const cleanPhotoUrl = `${card.rawPhotoUrl}?effect=background_removal`;
    console.log('Re-generated clean URL with Cloudinary effect:', cleanPhotoUrl);

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

// (no local photos directory — Cloudinary used for cleaned images)

/**
 * POST /api/idcards/:id/upload-clean
 * Accept cleaned image (PNG) from browser, upload to Cloudinary and update idCard.cleanPhotoUrl
 */
app.post('/api/idcards/:id/upload-clean', authenticate, uploadPhoto.single('cleanImage'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });

    if (req.user.role === 'CLIENT' && req.user.id !== card.userId)
      return res.status(403).json({ error: 'Forbidden' });

    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded' });

    // Upload cleaned buffer to Cloudinary
    const publicId = `idcard_clean_${id}_${Date.now()}`;
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'fibuca/idcards', public_id: publicId, resource_type: 'image', format: 'png' },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });

    const fileUrl = uploadResult?.secure_url || null;
    if (!fileUrl) {
      console.warn('Cloudinary upload returned no URL, falling back to returning error.');
      return res.status(500).json({ error: 'Cloudinary upload failed' });
    }

    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: { cleanPhotoUrl: fileUrl },
    });

    res.json({ message: 'Clean image uploaded to Cloudinary', card: updatedCard });
  } catch (err) {
    console.error('❌ upload-clean failed:', err);
    res.status(500).json({ error: 'Failed to upload cleaned image', details: err.message });
  }
});

/**
 * POST /api/idcards/:id/fetch-and-clean
 * Fetch raw image server-side, attempt Python cleaning (if available),
 * upload cleaned PNG (or original) to Cloudinary and update idCard.cleanPhotoUrl.
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
    const buf = Buffer.from(resp.data);

    // 2) Skip Python processing - Uploadcare filter will handle it
    // This saves 300MB+ RAM by avoiding local image processing
    console.log('[fetch-and-clean] Using Uploadcare remove_bg filter (no local processing)');
    const finalBuffer = buf;

    // If the source is not PNG, ensure Cloudinary stores PNG by uploading buffer as PNG stream.
    const publicId = `idcard_fetched_${id}_${Date.now()}`;
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'fibuca/idcards', public_id: publicId, resource_type: 'image', format: 'png' },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      streamifier.createReadStream(finalBuffer).pipe(stream);
    });

    const fileUrl = uploadResult?.secure_url || null;
    if (!fileUrl) {
      console.warn('[fetch-and-clean] Cloudinary upload returned no URL');
      return res.status(500).json({ error: 'Cloudinary upload failed' });
    }

    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: { cleanPhotoUrl: fileUrl, rawPhotoUrl: rawPhotoUrl },
    });

    res.json({ message: 'Fetched and uploaded image to Cloudinary', card: updatedCard });
  } catch (err) {
    console.error('❌ fetch-and-clean failed:', err);
    res.status(500).json({ error: 'Failed to fetch or clean image', details: err.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ FIBUCA backend running at http://localhost:${PORT}`);
});
