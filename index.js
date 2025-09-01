// ✅ backend/index.js (FIBUCA backend using Prisma + Express)
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
/*
app.use(cors({
 //frontend url  origin: 'https://8f9eda5f8bbd.ngrok-free.app', // 👈 Replace with actual URL
  origin: 'http://localhost:5173', // 👈 Replace with actual URL
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

*/
const prisma = new PrismaClient();
const PORT = process.env.PORT || 4000;

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'fibuca_secret';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.post('/api/login', async (req, res) => {
  const { employeeNumber, password } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { username: employeeNumber } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // ✅ Fetch the latest submission with PDF
    const submission = await prisma.submission.findFirst({
      where: { employeeNumber: user.employeeNumber },
      orderBy: { submittedAt: 'desc' } // just in case user submitted multiple times
    });

    const token = jwt.sign(
      {
        id: user.id,
        employeeNumber: user.employeeNumber,
        role: user.role,
        firstLogin: user.firstLogin,
      },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        employeeNumber: user.employeeNumber,
        role: user.role,
        firstLogin: user.firstLogin,
        name: user.name,
        pdfPath: submission?.pdfPath || null // ✅ include it
      }
    });

  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});



app.put('/api/change-password', async (req, res) => {
  const { employeeNumber, newPassword } = req.body;

  try {
    const hashed = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { employeeNumber },
      data: {
        password: hashed,
        firstLogin: false
      }
    });

    res.json({ message: 'Password updated' });
  } catch (err) {
    console.error('❌ Password update error:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});



// Serve uploaded PDFs
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve uploaded ID‐card photos
app.use('/photos', express.static(path.join(__dirname, 'photos')));


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

// ✅ REGISTER NEW USER after form submission
app.post('/register', async (req, res) => {
  const { name, email, password, employeeNumber, role } = req.body;

  if (!name || !email || !password || !employeeNumber) {
    return res.status(400).json({ error: 'All fields required' });
  }

  try {
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { employeeNumber }
        ]
      }
    });

    if (existing) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

 const newUser = await prisma.user.create({
  data: {
    name,
    username: employeeNumber, // ✅ Added
    email,
    employeeNumber,
    password: hashedPassword,
    role: role || 'CLIENT'
  }
});


    res.status(201).json({ message: 'Registered successfully', user: { id: newUser.id, name: newUser.name, email: newUser.email } });
  } catch (err) {
    console.error('❌ Register error:', err);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

/**
 * ✅ POST /submit-form
 * Receives form data + PDF and saves to database
 */
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
        employeeName:  form.employeeName,
        employeeNumber: form.employeeNumber,
        employerName:  form.employerName,
        dues:          form.dues,
        witness:       form.witness,
        pdfPath,
        submittedAt:   new Date()
      }
    });

    // 3️⃣ Auto-generate password and create the User
    const suffix        = Math.floor(1000 + Math.random() * 9000).toString();
    const tempPassword  = form.employeeNumber + suffix;
    const hashedPassword= await bcrypt.hash(tempPassword, 10);

    const user = await prisma.user.create({
      data: {
        name:           form.employeeName,
        username:       form.employeeNumber,
        email:          `${form.employeeNumber}@fibuca.com`,
        password:       hashedPassword,
        employeeNumber: form.employeeNumber,
        role:           'CLIENT'
      }
    });

    // 4️⃣ Immediately generate a placeholder IdCard record
    //    with no photoUrl yet and a FIBUCA + 2 letters + 6 digits number
    function makeCardNumber() {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const prefix  = Array.from({ length: 2 })
                          .map(() => letters[Math.floor(Math.random() * letters.length)])
                          .join('');
      const digits  = Math.floor(100000 + Math.random() * 900000);
      return `FIBUCA${prefix}${digits}`;
    }

    const placeholderCard = await prisma.idCard.create({
      data: {
        userId:     user.id,
        fullName:   user.name,
        photoUrl:   '',                // empty until they upload or capture later
        company:    submission.employerName,
        role:       'Member',          // default for CLIENT
        issuedAt:   new Date(),
        cardNumber: makeCardNumber()
      }
    });

    // 5️⃣ Respond with everything the front-end needs
    res.status(200).json({
      message: 'Form submitted, user registered & placeholder ID card created',
      submission,
      user: {
        id:             user.id,
        name:           user.name,
        employeeNumber: user.employeeNumber,
        role:           user.role,
        firstLogin:     user.firstLogin,
        pdfPath
      },
      loginCredentials: { username: user.username, password: tempPassword },
      idCard: placeholderCard
    });
  } catch (err) {
    console.error('❌ Submission error:', err);
    res.status(500).json({ error: 'Failed to submit form' });
  }
});

/**
 * ✅ GET /submissions
 * Returns all submissions (for Manager/Admin dashboard)
 */
