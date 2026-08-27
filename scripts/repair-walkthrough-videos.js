/**
 * Re-encode theme walkthrough MP4s so Windows Photos / Movies & TV play normally.
 *
 * Broken captures often have sparse keyframes + odd timestamps → scrubber / playback
 * jumps ~1 minute at a time. This forces CFR 30fps, short GOP, fresh PTS.
 *
 * Run: node scripts/repair-walkthrough-videos.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FULL = path.join(ROOT, 'steam-marketing', 'trailer', 'full');
const BACKUP = path.join(ROOT, 'steam-marketing', 'trailer', 'full', '_pre-repair');

function ffmpegBin() {
    const win = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    if (fs.existsSync(win)) return win;
    const unix = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(unix)) return unix;
    return 'ffmpeg';
}

function run(args) {
    const r = spawnSync(ffmpegBin(), args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (r.status !== 0) {
        throw new Error((r.stderr || r.stdout || '').slice(-1200) || 'ffmpeg failed');
    }
}

fs.mkdirSync(FULL, { recursive: true });
fs.mkdirSync(BACKUP, { recursive: true });

const files = fs.readdirSync(FULL).filter((f) => f.endsWith('-walkthrough.mp4'));
if (!files.length) {
    console.error('[repair] No *-walkthrough.mp4 in', FULL);
    process.exit(1);
}

console.log(`[repair] Re-encoding ${files.length} walkthrough(s) for normal playback…`);
for (const name of files) {
    const src = path.join(FULL, name);
    const bak = path.join(BACKUP, name);
    const tmp = path.join(FULL, `${name}.repair.tmp.mp4`);
    if (!fs.existsSync(bak)) {
        fs.copyFileSync(src, bak);
        console.log(`[repair] Backup → ${bak}`);
    }
    console.log(`[repair] ${name}…`);
    // CFR 30, keyframe every ~1s, regenerate timestamps — plays smoothly in Windows apps
    run([
        '-y',
        '-fflags', '+genpts+igndts',
        '-i', src,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vf', 'fps=30,format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-profile:v', 'high',
        '-level', '4.1',
        '-g', '30',
        '-keyint_min', '30',
        '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '160k',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart',
        '-vsync', 'cfr',
        tmp
    ]);
    fs.renameSync(tmp, src);
    const mb = (fs.statSync(src).size / (1024 * 1024)).toFixed(1);
    console.log(`[repair] OK ${name} (${mb} MB)`);
}
console.log('[repair] Done. Originals kept in', BACKUP);
