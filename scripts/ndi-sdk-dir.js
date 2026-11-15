// Resolves the NDI SDK include directory for binding.gyp.
// Order: NDI_SDK_DIR env, then the default Windows SDK install location.
const fs = require('fs');
const path = require('path');

const candidates = [
  process.env.NDI_SDK_DIR,
  'C:/Program Files/NDI/NDI 6 SDK',
  '/Library/NDI SDK for Apple',
  '/usr/share/ndi-sdk',
].filter(Boolean);

for (const dir of candidates) {
  const inc = path.join(dir, 'Include');
  const incLower = path.join(dir, 'include');
  for (const p of [inc, incLower]) {
    if (fs.existsSync(path.join(p, 'Processing.NDI.Lib.h'))) {
      process.stdout.write(p.replace(/\\/g, '/'));
      process.exit(0);
    }
  }
}
console.error('NDI SDK not found. Set NDI_SDK_DIR to your NDI 6 SDK folder.');
process.exit(1);
