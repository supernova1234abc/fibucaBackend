
const { execFile } = require('child_process');
const path = require('path');

function removeBackground(inputPath, outputPath) {
  const scriptPath = path.join(__dirname, '../remove_bg.py');

  return new Promise((resolve, reject) => {
execFile('python3', [scriptPath, inputPath, outputPath], (error, stdout, stderr) => {
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

