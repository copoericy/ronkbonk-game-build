/**
 * Resolve RonkBonk executable for capture/build scripts.
 * Prefers packaged builds; falls back to local Electron (Mac / Windows / Linux).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function electronDevBinary() {
    if (process.platform === 'darwin') {
        return path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    }
    if (process.platform === 'win32') {
        return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    }
    return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
}

const RONK_EXE_CANDIDATES = [
    path.join('d:', 'mysteamgame', 'windows', 'RonkBonk.exe'),
    path.join(ROOT, 'steam-build-fresh', 'win-unpacked', 'RonkBonk.exe'),
    path.join(ROOT, 'steam-build', 'win-unpacked', 'RonkBonk.exe'),
    path.join(ROOT, 'steam-build-fresh', 'mac-arm64', 'RonkBonk.app', 'Contents', 'MacOS', 'RonkBonk'),
    path.join(ROOT, 'steam-build-fresh', 'mac', 'RonkBonk.app', 'Contents', 'MacOS', 'RonkBonk'),
    electronDevBinary()
];

function resolveRonkLauncher(extraArgs = [], options = {}) {
    const preferDev = options.preferDev === true;
    const candidates = preferDev
        ? [...RONK_EXE_CANDIDATES].reverse()
        : RONK_EXE_CANDIDATES;

    for (let i = 0; i < candidates.length; i++) {
        const bin = candidates[i];
        if (!bin || !fs.existsSync(bin)) continue;

        const isPackaged = /RonkBonk(\.exe)?$/i.test(path.basename(bin));
        const isDevElectron = /Electron$/i.test(path.basename(bin)) || /electron(\.exe)?$/i.test(path.basename(bin));

        if (isPackaged) {
            return {
                bin,
                args: [...extraArgs],
                cwd: path.dirname(bin),
                label: 'RonkBonk',
                packaged: true
            };
        }

        if (isDevElectron) {
            return {
                bin,
                args: ['.', ...extraArgs, '--ronk-dev'],
                cwd: ROOT,
                label: 'RonkBonk (dev)',
                packaged: false
            };
        }
    }

    throw new Error('RonkBonk / Electron not found. Run npm install in game-source first.');
}

module.exports = { resolveRonkLauncher, RONK_EXE_CANDIDATES, electronDevBinary };
