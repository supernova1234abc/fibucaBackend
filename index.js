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
const supabase = require('./supabaseClient');

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



// backend
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



/**
 * ✅ POST /submit-form
 * Receives form data + PDF and saves to database
 * Also auto-creates a placeholder IdCard record
 */
app.post("/submit-form", uploadPDF.single("pdf"), async (req, res) => {
  try {
    // 1️⃣ Parse the form
    const form = JSON.parse(req.body.data);
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    // 2️⃣ Get the PDF content from Multer
    const pdfBlob = req.file.buffer; // <-- fix: define pdfBlob

    // 3️⃣ Upload PDF to Supabase "uploads" bucket
    const fileName = `forms/${form.employeeNumber}_form.pdf`;
    const { data, error } = await supabase.storage
      .from("uploads")
      .upload(fileName, pdfBlob, { contentType: "application/pdf", upsert: true });
    if (error) throw error;

// 4️⃣ Get public URL safely
const { data: urlData, error: urlError } = supabase.storage.from("uploads").getPublicUrl(fileName);
if (urlError) throw urlError;
const pdfUrl = urlData.publicUrl;

  // 5️⃣ Create OR Update the Submission record
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


    // 6️⃣ Check if user exists, else create
    let user, tempPassword;
    user = await prisma.user.findUnique({ where: { username: form.employeeNumber } });
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
          photoUrl: "",
          company: submission.employerName,
          role: "Member",
          issuedAt: new Date(),
          cardNumber: makeCardNumber(),
        },
      });
    }

    // 8️⃣ Respond to frontend
    res.status(200).json({
      message: "Form submitted, user registered & placeholder ID card created",
      submission,
      user: {
        id: user.id,
        name: user.name,
        employeeNumber: user.employeeNumber,
        role: user.role,
        firstLogin: user.firstLogin,
        pdfUrl,
      },
      loginCredentials: tempPassword
        ? { username: user.username, password: tempPassword }
        : null,
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
const { removeBackgroundBuffer } = require('./py-tools/utils/runPython');


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
        photoUrl: ''
      }
    });

    res.status(201).json({ message: 'ID card created', card });
  } catch (err) {
    console.error('❌ POST /api/idcards error:', err);
    res.status(500).json({ error: 'Failed to create ID card' });
  }
});



// ---------- PUT /api/idcards/:id/photo (upload + clean + store in Supabase) ----------


// Upload & clean new photo
app.put('/api/idcards/:id/photo', authenticate, uploadPhoto.single('photo'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

  let card;
  try {
    card = await prisma.idCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'ID card not found' });
    if (req.user.role === 'CLIENT' && req.user.id !== card.userId) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const originalPath = req.file.path;
    const cleanedFilename = `${Date.now()}-cleaned.png`;
    const cleanedTempPath = path.join('/tmp', cleanedFilename);

    // 1️⃣ Clean photo using Python script
    await removeBackgroundBuffer(originalPath, cleanedTempPath);

    // 2️⃣ Stream upload cleaned photo to Supabase
    const cleanedStream = fs.createReadStream(cleanedTempPath);
    const { error: upErr } = await supabase.storage
      .from('idcards')
      .upload(cleanedFilename, cleanedStream, {
        contentType: 'image/png',
        upsert: true,
      });
    if (upErr) throw upErr;

    // 3️⃣ Get public URL
    const photoUrl = supabase.storage.from('idcards').getPublicUrl(cleanedFilename).data.publicUrl;

    // 4️⃣ Update DB
    const updatedCard = await prisma.idCard.update({
      where: { id },
      data: { photoUrl },
    });

    // 5️⃣ Cleanup temp files
    [originalPath, cleanedTempPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));

    res.json({ message: 'Photo uploaded, cleaned & stored!', card: updatedCard });

  } catch (err) {
    console.error('❌ PUT /api/idcards/:id/photo failed:', err);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to process photo', details: err.message });
  }
});


// Re-clean existing photo
app.put('/api/idcards/:id/clean-photo', authenticate, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card || !card.photoUrl) return res.status(404).json({ error: 'ID card or photo not found' });

    // Download existing photo from Supabase
    const filename = path.basename(card.photoUrl);
    const { data: fileData, error: dlErr } = await supabase.storage.from('idcards').download(filename);
    if (dlErr) throw dlErr;

    const tempOriginal = path.join('/tmp', filename);
    fs.writeFileSync(tempOriginal, Buffer.from(await fileData.arrayBuffer()));

    // Clean again
    const cleanedFilename = `${Date.now()}-recleaned.png`;
    const cleanedTempPath = path.join('/tmp', cleanedFilename);
    await removeBackgroundBuffer(tempOriginal, cleanedTempPath);

    // Stream upload new cleaned photo
    const cleanedStream = fs.createReadStream(cleanedTempPath);
    const { error: upErr } = await supabase.storage.from('idcards')
      .upload(cleanedFilename, cleanedStream, { contentType: 'image/png', upsert: true });
    if (upErr) throw upErr;

    const cleanedUrl = supabase.storage.from('idcards').getPublicUrl(cleanedFilename).data.publicUrl;

    // Update DB
    const updated = await prisma.idCard.update({
      where: { id },
      data: { photoUrl: cleanedUrl }
    });

    // Cleanup
    [tempOriginal, cleanedTempPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));

    res.json({ message: 'Photo re-cleaned and updated', card: updated });

  } catch (err) {
    console.error('❌ clean-photo failed:', err);
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

    if (card.photoUrl) {
      const filename = path.basename(card.photoUrl);
      await supabase.storage.from('idcards').remove([filename]);
    }

    res.json({ message: 'ID card and photo deleted' });
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



// Start the server
app.listen(PORT, () => {
  console.log(`✅ FIBUCA backend running at http://localhost:${PORT}`);
});
