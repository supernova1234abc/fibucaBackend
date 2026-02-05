// py-tools/utils/runPython.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function removeBackgroundBuffer(fileBuffer, pythonPath) {
  // 1️⃣ Default to venv python if exists, else fallback to system python3 / python
  const venvUnix = pythonPath || path.join(__dirname, '../../venv/bin/python');
  const venvWin = pythonPath || path.join(__dirname, '../../venv/Scripts/python.exe');
  let pythonExec = 'python3';
  if (fs.existsSync(venvUnix)) pythonExec = venvUnix;
  else if (fs.existsSync(venvWin)) pythonExec = venvWin;
  else if (process.platform === 'win32') pythonExec = 'python'; // fallback on Windows

  if (!fs.existsSync(venvUnix) && !fs.existsSync(venvWin)) {
    console.warn('⚠️ Venv python not found, using system python');
  }

  // ✅ Use optimized version for low-RAM systems (500MB limit)
  const scriptPath = path.join(__dirname, '../remove_bg_buffer_optimized.py');

  return new Promise((resolve, reject) => {
    const pyProcess = spawn(pythonExec, [scriptPath]);

    let stdoutBuffers = [];
    let stderrBuffers = [];

    pyProcess.stdout.on('data', (data) => stdoutBuffers.push(data));
    pyProcess.stderr.on('data', (data) => stderrBuffers.push(data));

    pyProcess.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrBuffers).toString();
        console.error('❌ Python failed:', stderr);
        return reject(new Error(`Python exited with code ${code}: ${stderr}`));
      }
      resolve(Buffer.concat(stdoutBuffers));
    });

    pyProcess.on('error', reject);

    // Write the input image buffer to Python stdin
    pyProcess.stdin.write(fileBuffer);
    pyProcess.stdin.end();
  });
}

async function removeBackgroundFile(inputPath, outputPath, pythonPath) {
  const venvUnix = pythonPath || path.join(__dirname, '../../venv/bin/python');
  const venvWin = pythonPath || path.join(__dirname, '../../venv/Scripts/python.exe');
  let pythonExec = 'python3';
  if (fs.existsSync(venvUnix)) pythonExec = venvUnix;
  else if (fs.existsSync(venvWin)) pythonExec = venvWin;
  else if (process.platform === 'win32') pythonExec = 'python';

  const scriptPath = path.join(__dirname, 'remove_bg_file.py');

  return new Promise((resolve, reject) => {
    const pyProcess = spawn(pythonExec, [scriptPath, inputPath, outputPath]);

    let stderrBuffers = [];

    pyProcess.stderr.on('data', (data) => stderrBuffers.push(data));

    pyProcess.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrBuffers).toString();
        console.error('❌ Python failed:', stderr);
        return reject(new Error(`Python exited with code ${code}: ${stderr}`));
      }
      resolve();
    });

    pyProcess.on('error', reject);
  });
}

module.exports = { removeBackgroundBuffer, removeBackgroundFile };