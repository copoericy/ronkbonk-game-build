/**
 * Full theme media pipeline (Playwright + ffmpeg — works when Electron is blocked).
 * 1) ~10 min walkthrough MP4 per theme with game audio
 * 2) Screenshots per theme + one intro
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { prepareCaptureEnvironment } = require('./trailer-capture-utils');

const ROOT = path.join(__dirname, '..');

function electronWorks() {
    const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(electron)) return false;
    const r = spawnSync(electron, ['--version'], { encoding: 'utf8', timeout: 8000 });
    return r.status === 0 && !r.error;
}

prepareCaptureEnvironment();

if (electronWorks() && process.env.RONK_FORCE_ELECTRON === '1') {
    console.log('[capture-all] Using Electron capture pipeline…');
    const steps = ['capture-steam-screenshots.js', 'capture-trailer-full-walkthrough.js', 'stitch-theme-full-videos.js'];
    for (const script of steps) {
        const r = spawnSync(process.execPath, [path.join(__dirname, script)], {
            cwd: ROOT, stdio: 'inherit', env: { ...process.env, RONK_MARKETING_DIR: path.join(ROOT, 'steam-marketing') }
        });
        if (r.status !== 0) process.exit(r.status || 1);
    }
} else {
    console.log('[capture-all] Using Playwright capture (Electron unavailable or blocked)…');
    const r = spawnSync(process.execPath, [path.join(ROOT, '_theme_capture.js')], {
        cwd: ROOT, stdio: 'inherit'
    });
    if (r.status !== 0) process.exit(r.status || 1);
}

console.log('\n[capture-all] Complete.');
console.log('  Intro: steam-marketing/screenshots/common/00-intro-animation.png');
console.log('  Shots: steam-marketing/screenshots/<theme>/steam-*.png');
console.log('  Video: steam-marketing/trailer/full/<theme>-walkthrough.mp4');

