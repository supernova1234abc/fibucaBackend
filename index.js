// ✅ backend/server.js (FIBUCA backend using Prisma + Express)
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: 'https://0625bf4d2e71.ngrok-free.app.ngrok.io', // 👈 Replace with actual URL
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

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
app.post('/submit-form', upload.single('pdf'), async (req, res) => {
  try {
    const form = JSON.parse(req.body.data);
    const pdfPath = req.file.path;

    // Auto-generate password: employeeNumber + 4-digit suffix
    const suffix = Math.floor(1000 + Math.random() * 9000).toString();
    const password = form.employeeNumber + suffix;
    const hashedPassword = await bcrypt.hash(password, 10);

    // Save submission
    const saved = await prisma.submission.create({
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

// Save user credentials  //const user =
 await prisma.user.create({
  data: {
    name: form.employeeName,
    username: form.employeeNumber, // ✅ Added
    email: `${form.employeeNumber}@fibuca.com`,
    password: hashedPassword,
    employeeNumber: form.employeeNumber,
    role: 'CLIENT'
  }
});


    res.status(200).json({
      message: 'Form submitted and user registered successfully',
      entry: saved,
      loginCredentials: {
        username: form.employeeNumber,
        password // temporary password to be changed later
      }
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

// Start the server
app.listen(PORT, () => {
  console.log(`✅ FIBUCA backend running at http://localhost:${PORT}`);
});
