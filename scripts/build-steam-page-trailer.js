/**
 * Build Steam-page trailer from captured MP4 clips + screenshot stills.
 * Uses high-quality stills for scenes that under-captured (skills/jokers).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLIPS = path.join(ROOT, 'steam-marketing', 'trailer', 'clips');
const STILLS = path.join(ROOT, 'steam-marketing', 'steam-page');
const OUT_DIR = path.join(ROOT, 'steam-marketing', 'trailer');
const WORK = path.join(OUT_DIR, '_work');
const OUT_MP4 = path.join(OUT_DIR, 'RonkBonk_Steam_Trailer.mp4');

function ffmpegBin() {
    const bundled = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(bundled)) return bundled;
    throw new Error('ffmpeg-static missing');
}

function exists(p) { return p && fs.existsSync(p); }

function clip(rel) {
    const p = path.join(CLIPS, ...`${rel}`.replace(/\.mp4$/, '').split('/')) + '.mp4';
    return exists(p) ? p : null;
}

function still(name) {
    const p = path.join(STILLS, name);
    return exists(p) ? p : null;
}

function run(args) {
    const r = spawnSync(ffmpegBin(), args, { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error((r.stderr || '').slice(-600) || 'ffmpeg failed');
    }
}

function stillToClip(png, outMp4, seconds = 3.5) {
    run([
        '-y', '-loop', '1', '-i', png,
        '-t', String(seconds),
        '-vf', `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,zoompan=z='min(zoom+0.0008,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(seconds * 30)}:s=1920x1080:fps=30`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-an', outMp4
    ]);
}

function normalizeClip(inMp4, outMp4) {
    run([
        '-y', '-i', inMp4,
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-an', outMp4
    ]);
}

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const parts = [];
let n = 0;
function addPart(label, src, { stillSeconds } = {}) {
    if (!src) {
        console.warn('[trailer] skip missing', label);
        return;
    }
    n += 1;
    const out = path.join(WORK, `${String(n).padStart(2, '0')}_${label}.mp4`);
    console.log('[trailer]', label, '←', path.basename(src));
    if (src.endsWith('.png')) stillToClip(src, out, stillSeconds || 3.2);
    else normalizeClip(src, out);
    parts.push(out);
}

// Storyboard for Steam page trailer (~60–90s)
addPart('intro', clip('common/00_intro'));
addPart('menu', clip('ronk/02_menu'));
addPart('loadout', clip('ronk/03_loadout'));
addPart('skills', still('10_skills.png') || clip('ronk/04_skills'), { stillSeconds: 3.5 });
addPart('jokers', still('11_jokers.png') || clip('ronk/05_jokers'), { stillSeconds: 3.5 });
addPart('gameplay', clip('ronk/06_gameplay'));
addPart('spectate', clip('ronk/07_spectate'));
addPart('pink', still('06_pinkcore_gameplay.png'), { stillSeconds: 3.0 });
addPart('hacker', still('07_hacker_gameplay.png'), { stillSeconds: 2.8 });
addPart('pixel', still('08_pixel_gameplay.png'), { stillSeconds: 2.8 });
addPart('online', still('12_online.png'), { stillSeconds: 3.0 });

if (parts.length < 4) {
    console.error('[trailer] Not enough parts to build');
    process.exit(1);
}

const listPath = path.join(WORK, 'concat.txt');
fs.writeFileSync(listPath, parts.map((p) => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n'));

run([
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    OUT_MP4
]);

const stat = fs.statSync(OUT_MP4);
console.log('[trailer] Saved', OUT_MP4, `(${(stat.size / 1024 / 1024).toFixed(1)} MB, ${parts.length} parts)`);
