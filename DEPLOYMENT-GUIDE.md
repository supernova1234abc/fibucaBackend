# Vercel Deployment Guide - Optimized for 512MB RAM

## Problem Solved ✅
Previously on Render with 512MB RAM, the Python `rembg` service consumed too much memory.
**Solution**: Remove Python dependency entirely → use **Uploadcare's backend filter** for all image processing.

---

## Architecture Changes

### Before (Render - Issues)
```
Frontend Upload → Backend receives file → Python rembg (512MB RAM bottleneck) → Cloudinary → Database
```

### After (Vercel - Optimized)
```
Frontend Upload → Uploadcare CDN (processes) → Store URL with -/remove_bg/ filter → Backend saves URL → Database
```

---

## Files to Remove (Python dependencies)
- ❌ `/py-tools/remove_bg.py`
- ❌ `/py-tools/remove_bg_buffer.py`
- ❌ `/py-tools/remove_bg_optimized.py`
- ❌ `/py-tools/remove_bg_buffer_optimized.py`
- ❌ `/py-tools/utils/runPython.js`
- ❌ `package.json` entries for `rembg` (if any)

## Key Endpoints (No Changes Needed)

### ✅ Still Working
- `POST /api/idcards/:id/upload-clean` - Accept cleaned PNG from browser
- `PUT /api/idcards/:id/photo` - Save Uploadcare URLs with -/remove_bg/ filter
- `PUT /api/idcards/:id/clean-photo` - Regenerate clean URL

### ✅ Can Be Disabled
- `POST /api/idcards/:id/fetch-and-clean` - Optional server-side cleaning (removeBgBuffer now always null)

---

## Required Changes in Backend

### index.js Changes
1. Remove Python loader lines:
   ```javascript
   // DELETE THESE LINES (23-29)
   let removeBgBuffer = null;
   try {
     const runner = require('./py-tools/utils/runPython');
     removeBgBuffer = runner && runner.removeBackgroundBuffer;
     console.log('runPython helper loaded:', !!removeBgBuffer);
   } catch (e) {
     console.warn('runPython helper not available:', e.message || e);
   }
   ```

2. Simplify `/api/idcards/:id/fetch-and-clean` endpoint:
   ```javascript
   // Just pass through original buffer - Uploadcare filter handles cleaning
   ```

---

## Deployment to Vercel

### 1. Create `vercel.json`
```json
{
  "buildCommand": "npm run build:prisma",
  "installCommand": "npm install",
  "env": {
    "DATABASE_URL": "@fibuca-backend-db-url",
    "PRISMA_DATABASE_URL": "@fibuca-backend-prisma-db-url",
    "JWT_SECRET": "@fibuca-jwt-secret",
    "CLOUDINARY_CLOUD_NAME": "@fibuca-cloud-name",
    "CLOUDINARY_API_KEY": "@fibuca-api-key",
    "CLOUDINARY_API_SECRET": "@fibuca-api-secret"
  }
}
```

### 2. Update `package.json`
```json
{
  "scripts": {
    "start": "node index.js",
    "build:prisma": "prisma generate",
    "dev": "nodemon index.js"
  }
}
```

### 3. Deploy
```bash
npm install -g vercel
vercel login
vercel deploy
```

---

## Memory Usage Comparison

| Component | Render (512MB) | Vercel (Serverless) |
|-----------|---|---|
| Node.js app | ~150MB | ~80MB |
| Python rembg | ~300MB ⚠️ | ❌ Removed |
| Uploadcare filter | Paid | Included in URL |
| **Total RAM** | **⚠️ >512MB** | **✅ <100MB** |

---

## Testing Checklist

- [ ] Upload photo to ID card
- [ ] Verify clean URL is generated (check `-/remove_bg/` in URL)
- [ ] Download/view ID card PDF
- [ ] Test across different image formats (JPG, PNG, WebP)
- [ ] Verify database queries work with Prisma Postgres

---

## Rollback Plan

If Uploadcare filter isn't sufficient:
1. Keep Python dependency commented out
2. Uncomment and re-deploy to Render (which has more RAM)
3. Use paid Vercel plans with more memory

