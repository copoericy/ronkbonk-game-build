/**
 * Refresh macOS RonkBonk.app game content with the newest app.asar from a fresh Win/Linux build.
 * Electron Framework stays from the last available Mac shell (cannot rebuild Mac on Windows).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FRESH_ASAR = path.join(ROOT, 'steam-build-fresh', 'win-unpacked', 'resources', 'app.asar');
const FRESH_UNPACKED = path.join(ROOT, 'steam-build-fresh', 'win-unpacked', 'resources', 'app.asar.unpacked');

const MAC_CANDIDATES = [
    path.join(ROOT, '..', 'output', 'mac', 'RonkBonk.app'),
    path.join('d:\\mysteamgame', 'mac', 'RonkBonk.app'),
    path.join(ROOT, 'steam-build-fresh', 'mac-arm64', 'RonkBonk.app'),
    path.join(ROOT, 'steam-build', 'mac-arm64', 'RonkBonk.app')
];

function findMacApp() {
    for (const app of MAC_CANDIDATES) {
        const bin = path.join(app, 'Contents', 'MacOS', 'RonkBonk');
        if (fs.existsSync(bin)) return app;
    }
    return null;
}

function main() {
    if (!fs.existsSync(FRESH_ASAR)) {
        throw new Error('Missing fresh app.asar — build Windows first');
    }
    const srcApp = findMacApp();
    if (!srcApp) throw new Error('No existing RonkBonk.app shell found to patch');

    const destApp = path.join(ROOT, 'steam-build-fresh', 'mac-arm64', 'RonkBonk.app');
    fs.mkdirSync(path.dirname(destApp), { recursive: true });
    if (path.resolve(srcApp) !== path.resolve(destApp)) {
        if (fs.existsSync(destApp)) fs.rmSync(destApp, { recursive: true, force: true });
        fs.cpSync(srcApp, destApp, { recursive: true, force: true });
    }

    const res = path.join(destApp, 'Contents', 'Resources');
    fs.mkdirSync(res, { recursive: true });
    fs.copyFileSync(FRESH_ASAR, path.join(res, 'app.asar'));
    const unpackedDest = path.join(res, 'app.asar.unpacked');
    if (fs.existsSync(unpackedDest)) fs.rmSync(unpackedDest, { recursive: true, force: true });
    if (fs.existsSync(FRESH_UNPACKED)) {
        fs.cpSync(FRESH_UNPACKED, unpackedDest, { recursive: true, force: true });
    }

    // Mirror into Desktop/output/mac for depot packaging.
    const outMac = path.join(ROOT, '..', 'output', 'mac', 'RonkBonk.app');
    fs.mkdirSync(path.dirname(outMac), { recursive: true });
    if (fs.existsSync(outMac)) fs.rmSync(outMac, { recursive: true, force: true });
    fs.cpSync(destApp, outMac, { recursive: true, force: true });

    const mb = (fs.statSync(path.join(res, 'app.asar')).size / (1024 * 1024)).toFixed(1);
    console.log('[patch-mac] Shell:', srcApp);
    console.log('[patch-mac] Wrote asar', mb, 'MB ->', destApp);
    console.log('[patch-mac] Mirrored ->', outMac);
    console.log('[patch-mac] NOTE: Electron Framework not rebuilt on Windows; game assets match Win/Linux.');
}

main();
