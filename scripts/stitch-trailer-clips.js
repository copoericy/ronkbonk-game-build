/**
 * Stitch trailer frames into MP4 clips — original game speed (uses meta.json per clip).
 * Requires ffmpeg on PATH.
 *
 * Input:  d:\mysteamgame\trailer\frames\<theme>\<clip>\frame_*.png + meta.json
 * Output: d:\mysteamgame\trailer\clips\<theme>\<clip>.mp4
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TRAILER_DIR = 'd:\\mysteamgame\\trailer';
const FRAMES_DIR = path.join(TRAILER_DIR, 'frames');
const CLIPS_DIR = path.join(TRAILER_DIR, 'clips');

const THEMES = ['ronk', 'white-black', 'pinkcore', 'hacker', 'pixel'];
const CLIP_NAMES = ['01_intro', '02_menu', '03_loadout', '04_skills', '05_jokers', '06_gameplay', '07_spectate'];

function hasFfmpeg() {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', shell: true });
    return r.status === 0;
}

function findClipDirs() {
    const found = [];
    if (!fs.existsSync(FRAMES_DIR)) return found;

    for (const theme of THEMES) {
        for (const clip of CLIP_NAMES) {
            const rel = `${theme}/${clip}`;
            const inDir = path.join(FRAMES_DIR, theme, clip);
            if (fs.existsSync(inDir) && fs.readdirSync(inDir).some((f) => f.startsWith('frame_') && f.endsWith('.png'))) {
                found.push(rel);
            }
        }
    }

    // Legacy flat layout (no theme subfolder)
    for (const clip of CLIP_NAMES) {
        const inDir = path.join(FRAMES_DIR, clip);
        if (fs.existsSync(inDir) && fs.readdirSync(inDir).some((f) => f.startsWith('frame_') && f.endsWith('.png'))) {
            found.push(clip);
        }
    }

    return found;
}

function readInputFps(inDir) {
    const metaPath = path.join(inDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta.inputFps > 0) return meta.inputFps;
            if (meta.frameCount && meta.durationMs) {
                return meta.frameCount / (meta.durationMs / 1000);
            }
        } catch (_) { /* fallback */ }
    }
    const frames = fs.readdirSync(inDir).filter((f) => f.startsWith('frame_') && f.endsWith('.png'));
    return Math.max(1, frames.length / 10);
}

function stitchClip(relPath) {
    const inDir = path.join(FRAMES_DIR, ...relPath.split('/'));
    const pattern = path.join(inDir, 'frame_%05d.png');
    if (!fs.existsSync(inDir)) {
        console.warn('[stitch] Skip (no dir):', relPath);
        return false;
    }
    const frames = fs.readdirSync(inDir).filter((f) => f.startsWith('frame_') && f.endsWith('.png'));
    if (!frames.length) {
        console.warn('[stitch] Skip (empty):', relPath);
        return false;
    }

    const inputFps = readInputFps(inDir);
    const outDir = path.join(CLIPS_DIR, path.dirname(relPath));
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(CLIPS_DIR, `${relPath.replace(/\//g, path.sep)}.mp4`);

    const args = [
        '-y',
        '-framerate', String(inputFps.toFixed(4)),
        '-i', pattern,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-crf', '18',
        '-preset', 'medium',
        '-movflags', '+faststart',
        outPath
    ];
    console.log('[stitch]', relPath, `(${frames.length} frames @ ${inputFps.toFixed(2)} fps input) →`, outPath);
    const r = spawnSync('ffmpeg', args, { stdio: 'inherit', shell: true });
    if (r.status !== 0) {
        console.error('[stitch] ffmpeg failed for', relPath);
        return false;
    }
    const stat = fs.statSync(outPath);
    console.log('[stitch] OK', relPath, `${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    return true;
}

function stitchAll() {
    if (!hasFfmpeg()) {
        console.error('[stitch] ffmpeg not found. Install: winget install Gyan.FFmpeg');
        process.exit(1);
    }
    const clips = findClipDirs();
    if (!clips.length) {
        console.error('[stitch] No frame folders found in', FRAMES_DIR);
        process.exit(1);
    }
    let ok = 0;
    for (const rel of clips) {
        if (stitchClip(rel)) ok += 1;
    }
    console.log(`[stitch] Done — ${ok}/${clips.length} clips in ${CLIPS_DIR}`);
    console.log('[stitch] Original game speed preserved via meta.json timing.');
}

stitchAll();
