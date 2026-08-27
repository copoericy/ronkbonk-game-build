/**
 * Build RonkBonk release into Desktop/output (archives + steam depot zip).
 *
 *   npm run build:output              — build Windows + package depot
 *   npm run build:output:package      — package only (uses existing archives)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, '..', 'output');
const ARCHIVES = path.join(OUTPUT, 'archives');
const skipBuild = process.argv.includes('--skip-build');

function run(cmd, label) {
    console.log(`\n[build-output] ${label}\n> ${cmd}\n`);
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true });
}

function writeReadme() {
    const pkg = require(path.join(ROOT, 'package.json'));
    const stamp = new Date().toISOString();
    const cacheMatch = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/game\.js\?v=(\d+)/);
    const cache = cacheMatch ? cacheMatch[1] : 'unknown';
    const text = `RONKBONK — OUTPUT (LATEST BUILD)
Version: ${pkg.version}
Built: ${stamp}
Cache bust: ${cache}

Copy this entire folder to your new computer.

PLAY — macOS: double-click output/mac/RonkBonk.app
  Windows: unzip archives/RonkBonk-1.0.0-windows.zip and run RonkBonk.exe
  Linux:   extract archives/RonkBonk-1.0.0-linux64.tar.gz

STEAM UPLOAD (App 4887920 / Depot 4887921):
  1. Run: cd game-source && npm run build:steam:zip
  2. Upload: output/steam/RonkBonk-Depot-4887921.zip via Steamworks HTTP
     OR use steamcmd with output/steam/steampipe-config/app_build.vdf
  3. Publish in Steamworks → Publish tab

Rebuild: cd game-source && npm run build:output
`;
    fs.writeFileSync(path.join(OUTPUT, 'README.txt'), text);

    ensureArchives();
    fs.writeFileSync(path.join(ARCHIVES, 'BUILD_STAMP.txt'), `Built: ${stamp}\nCache bust: ${cache}\n`);
}

function ensureArchives() {
    fs.mkdirSync(ARCHIVES, { recursive: true });
}

function main() {
    ensureArchives();
    if (!skipBuild) {
        run('npm run build:win', 'Building Windows x64 (electron-builder)');
    } else {
        console.log('[build-output] --skip-build: using existing archives');
    }
    run('node scripts/package-steam-depot-zip.js', 'Packaging Steam depot zip');
    writeReadme();
    console.log('\n[build-output] Complete. See Desktop/output/README.txt');
}

main();
