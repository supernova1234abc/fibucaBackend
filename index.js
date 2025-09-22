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

const app = express()
const prisma = new PrismaClient()
const PORT = process.env.PORT
const JWT_SECRET = process.env.JWT_SECRET || 'fibuca_secret'
//cors
const allowedOrigins = [
  process.env.FRONTEND_URL || "http://localhost:5173",
  "https://fibuca-frontend.vercel.app"
];

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (Postman, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));

// Parse JSON / URL-encoded requests
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

// --------------------
// Serve static files
// --------------------
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))
app.use('/photos', express.static(path.join(__dirname, 'photos')))



// --------------------
// Multer setup
// --------------------
const pdfStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`)
  }
})
const uploadPDF = multer({ storage: pdfStorage })

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './photos'
    if (!fs.existsSync(dir)) fs.mkdirSync(dir)
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}${ext}`)
  }
})
const uploadPhoto = multer({ storage: photoStorage })

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


// —–– PROTECTED: Fetch ID cards
app.get('/api/idcards/:userId', authenticate, async (req, res) => {
  const uid = parseInt(req.params.userId);

  // Allow CLIENT to fetch their own cards, SUPERADMIN can fetch any
  if (req.user.role === 'CLIENT' && req.user.id !== uid) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const cards = await prisma.idCard.findMany({
    where: { userId: uid },
    orderBy: { issuedAt: 'desc' }
  });

  res.json(cards);
});


// Configure PDF upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });




/**
 * ✅ POST /submit-form
 * Receives form data + PDF and saves to database
 * Also auto-creates a placeholder IdCard record
 */
app.post('/submit-form', upload.single('pdf'), async (req, res) => {
  try {
    // 1️⃣ Parse the form and save PDF path
    const form = JSON.parse(req.body.data);
    const pdfPath = req.file.path;

    // 2️⃣ Create the Submission record
    const submission = await prisma.submission.create({
      data: {
        employeeName: form.employeeName,
        employeeNumber: form.employeeNumber,
        employerName: form.employerName,
        dues: form.dues,
        witness: form.witness,
        pdfPath,
        submittedAt: new Date()
      }
    });

    // 3️⃣ Check if user already exists
    let user, tempPassword, hashedPassword;
    try {
      user = await prisma.user.findUnique({ where: { username: form.employeeNumber } });
    } catch (err) {
      user = null;
    }
    if (!user) {
      // If not, create new user
      const suffix = Math.floor(1000 + Math.random() * 9000).toString();
      tempPassword = form.employeeNumber + suffix;
      hashedPassword = await bcrypt.hash(tempPassword, 10);
      try {
        user = await prisma.user.create({
          data: {
            name: form.employeeName,
            username: form.employeeNumber,
            email: `${form.employeeNumber}@fibuca.com`,
            password: hashedPassword,
            employeeNumber: form.employeeNumber,
            role: 'CLIENT'
          }
        });
      } catch (err) {
        if (err.code === 'P2002') {
          // Unique constraint failed
          return res.status(409).json({ error: 'A user with this employee number already exists.' });
        }
        throw err;
      }
    } else {
      // If user exists, set tempPassword to null so frontend knows not to auto-login
      tempPassword = null;
    }

    // 4️⃣ Immediately generate a placeholder IdCard record if not exists
    function makeCardNumber() {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const prefix = Array.from({ length: 2 })
        .map(() => letters[Math.floor(Math.random() * letters.length)])
        .join('');
      const digits = Math.floor(100000 + Math.random() * 900000);
      return `FIBUCA${prefix}${digits}`;
    }

    let placeholderCard = await prisma.idCard.findFirst({ where: { userId: user.id } });
    if (!placeholderCard) {
      placeholderCard = await prisma.idCard.create({
        data: {
          userId: user.id,
          fullName: user.name,
          photoUrl: '',                // empty until they upload or capture later
          company: submission.employerName,
          role: 'Member',          // default for CLIENT
          issuedAt: new Date(),
          cardNumber: makeCardNumber()
        }
      });
    }

    // 5️⃣ Respond with everything the front-end needs
    res.status(200).json({
      message: 'Form submitted, user registered & placeholder ID card created',
      submission,
      user: {
        id: user.id,
        name: user.name,
        employeeNumber: user.employeeNumber,
        role: user.role,
        firstLogin: user.firstLogin,
        pdfPath
      },
      loginCredentials: tempPassword ? { username: user.username, password: tempPassword } : null,
      idCard: placeholderCard
    });
  } catch (err) {
    console.error('❌ Submission error:', err);
    res.status(500).json({ error: 'Failed to submit form' });
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



const { removeBackground } = require('./py-tools/utils/runPython');


app.post('/api/idcards/photo', uploadPhoto.single('photo'), async (req, res) => {
  const { userId, fullName, company, role, cardNumber } = req.body;
  const originalPath = req.file.path;
  const cleanedFilename = `${Date.now()}-cleaned.png`;
  const cleanedPath = path.join('photos', cleanedFilename);

  try {
    await removeBackground(originalPath, cleanedPath);

    const card = await prisma.idCard.create({
      data: {
        userId: parseInt(userId),
        fullName,
        company,
        role,
        cardNumber,
        photoUrl: cleanedPath
      }
    });

    res.status(201).json({ message: 'ID card created with cleaned photo', card });
  } catch (err) {
    console.error('❌ Background removal or ID card creation error:', err);
    res.status(500).json({ error: 'Failed to process photo or create ID card' });
  }
});


app.post('/api/idcards', async (req, res) => {
  const { userId, fullName, photoUrl, company, role, cardNumber } = req.body;

  if (!userId || !fullName || !company || !role || !cardNumber) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const card = await prisma.idCard.create({
      data: {
        userId: parseInt(userId),
        fullName,
        photoUrl,
        company,
        role,
        cardNumber
      }
    });
    res.status(201).json({ message: 'ID card created', card });
  } catch (err) {
    console.error('❌ ID card creation error:', err);
    res.status(500).json({ error: 'Failed to create ID card' });
  }
});


// multer storage is already configured as `uploadPhoto`
/**
 * ✅ PUT /api/idcards/:id/photo
 * Updates an existing IdCard’s photoUrl
 */

// ✅ PUT /api/idcards/:id/photo
// Upload a new photo for an existing ID card, clean background, and update DB
app.put('/api/idcards/:id/photo', uploadPhoto.single('photo'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded' });
  }

  try {
    // 1️⃣ Resolve filesystem path for uploaded file
    const originalPath = req.file.path; // multer already stores it
    const cleanedFilename = `${Date.now()}-cleaned.png`;
    const cleanedPath = path.join(__dirname, 'photos', cleanedFilename);
    const cleanedUrl = `/photos/${cleanedFilename}`; // URL for frontend

    // 2️⃣ Run background removal
    await removeBackground(originalPath, cleanedPath);

    // 3️⃣ Update DB with cleaned photo URL
    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: { photoUrl: cleanedUrl }
    });

    console.log(`✅ Photo uploaded & cleaned: ${cleanedPath}`);
    res.json({
      message: 'Photo uploaded and background cleaned',
      card: updatedCard
    });

  } catch (err) {
    console.error('❌ Photo upload or background removal failed:', err);
    res.status(500).json({ error: 'Failed to upload or clean photo', details: err.message || err });
  }
});



