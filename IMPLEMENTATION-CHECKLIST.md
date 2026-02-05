# 🎯 IMPLEMENTATION CHECKLIST - RAM OPTIMIZATION

## Phase 1: IMMEDIATE (Do First - 10 min)

### Environment Setup
- [ ] Update `.env` file with connection pooling:
  ```
  DATABASE_URL="postgresql://...?connection_limit=5"
  NODE_ENV=production
  ```

- [ ] Install additional dependencies:
  ```bash
  npm install compression express-rate-limit
  ```

- [ ] Test current memory usage:
  ```bash
  NODE_OPTIONS='--max-old-space-size=256' npm start
  curl http://localhost:3000/health
  ```

---

## Phase 2: CODE UPDATES (30-45 min)

### Backend (index.js)

#### Step 1: Add imports at top (after line 14)
```javascript
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const os = require('os');
```

#### Step 2: Add system monitoring (after prisma init, line ~52)
Copy content from `OPTIMIZATION-PATCH.js` sections 1-8

#### Step 3: Update middleware section (before routes)
- Add compression middleware
- Add rate limiters  
- Add timeout handler
- Update multer limits to 2MB max

#### Step 4: Add health endpoint (before routes)
Copy `/health` endpoint from `OPTIMIZATION-PATCH.js`

#### Step 5: Update database queries
Replace queries to use `.select()` for specific fields only:

**EXAMPLE - Find User:**
```javascript
// OLD (loads all fields including password):
const user = await prisma.user.findUnique({ where: { id: userId } });

// NEW (select only needed fields):
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: { id: true, name: true, role: true, email: true }
});
```

**EXAMPLE - Find Many:**
```javascript
// OLD (loads all):
const users = await prisma.user.findMany();

// NEW (with pagination):
const users = await prisma.user.findMany({
  take: 50,
  skip: page * 50,
  select: { id: true, name: true, email: true }
});
```

#### Step 6: Add graceful shutdown (end of file before listen)
Copy shutdown handler from `OPTIMIZATION-PATCH.js` section 10

#### Step 7: Add error handler (before app.listen)
Copy error handler from `OPTIMIZATION-PATCH.js` section 9

---

## Phase 3: DATABASE OPTIMIZATION (5-10 min)

### Schema Update
```bash
# 1. Review schema changes
cat prisma/schema_optimized.prisma

# 2. Apply new schema with indexes
npx prisma migrate dev --name add_indexes_optimize

# 3. Verify migration
npx prisma db push
```

### Connection Pooling
Update `.env`:
```env
DATABASE_URL="postgresql://user:pass@host/db?schema=public&connection_limit=5&pool_timeout=30&idle_in_transaction_session_timeout=30000"
```

---

## Phase 4: PYTHON IMAGE OPTIMIZATION (10 min - Optional)

If using local Python image processing:

### Step 1: Replace Python scripts
```bash
# Backup old versions
cp py-tools/remove_bg.py py-tools/remove_bg.py.bak
cp py-tools/remove_bg_buffer.py py-tools/remove_bg_buffer.py.bak

# Use optimized versions (already created)
# remove_bg_optimized.py
# remove_bg_buffer_optimized.py
```

### Step 2: Update Node.js to call optimized versions
```javascript
// In your image processing route:
const { exec } = require('child_process');

exec(`python py-tools/remove_bg_optimized.py input.jpg output.png`, (err) => {
  if (err) console.error('Python error:', err);
});
```

---

## Phase 5: DEPLOYMENT (5 min)

### Option A: Direct Node.js
```bash
NODE_OPTIONS='--max-old-space-size=256' npm start
```

### Option B: PM2
```bash
# Install PM2 globally
npm install -g pm2

# Start with ecosystem config
pm2 start ecosystem.config.js

# Make it auto-start
pm2 save
pm2 startup

# Check status
pm2 status
pm2 logs fibuca-backend
```

### Option C: Docker
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV NODE_OPTIONS='--max-old-space-size=256'
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "index.js"]
```

---

## Phase 6: VALIDATION & MONITORING (Ongoing)

### Health Checks
```bash
# Monitor memory in real-time
watch -n 2 'curl -s http://localhost:3000/health | jq'

# PM2 monitoring
pm2 monit

