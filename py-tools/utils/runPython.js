// py-tools/utils/runPython.js
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function removeBackground(inputPath, outputPath, pythonPath) {
  // 1️⃣ Default to venv python if exists, else fallback to system python3
  const venvPython = pythonPath || path.join(__dirname, '../../venv/bin/python');
  const pythonExec = fs.existsSync(venvPython) ? venvPython : 'python3';

  if (pythonExec === 'python3') {
    console.warn('⚠️ Venv python not found, using system python3');
  }

  // 2️⃣ Use script path
  const scriptPath = path.join(__dirname, '../remove_bg.py');

  // 3️⃣ Ensure output folder exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    execFile(pythonExec, [scriptPath, inputPath, outputPath], (error, stdout, stderr) => {
      if (error) {
        console.error('❌ Python error:', error);
        console.error('📄 stderr:', stderr);
        return reject(error);
      }
      console.log('✅ Background removed:', outputPath);
      resolve(outputPath);
    });
  });
}

module.exports = { removeBackground };