app.get('/submissions', async (req, res) => {
  try {
    const records = await prisma.submission.findMany({ orderBy: { submittedAt: 'desc' } });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

/**
 * ✅ GET /export/excel
 * Exports all submissions as downloadable Excel file
 */
app.get('/export/excel', async (req, res) => {
  const XLSX = require('xlsx');
  try {
    const records = await prisma.submission.findMany();
    const cleaned = records.map(({ id, pdfPath, ...rest }) => ({ ...rest }));

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(cleaned);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Submissions');

    const tempPath = path.join(__dirname, 'fibuca_export.xlsx');
    XLSX.writeFile(workbook, tempPath);

    res.download(tempPath, 'fibuca_clients.xlsx', () => {
      fs.unlinkSync(tempPath); // Clean after download
    });
  } catch (err) {
    console.error('❌ Excel export error:', err);
    res.status(500).json({ error: 'Failed to export Excel' });
  }
});

/**
 * ✅ PUT /submissions/:id
 * Update a submission's info
 */
app.put('/submissions/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { employeeName, employeeNumber, employerName, dues, witness } = req.body;

  try {
    const updated = await prisma.submission.update({
      where: { id },
      data: { employeeName, employeeNumber, employerName, dues, witness }
    });
    res.json(updated);
  } catch (err) {
    console.error('❌ Update error:', err);
    res.status(500).json({ error: 'Failed to update submission' });
  }
});

/**
 * ✅ DELETE /submissions/:id
 * Delete a submission by ID
 */
app.delete('/submissions/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const deleted = await prisma.submission.delete({ where: { id } });
    if (deleted.pdfPath && fs.existsSync(deleted.pdfPath)) {
      fs.unlinkSync(deleted.pdfPath);
    }
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    console.error('❌ Delete error:', err);
    res.status(500).json({ error: 'Failed to delete submission' });
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

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './photos';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const uploadPhoto = multer({ storage: photoStorage });

const { removeBackground } = require('./py-tools/utils/runPython');


app.post('/api/idcards/photo', uploadPhoto.single('photo'), async (req, res) => {
  const { userId, fullName, company, role, cardNumber } = req.body;
  const originalPath = req.file.path;
  const cleanedPath = path.join('photos', `${Date.now()}-cleaned.png`);

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

/**
 * ✅ GET /api/idcards/:userId
 * Fetch all ID cards for a user
 */

// GET /api/idcards/:userId
app.get('/api/idcards/:userId', async (req, res) => {
  console.log(`→ incoming GET /api/idcards/${req.params.userId}`);
  const userId = parseInt(req.params.userId);
  try {
    const cards = await prisma.idCard.findMany({
      where: { userId },
      orderBy: { issuedAt: 'desc' }
    });
    // always return 200
    return res.json(cards);
  } catch (err) {
    console.error('❌ Fetch ID cards error:', err);
    return res.status(500).json({ error: 'Failed to fetch ID cards' });
  }
});

// multer storage is already configured as `uploadPhoto`
/**
 * ✅ PUT /api/idcards/:id/photo
 * Updates an existing IdCard’s photoUrl
 */
app.put(
  '/api/idcards/:id/photo',
  uploadPhoto.single('photo'),
  async (req, res) => {
    const id = parseInt(req.params.id);
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    try {
      const updated = await prisma.idCard.update({
        where: { id },
        data: { photoUrl: req.file.path }
      });
      res.json({ message: 'Photo updated', card: updated });
    } catch (err) {
      console.error('❌ Update ID card photo failed:', err);
      res.status(500).json({ error: 'Failed to update ID card photo' });
    }
  }
);


app.put('/api/idcards/:id/clean-photo', async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const card = await prisma.idCard.findUnique({ where: { id } });
    if (!card || !card.photoUrl) {
      console.warn(`⚠️ No photo found for ID ${id}`);
      return res.status(404).json({ error: 'ID card or photo not found' });
    }

    // Resolve absolute path to original photo
    const originalPath = path.resolve(card.photoUrl);
    if (!fs.existsSync(originalPath)) {
      console.error('❌ Original photo file not found:', originalPath);
      return res.status(404).json({ error: 'Original photo file missing' });
    }

    // Prepare cleaned image path
    const cleanedFilename = `${Date.now()}-cleaned.png`;
    const cleanedPath = path.join('photos', cleanedFilename);

    // Run background removal
    await removeBackground(originalPath, cleanedPath);

    // Update DB with cleaned photo path
    const updated = await prisma.idCard.update({
      where: { id },
      data: { photoUrl: cleanedPath }
    });

    res.json({ message: 'Photo cleaned and updated', card: updated });
  } catch (err) {
    console.error('❌ Background removal failed:', err.message || err);
    res.status(500).json({ error: 'Failed to clean photo' });
  }
});



/**
 * ✅ DELETE /api/idcards/:id
 * Delete an ID card
 */
app.delete('/api/idcards/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await prisma.idCard.delete({ where: { id } });
    res.json({ message: 'ID card deleted' });
  } catch (err) {
    console.error('❌ Delete ID card error:', err);
    res.status(500).json({ error: 'Failed to delete ID card' });
  }
});



// Start the server
app.listen(PORT, () => {
  console.log(`✅ FIBUCA backend running at http://localhost:${PORT}`);
});
