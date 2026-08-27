/**
 * Convert trailer .webm clips to .mp4 (when ffmpeg was missing during capture).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLIPS_DIR = 'd:\\mysteamgame\\trailer\\clips';

const FFMPEG_CANDIDATES = [
    process.env.FFMPEG_PATH,
    'ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages',
        'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-8.1.2-full_build', 'bin', 'ffmpeg.exe')
].filter(Boolean);

function resolveFfmpeg() {
    for (const candidate of FFMPEG_CANDIDATES) {
        if (candidate === 'ffmpeg') {
            const probe = spawnSync('where', ['ffmpeg'], { shell: true, encoding: 'utf8' });
            if (probe.status === 0 && probe.stdout.trim()) return 'ffmpeg';
            continue;
        }
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('ffmpeg not found — install via winget or set FFMPEG_PATH');
}

function convertWebmToMp4(ffmpeg, webmPath) {
    const mp4Path = webmPath.replace(/\.webm$/i, '.mp4');
    const ff = spawnSync(ffmpeg, [
        '-y', '-i', webmPath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-crf', '18', '-preset', 'medium',
        '-movflags', '+faststart',
        mp4Path
    ], { encoding: 'utf8' });

    if (ff.status !== 0 || !fs.existsSync(mp4Path)) {
        console.error('[convert]', path.basename(webmPath), 'FAILED', ff.stderr?.slice(0, 200));
        return false;
    }
    const mb = (fs.statSync(mp4Path).size / 1024 / 1024).toFixed(1);
    console.log('[convert]', path.basename(mp4Path), `${mb} MB`);
    try { fs.unlinkSync(webmPath); } catch (_) { /* keep webm */ }
    return true;
}

const ffmpeg = resolveFfmpeg();
console.log('[convert] Using', ffmpeg);

const webms = [];
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.webm$/i.test(entry.name)) webms.push(full);
    }
}
walk(CLIPS_DIR);

if (!webms.length) {
    console.log('[convert] No .webm files found.');
    process.exit(0);
}

let ok = 0;
for (const webm of webms) {
    if (convertWebmToMp4(ffmpeg, webm)) ok++;
}
console.log(`[convert] Done — ${ok}/${webms.length} converted`);
process.exit(ok === webms.length ? 0 : 1);
