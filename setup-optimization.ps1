# 🚀 FIBUCA BACKEND - OPTIMIZATION SETUP (WINDOWS)
# Run this PowerShell script to implement optimizations

Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  🚀 FIBUCA BACKEND OPTIMIZATION       ║" -ForegroundColor Cyan
Write-Host "║  Low-RAM Deployment Script (500MB)    ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ===== STEP 1: DEPENDENCIES =====
Write-Host "📦 Step 1: Installing dependencies..." -ForegroundColor Yellow
npm install compression express-rate-limit
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to install dependencies" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Dependencies installed" -ForegroundColor Green
Write-Host ""

# ===== STEP 2: ENVIRONMENT =====
Write-Host "⚙️  Step 2: Setting up environment..." -ForegroundColor Yellow
if (!(Test-Path ".env")) {
    Write-Host "Creating .env from template..."
    Copy-Item ".env.template" ".env"
    Write-Host "⚠️  Update .env with your actual values!" -ForegroundColor Yellow
} else {
    Write-Host "✅ .env already exists" -ForegroundColor Green
}
Write-Host ""

# ===== STEP 3: DATABASE MIGRATION =====
Write-Host "🗄️  Step 3: Running database migration..." -ForegroundColor Yellow
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  Trying migrate dev..." -ForegroundColor Yellow
    npx prisma migrate dev --name init
}
Write-Host "✅ Database migrated" -ForegroundColor Green
Write-Host ""

# ===== STEP 4: GENERATE PRISMA CLIENT =====
Write-Host "🔧 Step 4: Generating Prisma client..." -ForegroundColor Yellow
npx prisma generate
Write-Host "✅ Prisma client generated" -ForegroundColor Green
Write-Host ""

# ===== STEP 5: VERIFY SETUP =====
Write-Host "✔️  Step 5: Verifying setup..." -ForegroundColor Yellow
$nodeVersion = & node -v
$npmVersion = & npm -v
Write-Host "   - Node version: $nodeVersion"
Write-Host "   - npm version: $npmVersion"
Write-Host "✅ Setup verified" -ForegroundColor Green
Write-Host ""

# ===== STEP 6: START SERVER OPTIONS =====
Write-Host "🚀 Step 6: Ready to start server!" -ForegroundColor Green
Write-Host ""
Write-Host "Use one of these commands:" -ForegroundColor Cyan
Write-Host ""
Write-Host "1️⃣  Development (with memory limit):" -ForegroundColor White
Write-Host '   $env:NODE_OPTIONS="--max-old-space-size=256"; npm run dev' -ForegroundColor Gray
Write-Host ""
Write-Host "2️⃣  Production (with memory limit):" -ForegroundColor White
Write-Host '   $env:NODE_OPTIONS="--max-old-space-size=256"; npm start' -ForegroundColor Gray
Write-Host ""
Write-Host "3️⃣  With PM2 (recommended for production):" -ForegroundColor White
Write-Host "   npm install -g pm2" -ForegroundColor Gray
Write-Host "   pm2 start ecosystem.config.js" -ForegroundColor Gray
Write-Host "   pm2 logs fibuca-backend" -ForegroundColor Gray
Write-Host ""
Write-Host "4️⃣  With Docker:" -ForegroundColor White
Write-Host "   docker-compose -f docker-compose.optimized.yml up" -ForegroundColor Gray
Write-Host ""

# ===== STEP 7: MONITORING =====
Write-Host "📊 Step 7: Monitoring" -ForegroundColor Yellow
Write-Host ""
Write-Host "After server starts, in another PowerShell run:" -ForegroundColor Cyan
Write-Host ""
Write-Host "   curl http://localhost:3000/health | ConvertFrom-Json" -ForegroundColor Gray
Write-Host ""
Write-Host "Expected: heap memory < 350MB" -ForegroundColor Cyan
Write-Host ""
Write-Host "✅ Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "🎯 NEXT STEPS:" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Update .env with your database credentials:" -ForegroundColor White
Write-Host "   notepad .env" -ForegroundColor Gray
Write-Host ""
Write-Host "2. Review and integrate OPTIMIZATION-PATCH.js into index.js" -ForegroundColor White
Write-Host "   (30 minutes)" -ForegroundColor Gray
Write-Host ""
Write-Host "3. Deploy using one of the commands above" -ForegroundColor White
Write-Host ""
Write-Host "4. Monitor memory usage:" -ForegroundColor White
Write-Host "   # In PowerShell, create a monitoring loop:" -ForegroundColor Gray
Write-Host "   while(1) { cls; curl http://localhost:3000/health | ConvertFrom-Json | Select memory; Start-Sleep 2 }" -ForegroundColor Gray
Write-Host ""
Write-Host "📚 Documentation:" -ForegroundColor Cyan
Write-Host "   - Quick start: QUICK-REFERENCE.md" -ForegroundColor White
Write-Host "   - Step-by-step: IMPLEMENTATION-CHECKLIST.md" -ForegroundColor White
Write-Host "   - Code changes: OPTIMIZATION-PATCH.js" -ForegroundColor White
Write-Host "   - Visual guide: VISUAL-GUIDE.md" -ForegroundColor White
Write-Host ""

# Optional: Ask if user wants to start the server
$answer = Read-Host "Do you want to start the server now? (y/n)"
if ($answer -eq "y" -or $answer -eq "Y") {
    Write-Host ""
    Write-Host "Starting server with optimized settings..." -ForegroundColor Green
    Write-Host '(Set NODE_OPTIONS=--max-old-space-size=256)' -ForegroundColor Yellow
    $env:NODE_OPTIONS = "--max-old-space-size=256"
    npm start
} else {
    Write-Host ""
    Write-Host "To start the server later, run:" -ForegroundColor Cyan
    Write-Host '   $env:NODE_OPTIONS="--max-old-space-size=256"; npm start' -ForegroundColor Gray
    Write-Host ""
}
