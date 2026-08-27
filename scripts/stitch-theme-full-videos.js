/**
 * Stitch per-theme full walkthrough clips into one ~10 min MP4 (with audio).
 * Input:  steam-marketing/trailer/clips/<theme>/02_menu.mp4 … 09_spectate.mp4
 * Output: steam-marketing/trailer/full/<theme>-walkthrough.mp4
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLIPS = path.join(ROOT, 'steam-marketing', 'trailer', 'clips');
const OUT_DIR = path.join(ROOT, 'steam-marketing', 'trailer', 'full');
const WORK = path.join(ROOT, 'steam-marketing', 'trailer', '_work', 'full-stitch');

const THEMES = ['ronk', 'white-black', 'pinkcore', 'hacker', 'pixel'];
const CLIP_ORDER = [
    '02_menu', '03_loadout', '04_skills', '05_jokers',
    '06_settings', '07_online', '08_gameplay', '09_spectate'
];

function ffmpegBin() {
    const bundled = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    if (fs.existsSync(bundled)) return bundled;
    const bundledUnix = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(bundledUnix)) return bundledUnix;
    throw new Error('ffmpeg-static missing — run npm install in game folder');
}

function run(args) {
    const r = spawnSync(ffmpegBin(), args, { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error((r.stderr || r.stdout || '').slice(-800) || 'ffmpeg failed');
    }
}

function stitchTheme(theme) {
    const parts = [];
    for (const clip of CLIP_ORDER) {
        const p = path.join(CLIPS, theme, `${clip}.mp4`);
        if (!fs.existsSync(p) || fs.statSync(p).size < 50000) {
            console.warn(`[stitch-full] Skip missing ${theme}/${clip}.mp4`);
            continue;
        }
        parts.push(p);
    }
    if (!parts.length) {
        console.warn(`[stitch-full] No clips for theme ${theme}`);
        return false;
    }

    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const listPath = path.join(WORK, `${theme}-concat.txt`);
    const listBody = parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listBody);

    const outPath = path.join(OUT_DIR, `${theme}-walkthrough.mp4`);
    console.log(`[stitch-full] ${theme}: ${parts.length} clips → ${outPath}`);

    run([
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-fflags', '+genpts',
        '-vf', 'fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-vsync', 'cfr',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        outPath
    ]);

    const stat = fs.statSync(outPath);
    console.log(`[stitch-full] OK ${theme} — ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    return true;
}

const filter = process.env.RONK_TRAILER_THEME || '';
const themes = filter ? THEMES.filter((t) => t === filter) : THEMES;
let ok = 0;
for (const theme of themes) {
    if (stitchTheme(theme)) ok += 1;
}
console.log(`[stitch-full] Done — ${ok}/${themes.length} walkthrough MP4s in ${OUT_DIR}`);
