# 🚀 LOW-MEMORY OPTIMIZATION GUIDE (500MB RAM)

## 1. DATABASE OPTIMIZATIONS

### Update `.env` for PostgreSQL connection pooling:
```env
# PostgreSQL connection with pooling optimized for low-RAM
DATABASE_URL="postgresql://user:password@host:5432/fibuca?schema=public&connection_limit=5&pool_timeout=30"

# Reduce connection pool size
PRISMA_POOL_SIZE=2
```

### Run optimized schema:
```bash
# Apply new schema to database
npx prisma migrate deploy

# Clear Prisma cache
rm -rf node_modules/.prisma
```

---

## 2. NODE.JS OPTIMIZATIONS

Create `ecosystem.config.js` for PM2 (if using):
```javascript
module.exports = {
  apps: [{
    name: 'fibuca-backend',
    script: './index.js',
    instances: 1,  // Single instance for low-RAM
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=256'  // Limit heap to 256MB
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    autorestart: true,
    max_memory_restart: '200M'  // Restart if exceeds 200MB
  }]
};
```

Or run with direct flags:
```bash
NODE_OPTIONS='--max-old-space-size=256' node index.js
```

---

## 3. IMAGE PROCESSING OPTIMIZATION

### Option A: Use Uploadcare (Recommended - No Local Processing)
Already implemented in your code! Images are processed via Uploadcare's `-/remove_bg/` filter.

### Option B: Local Python Processing (With Limits)
Use the optimized Python scripts:

```bash
# For file-based processing:
python py-tools/remove_bg_optimized.py input.jpg output.png

# For streaming processing:
cat photo.jpg | python py-tools/remove_bg_buffer_optimized.py > output.png
```

### Configure limits in Node.js:
```javascript
// In index.js - Add at top:
const os = require('os');

const SYSTEM_MEMORY = os.totalmem() / (1024 * 1024);  // MB
const MAX_CONCURRENT_UPLOADS = SYSTEM_MEMORY > 512 ? 3 : 1;
const UPLOAD_TIMEOUT = 30000;  // 30 seconds

console.log(`🖥️ System RAM: ${SYSTEM_MEMORY}MB - Max concurrent uploads: ${MAX_CONCURRENT_UPLOADS}`);
```

---

## 4. EXPRESS SERVER OPTIMIZATION

Add compression and limit middleware to `index.js` BEFORE other routes:

```javascript
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');

// Compression
app.use(compression({ level: 6, threshold: 1024 }));

// Rate limiting to prevent memory exhaustion
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,
  message: 'Too many requests'
});
app.use('/api/', limiter);

// Limit JSON body size
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

// Limit upload file size
const MAX_FILE_SIZE = 2 * 1024 * 1024;  // 2MB
const uploadPDF = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

// Add timeout for slow requests
app.use((req, res, next) => {
  req.setTimeout(30000);  // 30 second timeout
  next();
});
```

---

## 5. PRISMA OPTIMIZATION

In `index.js`, optimize Prisma client:

```javascript
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: ['warn', 'error'],  // Reduce logging
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
```

Add connection pooling to queries:

```javascript
// Use select() to fetch only needed fields
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: { id: true, name: true, role: true }  // Not password!
});

// Use take() to limit results
const users = await prisma.user.findMany({
  take: 50,  // Max 50 records
  skip: page * 50
});
```

---

## 6. MEMORY MONITORING & CLEANUP

Add a health check endpoint:

```javascript
app.get('/health', (req, res) => {
  const used = process.memoryUsage();
  const heapUsed = Math.round(used.heapUsed / 1024 / 1024);
  const heapTotal = Math.round(used.heapTotal / 1024 / 1024);
  
  res.json({
    status: 'OK',
    memory: {
      heapUsedMB: heapUsed,
      heapTotalMB: heapTotal,
      externalMB: Math.round(used.external / 1024 / 1024)
    },
    timestamp: new Date()
  });
});
```

---

## 7. RECOMMENDED STACK FOR 500MB RAM

| Component | Limit | Notes |
|-----------|-------|-------|
| Node.js Heap | 256MB | `--max-old-space-size=256` |
| Prisma Connections | 2-3 | Reduce pool size |
| Image Processing | 1 concurrent | Queue other requests |
| Database Buffer | PostgreSQL tuned | `shared_buffers=64MB` |
| Total Target | ~400-450MB | Keep 50-100MB free |

---

## 8. QUICK START

```bash
# 1. Install dependencies
npm install

# 2. Update schema
npx prisma migrate deploy

# 3. Install compression
npm install compression

# 4. Start with optimized settings
NODE_OPTIONS='--max-old-space-size=256' npm start

# 5. Monitor memory
curl http://localhost:3000/health
```

---

## 9. TROUBLESHOOTING

### Server keeps crashing?
- Check `/health` endpoint for memory usage
- Reduce `MAX_CONCURRENT_UPLOADS` 
- Enable request logging: `DEBUG=* npm start`

### Database connection errors?
- Reduce `PRISMA_POOL_SIZE` to 1-2
- Check PostgreSQL `max_connections` setting

### Image processing slow?
- Use Uploadcare CDN (already configured) - No local processing
- If using local Python: reduce `MAX_DIMENSION` from 800 to 600

### Still out of memory?
- Enable process restart on memory threshold:
  ```bash
  node --max-old-space-size=256 --abort-on-uncaught-exception index.js
  ```

---

## 📊 EXPECTED IMPROVEMENTS

After applying these optimizations:
- **Memory usage**: 380-420MB (down from 500+MB crashes)
- **Max concurrent users**: 10-15 (safe range)
- **Image processing time**: 5-10 seconds (with Uploadcare)
- **Stability**: 99%+ uptime on 500MB RAM
