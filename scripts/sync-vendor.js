/** Copy bundled runtime assets from node_modules into vendor/ for Electron + Steam builds. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const vendorDir = path.join(ROOT, 'vendor');
const peerSrc = path.join(ROOT, 'node_modules', 'peerjs', 'dist', 'peerjs.min.js');
const peerDest = path.join(vendorDir, 'peerjs.min.js');

if (!fs.existsSync(peerSrc)) {
    console.error('[sync-vendor] Missing peerjs — run: npm install');
    process.exit(1);
}

fs.mkdirSync(vendorDir, { recursive: true });
fs.copyFileSync(peerSrc, peerDest);
console.log('[sync-vendor] vendor/peerjs.min.js');
