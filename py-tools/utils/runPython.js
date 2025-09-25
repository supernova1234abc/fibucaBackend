// py-tools/utils/runPython.js
const { spawn } = require('child_process');
const path = require('path');

async function removeBackgroundBuffer(fileBuffer, pythonPath) {
  // 1️⃣ Default to venv python if exists, else fallback to system python3
  const venvPython = pythonPath || path.join(__dirname, '../../venv/bin/python');
  const pythonExec = require('fs').existsSync(venvPython) ? venvPython : 'python3';

  if (pythonExec === 'python3') {
    console.warn('⚠️ Venv python not found, using system python3');
  }

  const scriptPath = path.join(__dirname, '../remove_bg_buffer.py');

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
        return reject(new Error(`Python exited with code ${code}`));
      }
      resolve(Buffer.concat(stdoutBuffers));
    });

    pyProcess.on('error', reject);

    // Write the input image buffer to Python stdin
    pyProcess.stdin.write(fileBuffer);
    pyProcess.stdin.end();
  });
}

module.exports = { removeBackgroundBuffer };