// ✅ PUT /api/idcards/:id/clean-photo
app.put('/api/idcards/:id/clean-photo', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    // 1️⃣ Find ID card
    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card || !card.photoUrl) {
      console.warn(`⚠️ No photo found for ID ${id}`);
      return res.status(404).json({ error: 'ID card or photo not found' });
    }

    // 2️⃣ Resolve absolute path of original photo
    // card.photoUrl is like "/photos/123456.png"
    const originalPath = path.join(__dirname, card.photoUrl);
    if (!fs.existsSync(originalPath)) {
      console.error('❌ Original photo file missing:', originalPath);
      return res.status(404).json({ error: 'Original photo file missing' });
    }

    // 3️⃣ Define cleaned photo path
    const cleanedFilename = `${Date.now()}-cleaned.png`;
    const cleanedPath = path.join(__dirname, 'photos', cleanedFilename); // filesystem path
    const cleanedUrl = `/photos/${cleanedFilename}`;                        // URL path for frontend

    // 4️⃣ Run background removal
    await removeBackground(originalPath, cleanedPath);

    // 5️⃣ Update DB
    const updated = await prisma.idCard.update({
      where: { id },
      data: { photoUrl: cleanedUrl }
    });

    console.log(`✅ Cleaned photo saved: ${cleanedPath}`);
    res.json({ message: 'Photo cleaned and updated', card: updated });

  } catch (err) {
    console.error('❌ Background removal failed:', err);
    res.status(500).json({ error: 'Failed to clean photo', details: err.message || err });
  }
});





/**
 * ✅ DELETE /api/idcards/:id
 * Delete an ID card
 */
app.delete('/api/idcards/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    // 1. Get the record before deleting
    const card = await prisma.idCard.findUnique({ where: { id } });

    if (!card) {
      return res.status(404).json({ error: 'ID card not found' });
    }

    // 2. Delete the record
    await prisma.idCard.delete({ where: { id } });

    // 3. Delete the photo file if exists
    if (card.photoUrl) {
      const photoPath = path.join(__dirname, card.photoUrl);
      fs.unlink(photoPath, (err) => {
        if (err) {
          console.warn(`⚠️ Failed to delete photo file: ${photoPath}`, err.message);
        } else {
          console.log(`🗑️ Deleted photo file: ${photoPath}`);
        }
      });
    }

    res.json({ message: 'ID card and photo deleted' });
  } catch (err) {
    console.error('❌ Delete ID card error:', err);
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



// Start the server
app.listen(PORT, () => {
  console.log(`✅ FIBUCA backend running at http://localhost:${PORT}`);
});
