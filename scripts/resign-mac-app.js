/**
 * Re-sign macOS .app after app.asar patch (patch invalidates electron-builder signatures).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const appPath = process.argv[2];

if (!appPath || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/resign-mac-app.js /path/to/RonkBonk.app');
  process.exit(1);
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

console.log('Re-signing macOS app:', appPath);

try {
  run(`xattr -cr "${appPath}"`);
} catch (_) {
  /* ignore */
}

const contents = path.join(appPath, 'Contents');
const frameworksDir = path.join(contents, 'Frameworks');
const mainBin = path.join(contents, 'MacOS', 'RonkBonk');

if (fs.existsSync(frameworksDir)) {
  for (const name of fs.readdirSync(frameworksDir)) {
    const item = path.join(frameworksDir, name);
    if (name.endsWith('.framework') || name.endsWith('.app')) {
      run(`codesign --force --sign - "${item}"`);
    }
  }
}

if (fs.existsSync(mainBin)) {
  run(`codesign --force --sign - "${mainBin}"`);
}

run(`codesign --deep --force --sign - "${appPath}"`);

try {
  run(`codesign --verify --deep --strict "${appPath}"`);
  console.log('Codesign verify: OK');
} catch (e) {
  console.warn('Codesign verify warning (app may still run):', e.message);
}

console.log('Done:', appPath);
