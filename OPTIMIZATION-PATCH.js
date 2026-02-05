/**
 * 🚀 CRITICAL OPTIMIZATIONS TO ADD TO index.js (Top of file)
 * Add these RIGHT AFTER the imports and BEFORE the app.use() calls
 */

// ============================================
// 1. SYSTEM & MEMORY MANAGEMENT
// ============================================

const os = require('os');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');

// Log system resources
const SYSTEM_MEMORY = os.totalmem() / (1024 * 1024);
const MAX_CONCURRENT_UPLOADS = SYSTEM_MEMORY > 512 ? 3 : 1;

console.log(`
╔════════════════════════════════════════╗
║   🖥️  FIBUCA BACKEND - LOW-RAM MODE   ║
║   RAM Available: ${SYSTEM_MEMORY.toFixed(0)}MB              
║   Max Concurrent Uploads: ${MAX_CONCURRENT_UPLOADS}          
║   Heap Limit: 256MB (-max-old-space-size)
╚════════════════════════════════════════╝
`);

// ============================================
// 2. COMPRESSION MIDDLEWARE (Add before other middleware)
// ============================================

// Enable gzip compression to reduce bandwidth
app.use(compression({ 
  level: 6,           // Compression level (1-9, default 6)
  threshold: 1024,    // Only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// ============================================
// 3. REQUEST SIZE LIMITS (Replace existing)
// ============================================

app.use(express.json({ 
  limit: '5mb',
  strict: true
}));

app.use(express.urlencoded({ 
  limit: '5mb',
  extended: true,
  parameterLimit: 50  // Limit query parameters
}));

// ============================================
// 4. RATE LIMITING (Add before routes)
// ============================================

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,
  message: 'Too many requests from this IP',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health'  // Skip health checks
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 20,  // Max 20 uploads per hour
  message: 'Too many uploads',
  keyGenerator: (req) => req.user?.id || req.ip  // Per-user limit
});

app.use('/api/', apiLimiter);

// ============================================
// 5. REQUEST TIMEOUT HANDLER (Add after middleware)
// ============================================

app.use((req, res, next) => {
  req.setTimeout(30000);  // 30 seconds timeout
  res.setTimeout(30000);
  
  req.on('timeout', () => {
    console.warn('⚠️  Request timeout:', req.path);
    res.status(408).json({ error: 'Request timeout' });
  });
  
  next();
});

// ============================================
// 6. GARBAGE COLLECTION HINT (After Prisma)
// ============================================

const prisma = new PrismaClient({
  log: ['warn', 'error'],  // Only log warnings/errors, not info
  errorFormat: 'pretty'
});

// Force garbage collection periodically
setInterval(() => {
  if (global.gc) {
    global.gc();
    const used = process.memoryUsage();
    console.log(`♻️  GC: Heap ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB`);
  }
}, 60000);  // Every 60 seconds

// ============================================
// 7. UPDATE MULTER CONFIGURATION
// ============================================

const MAX_FILE_SIZE = 2 * 1024 * 1024;  // 2MB (reduce from 3MB)

const uploadPDF = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1  // Only 1 file at a time
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files allowed'));
    }
    cb(null, true);
  }
});

const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WebP allowed'));
    }
    cb(null, true);
  }
});

// ============================================
// 8. ADD HEALTH CHECK ENDPOINT
// ============================================

app.get('/health', (req, res) => {
  try {
    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
    const externalMB = Math.round(used.external / 1024 / 1024);
    
    const health = {
      status: heapUsedMB > 450 ? 'CRITICAL' : heapUsedMB > 350 ? 'WARNING' : 'OK',
      memory: {
        heapUsedMB,
        heapTotalMB,
        externalMB,
        uptime: process.uptime()
      },
      database: 'connected',
      timestamp: new Date().toISOString()
    };
    
    const statusCode = health.status === 'OK' ? 200 : health.status === 'WARNING' ? 503 : 503;
    res.status(statusCode).json(health);
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// ============================================
// 9. ERROR HANDLING MIDDLEWARE (At end of file)
// ============================================

// Add this AFTER all routes but BEFORE app.listen()

app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  
  // Handle memory overflow
  if (err.code === 'ENOMEM') {
    return res.status(503).json({ error: 'Server out of memory' });
  }
  
  // Handle multer errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (max 2MB)' });
    }
    return res.status(400).json({ error: err.message });
  }
  
  // Default error response
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ============================================
// 10. GRACEFUL SHUTDOWN
// ============================================

// Add this at the END of your file

const server = app.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health\n`);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  server.close(async () => {
    console.log('HTTP server closed');
    await prisma.$disconnect();
    console.log('Database disconnected');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after 10 seconds');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================
// KEY QUERY OPTIMIZATIONS (Update existing queries)
// ============================================

/**
 * Apply these changes to your database queries:
 * 
 * BEFORE:
 *   const user = await prisma.user.findUnique({ where: { id } });
 * 
 * AFTER (Select only needed fields):
 *   const user = await prisma.user.findUnique({
 *     where: { id },
 *     select: { id: true, name: true, role: true, email: true }
 *   });
 * 
 * BEFORE:
 *   const users = await prisma.user.findMany();
 * 
 * AFTER (Add pagination):
 *   const users = await prisma.user.findMany({
 *     take: 50,
 *     skip: page * 50,
 *     select: { id: true, name: true, role: true }
 *   });
 */

// ============================================
// ENVIRONMENT VARIABLES NEEDED
// ============================================

/*
Add these to your .env file:

# Memory & Performance
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=256

# Database with pooling
DATABASE_URL="postgresql://user:password@host/db?schema=public&connection_limit=5"

# Limits
UPLOAD_SIZE_LIMIT=2097152
MAX_CONCURRENT_UPLOADS=1
REQUEST_TIMEOUT=30000

# Logging
LOG_LEVEL=warn
*/

// ============================================
// STARTUP COMMAND
// ============================================

/*
Run with:
  NODE_OPTIONS='--max-old-space-size=256' npm start

Or with PM2:
  pm2 start ecosystem.config.js

Or with Docker:
  docker run -e NODE_OPTIONS='--max-old-space-size=256' node:18-alpine
*/