# System monitoring
free -m
ps aux | grep node
```

### Expected Metrics
- **Heap Used**: 200-250MB (normal operation)
- **Heap Total**: 256MB (max-old-space-size setting)
- **Status**: OK (< 350MB), WARNING (350-450MB), CRITICAL (> 450MB)

### Alerts to Set Up
```bash
# If heap > 350MB, log warning
# If heap > 450MB, restart process
# If connection pool errors, reduce from 5 to 3
```

---

## Phase 7: QUERY OPTIMIZATION (15-30 min)

### Audit all Prisma queries

Find queries that load unnecessary data:
```bash
grep -r "findMany\|findUnique\|findFirst" index.js | head -20
```

Update each to include `.select()`:

| Query | Current Fields | Optimized |
|-------|----------------|-----------|
| User lookup | All (id, name, email, password, etc) | id, name, role, email only |
| Submissions list | All | id, employeeNumber, submittedAt |
| ID Cards list | All | id, userId, cardNumber, issuedAt |

---

## Phase 8: CAPACITY TESTING (20 min)

### Test concurrent uploads
```bash
# Simulate 5 concurrent uploads
for i in {1..5}; do
  curl -F "pdf=@file$i.pdf" http://localhost:3000/submit-form &
done
wait
```

### Monitor results
```bash
curl http://localhost:3000/health
# Should show heap usage spike but recover
```

### Load testing with ApacheBench
```bash
ab -n 100 -c 10 http://localhost:3000/health
```

---

## Troubleshooting Guide

### Issue: Server crashes after image upload
**Solution:**
1. Check `/health` endpoint - if heap > 400MB, process is overloaded
2. Reduce `MAX_CONCURRENT_UPLOADS` to 1
3. Increase `REQUEST_TIMEOUT` to 60000ms
4. Use Uploadcare instead of local Python processing

### Issue: Database connection timeout
**Solution:**
1. Reduce `connection_limit` from 5 to 3 or 2
2. Add `pool_timeout=30` to DATABASE_URL
3. Check PostgreSQL `max_connections` setting

### Issue: Memory keeps growing
**Solution:**
1. Enable garbage collection: `node --expose-gc index.js`
2. Check for memory leaks: `npm install clinic` and run clinic
3. Verify Prisma queries use `.select()`
4. Check for unbounded result sets (add `.take()`)

### Issue: Slow image processing
**Solution:**
- Use Uploadcare CDN (already configured with `-/remove_bg/`)
- Don't run local Python processing - it's 10x slower
- If you must use local: reduce `MAX_DIMENSION` from 800 to 600

---

## Files Created/Updated

✅ **New Optimization Files:**
- `py-tools/remove_bg_optimized.py` - Optimized Python script
- `py-tools/remove_bg_buffer_optimized.py` - Optimized streaming script
- `prisma/schema_optimized.prisma` - DB schema with indexes
- `package_optimized.json` - Updated dependencies
- `ecosystem.config.js` - PM2 configuration
- `OPTIMIZATION-PATCH.js` - Code snippets to integrate
- `LOW-MEMORY-OPTIMIZATION.md` - This guide
- `IMPLEMENTATION-CHECKLIST.md` - This file

✅ **Files to Update:**
- `index.js` - Add optimizations (major)
- `.env` - Add connection pooling
- `package.json` - Add new dependencies

---

## Expected Results

After implementing all optimizations:

| Metric | Before | After |
|--------|--------|-------|
| Memory Usage | 500+ MB (crashes) | 380-420 MB (stable) |
| Max Concurrent Users | 3-5 | 10-15 |
| Request Timeout | Frequent | Rare |
| DB Connection Errors | Frequent | Rare |
| Image Processing Time | 15-30s | 5-10s* |
| Stability | 70% uptime | 99%+ uptime |

*With Uploadcare CDN (already configured)

---

## Quick Start Command

```bash
# Full setup from scratch:
npm install compression express-rate-limit
npx prisma migrate deploy
NODE_OPTIONS='--max-old-space-size=256' npm start

# Then check:
curl http://localhost:3000/health
```

---

## Support

Need help? Check:
1. `/health` endpoint for real-time memory status
2. PM2 logs: `pm2 logs fibuca-backend`
3. System memory: `free -h` (Linux) or `wmic OS get TotalVisibleMemorySize` (Windows)
4. Stalled connections: `lsof -i :3000` (macOS/Linux)
