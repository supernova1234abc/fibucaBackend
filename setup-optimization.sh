#!/bin/bash
# 🚀 FIBUCA BACKEND - OPTIMIZATION SCRIPTS
# Run these commands step by step to implement optimizations

set -e  # Exit on error

echo "╔════════════════════════════════════════╗"
echo "║  🚀 FIBUCA BACKEND OPTIMIZATION       ║"
echo "║  Low-RAM Deployment Script (500MB)    ║"
echo "╚════════════════════════════════════════╝"
echo ""

# ===== STEP 1: DEPENDENCIES =====
echo "📦 Step 1: Installing dependencies..."
npm install compression express-rate-limit
echo "✅ Dependencies installed"
echo ""

# ===== STEP 2: ENVIRONMENT =====
echo "⚙️  Step 2: Setting up environment..."
if [ ! -f .env ]; then
    echo "Creating .env from template..."
    cp .env.template .env
    echo "⚠️  Update .env with your actual values!"
fi
echo "✅ Environment configured"
echo ""

# ===== STEP 3: DATABASE MIGRATION =====
echo "🗄️  Step 3: Running database migration..."
npx prisma migrate deploy || npx prisma migrate dev --name init
echo "✅ Database migrated"
echo ""

# ===== STEP 4: GENERATE PRISMA CLIENT =====
echo "🔧 Step 4: Generating Prisma client..."
npx prisma generate
echo "✅ Prisma client generated"
echo ""

# ===== STEP 5: VERIFY SETUP =====
echo "✔️  Step 5: Verifying setup..."
echo "   - Node version: $(node -v)"
echo "   - npm version: $(npm -v)"
echo "   - PostgreSQL client: $(which psql || echo 'Not installed (optional)')"
echo "✅ Setup verified"
echo ""

# ===== STEP 6: START SERVER =====
echo "🚀 Step 6: Starting server..."
echo ""
echo "Use one of these commands:"
echo ""
echo "1️⃣  Development (with memory limit):"
echo "   NODE_OPTIONS='--max-old-space-size=256' npm run dev"
echo ""
echo "2️⃣  Production (with memory limit):"
echo "   NODE_OPTIONS='--max-old-space-size=256' npm start"
echo ""
echo "3️⃣  With PM2 (recommended for production):"
echo "   npm install -g pm2"
echo "   pm2 start ecosystem.config.js"
echo "   pm2 logs fibuca-backend"
echo ""
echo "4️⃣  With Docker:"
echo "   docker-compose -f docker-compose.optimized.yml up"
echo ""

# ===== STEP 7: MONITORING =====
echo "📊 Step 7: Monitoring"
echo ""
echo "After server starts, in another terminal run:"
echo ""
echo "   curl http://localhost:3000/health | jq"
echo ""
echo "Expected output:"
echo "   {\"status\": \"OK\", \"memory\": {\"heapUsedMB\": <250-300>, ...}}"
echo ""
echo "✅ Setup complete!"
echo ""
echo "═══════════════════════════════════════════════════════"
echo "🎯 NEXT STEPS:"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "1. Update .env with your database credentials:"
echo "   nano .env"
echo ""
echo "2. Review and integrate OPTIMIZATION-PATCH.js into index.js"
echo "   (30 minutes)"
echo ""
echo "3. Deploy using one of the commands above"
echo ""
echo "4. Monitor memory usage:"
echo "   watch -n 2 'curl -s http://localhost:3000/health | jq'"
echo ""
echo "📚 Documentation:"
echo "   - Quick start: QUICK-REFERENCE.md"
echo "   - Step-by-step: IMPLEMENTATION-CHECKLIST.md"
echo "   - Code changes: OPTIMIZATION-PATCH.js"
echo "   - Visual guide: VISUAL-GUIDE.md"
echo ""
