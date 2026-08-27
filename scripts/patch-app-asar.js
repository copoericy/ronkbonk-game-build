/**
 * Patch app.asar in d:\mysteamgame (windows/linux/mac) from game-source.
 * Syncs changed game files into _depot_asar_patch staging, repacks, and deploys.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGING = path.join(ROOT, '_depot_asar_patch');
const DEPOT_ROOT = 'd:\\mysteamgame';

const SYNC_FILES = [
    'main.js',
    'package.json',
    'index.html',
    'game.js',
    'intro-animation.js',
    'steam-bridge.js',
    'steam-achievements.js',
    'vendor/peerjs.min.js',
    'anti-cheat.js',
    'content-safety.js',
    'protection.js',
    'style.css',
    'ui-refinement.css',
    'theme-ambience.css',
    'theme-trailer-capture.css',
    'theme-windows.css',
    'COPYRIGHT.txt',
    'STEAM_REVIEWER_NOTES.txt',
    'STEAM_RESUBMIT_NOTES.txt',
    'README_STEAM_UPLOAD.txt',
    'tron.mp3',
    'My Movie 1.mp3',
    'top.mp3',
    'heck.mp3',
    'Pixelville.mp3',
    'gggg.mp3',
    'ai_learning/ai_logic.js',
    'assets/ui/cloud-btn.png',
    'steam_appid.txt'
];

/** Huge legacy WAVs must not ship — game plays .mp3 only */
const STAGING_REMOVE = [
    'tron.wav',
    'top.wav',
    'heck.wav',
    'gggg.wav'
];

const ASAR_TARGETS = [
    path.join(DEPOT_ROOT, 'windows', 'resources', 'app.asar'),
    path.join(DEPOT_ROOT, 'linux', 'resources', 'app.asar'),
    path.join(DEPOT_ROOT, 'mac', 'RonkBonk.app', 'Contents', 'Resources', 'app.asar'),
    path.join(ROOT, '_steam_pack', 'windows', 'resources', 'app.asar'),
    path.join(ROOT, '_steam_pack', 'linux', 'resources', 'app.asar'),
    path.join(ROOT, '_steam_pack', 'mac', 'RonkBonk.app', 'Contents', 'Resources', 'app.asar'),
    path.join(ROOT, 'steam-build-fresh', 'win-unpacked', 'resources', 'app.asar'),
    path.join(ROOT, 'steam-build-fresh', 'linux-unpacked', 'resources', 'app.asar'),
    path.join(ROOT, 'steam-build', 'win-unpacked', 'resources', 'app.asar'),
    path.join(ROOT, 'steam-build', 'linux-unpacked', 'resources', 'app.asar'),
    path.join(ROOT, '..', 'output', 'mac', 'RonkBonk.app', 'Contents', 'Resources', 'app.asar'),
    path.join(ROOT, '..', 'output', 'steam', 'depot-staging-fresh', 'windows', 'resources', 'app.asar'),
    path.join(ROOT, '..', 'output', 'steam', 'depot-staging-fresh', 'linux', 'resources', 'app.asar'),
    path.join(ROOT, '..', 'output', 'steam', 'depot-staging-fresh', 'mac', 'RonkBonk.app', 'Contents', 'Resources', 'app.asar'),
    path.join(ROOT, '..', 'output', 'steam', 'depot-staging', 'windows', 'resources', 'app.asar'),
    path.join(ROOT, '..', 'output', 'steam', 'depot-staging', 'linux', 'resources', 'app.asar'),
    path.join(ROOT, '..', 'output', 'steam', 'depot-staging', 'mac', 'RonkBonk.app', 'Contents', 'Resources', 'app.asar')
];

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

function syncToStaging() {
    if (!fs.existsSync(STAGING)) {
        throw new Error(`Missing staging dir: ${STAGING}`);
    }
    for (const rel of SYNC_FILES) {
        const src = path.join(ROOT, rel);
        const dest = path.join(STAGING, rel);
        if (!fs.existsSync(src)) {
            console.warn('[patch] Skip missing source:', rel);
            continue;
        }
        copyFile(src, dest);
        console.log('[patch] Synced ->', rel);
    }
    for (const rel of STAGING_REMOVE) {
        const dest = path.join(STAGING, rel);
        if (fs.existsSync(dest)) {
            fs.unlinkSync(dest);
            console.log('[patch] Removed stale ->', rel);
        }
    }
}

function packAsar(outFile) {
    ensureDir(path.dirname(outFile));
    const asarBin = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
    if (!fs.existsSync(asarBin)) {
        throw new Error('Missing @electron/asar — run npm install in game-source');
    }
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    execSync(
        `node "${asarBin}" pack "${STAGING}" "${outFile}" --unpack-dir "{node_modules/steamworks.js/**,scripts/**}"`,
        { stdio: 'inherit', shell: true }
    );
    const mb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(2);
    console.log('[patch] Packed app.asar (' + mb + ' MB) ->', outFile);
}

function deployAsar(srcAsar) {
    for (const dest of ASAR_TARGETS) {
        if (!fs.existsSync(path.dirname(dest))) {
            console.warn('[patch] Skip missing platform dir:', dest);
            continue;
        }
        try {
            copyFile(srcAsar, dest);
            console.log('[patch] Deployed ->', dest);
        } catch (err) {
            console.warn('[patch] Skip deploy (', err.code || err.message, '):', dest);
        }
    }
}

function main() {
    syncToStaging();
    const tmpAsar = path.join(ROOT, '_depot_asar_patch_app.asar');
    packAsar(tmpAsar);
    deployAsar(tmpAsar);
    if (fs.existsSync(tmpAsar)) fs.unlinkSync(tmpAsar);
    console.log('[patch] Done — app.asar updated on all available platforms.');
}

main();
