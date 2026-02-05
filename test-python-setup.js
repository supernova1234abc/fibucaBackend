#!/usr/bin/env node

/**
 * Test script to verify Python background removal setup
 * Run: node test-python-setup.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🧪 Testing Python Background Removal Setup...\n');

// Step 1: Check Python
console.log('1️⃣  Checking Python installation...');
const pythonCheck = spawn('python', ['--version']);

let pythonVersion = '';
pythonCheck.stdout.on('data', (data) => {
  pythonVersion = data.toString().trim();
  console.log(`   ✅ Found: ${pythonVersion}`);
});

pythonCheck.stderr.on('data', (data) => {
  pythonVersion = data.toString().trim();
  console.log(`   ✅ Found: ${pythonVersion}`);
});

pythonCheck.on('close', (code) => {
  if (code === 0) {
    console.log('   ✅ Python is available\n');
    checkRembg();
  } else {
    console.log('   ❌ Python not found!\n');
    console.log('   Install Python from: https://www.python.org/\n');
    process.exit(1);
  }
});

function checkRembg() {
  console.log('2️⃣  Checking rembg installation...');
  
  const rembgCheck = spawn('python', ['-c', 'import rembg; print("rembg found")']);
  
  let foundRembg = false;
  rembgCheck.stdout.on('data', (data) => {
    console.log(`   ✅ ${data.toString().trim()}`);
    foundRembg = true;
  });

  rembgCheck.stderr.on('data', (data) => {
    if (!foundRembg) {
      console.log('   ❌ rembg not installed!\n');
      console.log('   Run: pip install rembg\n');
    }
  });

  rembgCheck.on('close', (code) => {
    if (code === 0) {
      console.log('   ✅ rembg is installed\n');
      checkOptimizedScript();
    } else {
      console.log('   ⚠️  rembg installation failed\n');
      process.exit(1);
    }
  });
}

function checkOptimizedScript() {
  console.log('3️⃣  Checking optimized script...');
  
  const scriptPath = path.join(__dirname, 'py-tools', 'remove_bg_buffer_optimized.py');
  
  if (fs.existsSync(scriptPath)) {
    console.log(`   ✅ Found: ${scriptPath}\n`);
    checkRunPython();
  } else {
    console.log(`   ❌ Not found: ${scriptPath}\n`);
    process.exit(1);
  }
}

function checkRunPython() {
  console.log('4️⃣  Checking runPython.js...');
  
  const runPythonPath = path.join(__dirname, 'py-tools', 'utils', 'runPython.js');
  
  if (fs.existsSync(runPythonPath)) {
    console.log(`   ✅ Found: ${runPythonPath}\n`);
    checkBackendIndex();
  } else {
    console.log(`   ❌ Not found: ${runPythonPath}\n`);
    process.exit(1);
  }
}

function checkBackendIndex() {
  console.log('5️⃣  Checking backend integration...');
  
  const indexPath = path.join(__dirname, 'index.js');
  
  if (!fs.existsSync(indexPath)) {
    console.log(`   ❌ Not found: ${indexPath}\n`);
    process.exit(1);
  }
  
  const content = fs.readFileSync(indexPath, 'utf8');
  
  if (content.includes('removeBackgroundBuffer')) {
    console.log(`   ✅ Backend imports removeBackgroundBuffer\n`);
    checkEnvironment();
  } else {
    console.log(`   ❌ Backend not configured to use removeBackgroundBuffer\n`);
    process.exit(1);
  }
}

function checkEnvironment() {
  console.log('6️⃣  Checking environment variables...');
  
  require('dotenv').config();
  
  const required = [
    'DATABASE_URL',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'JWT_SECRET'
  ];
  
  let missing = [];
  
  required.forEach(env => {
    if (process.env[env]) {
      console.log(`   ✅ ${env}`);
    } else {
      console.log(`   ⚠️  ${env} (optional for testing)`);
      missing.push(env);
    }
  });
  
  console.log('\n');
  
  if (missing.length > 0) {
    console.log(`   ℹ️  Missing: ${missing.join(', ')}`);
    console.log('   (These are needed for full functionality)\n');
  }
  
  showSummary();
}

function showSummary() {
  console.log('='.repeat(60));
  console.log('✅ SETUP VERIFICATION COMPLETE');
  console.log('='.repeat(60));
  console.log('\n');
  
  console.log('Your backend is ready to use optimized Python background removal!');
  console.log('\n');
  
  console.log('Next steps:');
  console.log('1. Set up environment variables in .env file');
  console.log('2. Run: npm install');
  console.log('3. Run: npm start');
  console.log('4. Test with: curl -X POST http://localhost:3000/api/idcards/1/fetch-and-clean \\');
  console.log('     -H "Content-Type: application/json" \\');
  console.log('     -H "Authorization: Bearer TOKEN" \\');
  console.log('     -d \'{\"rawPhotoUrl\":\"https://example.com/photo.jpg\"}\'');
  console.log('\n');
  
  console.log('Documentation:');
  console.log('- PYTHON-SETUP.md - Detailed setup guide');
  console.log('- PYTHON-REMBG-RESTORED.md - What changed');
  console.log('\n');
}
