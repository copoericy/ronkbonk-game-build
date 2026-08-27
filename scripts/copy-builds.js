/**
 * Copy electron-builder artifacts from steam-build/ into Desktop/output/archives.
 * Usage: node scripts/copy-builds.js [win|linux|mac|all]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'steam-build-fresh');
const BUILD_DIR_FALLBACK = path.join(ROOT, 'steam-build');
const OUT_ARCHIVES = path.join(ROOT, '..', 'output', 'archives');
const OUT_MAC = path.join(ROOT, '..', 'output', 'mac');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest) {
    ensureDir(path.dirname(dest));
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    if (process.platform === 'darwin') {
        execFileSync('ditto', [src, dest]);
        return;
    }
    fs.cpSync(src, dest, { recursive: true, force: true, dereference: true });
}

function findArtifact(pattern) {
    for (const dir of [BUILD_DIR, BUILD_DIR_FALLBACK]) {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const hit = entries
            .filter((e) => e.isFile() && !e.name.startsWith('._'))
            .filter((e) => pattern.test(e.name))
            .map((e) => path.join(dir, e.name))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        if (hit) return hit;
    }
    return null;
}

function copyWin() {
    const zip = findArtifact(/win64\.zip$/i) || findArtifact(/-win.*\.zip$/i);
    if (!zip) {
        console.warn('[copy-builds] No Windows zip in steam-build/');
        return;
    }
    ensureDir(OUT_ARCHIVES);
    const dest = path.join(OUT_ARCHIVES, path.basename(zip));
    fs.copyFileSync(zip, dest);
    console.log('[copy-builds] Windows ->', dest);
}

function copyLinux() {
    const tar = findArtifact(/linux64\.tar\.gz$/i) || findArtifact(/linux.*\.tar\.gz$/i);
    const appImage = findArtifact(/\.AppImage$/i);
    ensureDir(OUT_ARCHIVES);
    if (tar) {
        const dest = path.join(OUT_ARCHIVES, path.basename(tar));
        fs.copyFileSync(tar, dest);
        console.log('[copy-builds] Linux tar.gz ->', dest);
    }
    if (appImage) {
        const dest = path.join(OUT_ARCHIVES, path.basename(appImage));
        fs.copyFileSync(appImage, dest);
        console.log('[copy-builds] Linux AppImage ->', dest);
    }
    if (!tar && !appImage) console.warn('[copy-builds] No Linux artifact in steam-build/');
}

function copyMac() {
    const zip = findArtifact(/mac.*\.zip$/i) || findArtifact(/arm64\.zip$/i);
    if (zip) {
        ensureDir(OUT_ARCHIVES);
        const dest = path.join(OUT_ARCHIVES, path.basename(zip));
        fs.copyFileSync(zip, dest);
        console.log('[copy-builds] macOS zip ->', dest);
    }
    const unpacked = path.join(BUILD_DIR, 'mac-arm64', 'RonkBonk.app');
    const unpackedX64 = path.join(BUILD_DIR, 'mac', 'RonkBonk.app');
    const unpackedFresh = path.join(BUILD_DIR_FALLBACK, 'mac-arm64', 'RonkBonk.app');
    const unpackedFreshX64 = path.join(BUILD_DIR_FALLBACK, 'mac', 'RonkBonk.app');
    const appSrc = [unpacked, unpackedX64, unpackedFresh, unpackedFreshX64].find((p) => fs.existsSync(p)) || null;
    if (appSrc) {
        ensureDir(OUT_MAC);
        copyDir(appSrc, path.join(OUT_MAC, 'RonkBonk.app'));
        console.log('[copy-builds] macOS app ->', path.join(OUT_MAC, 'RonkBonk.app'));
    } else if (!zip) {
        console.warn('[copy-builds] No macOS artifact in steam-build/');
    }
}

const target = (process.argv[2] || 'all').toLowerCase();
if (target === 'win') copyWin();
else if (target === 'linux') copyLinux();
else if (target === 'mac') copyMac();
else {
    copyWin();
    copyLinux();
    copyMac();
}
