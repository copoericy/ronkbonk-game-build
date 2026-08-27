/**
 * Export transparent loadout cube art for Steam / marketing compositing.
 *
 * Renders ONLY the spinning loadout 3D cube (Canvas 2D, same as loadout page)
 * onto an offscreen transparent canvas — no UI, no background, no game changes.
 *
 * Export-only gray (#888888) at 3/4 isometric angle (ry=π/4, rx=0.52, rz=0.12).
 *
 * Output (1024×1024 RGBA): d:\mysteamgame\art\cube\
 *   cube_gray_transparent.png
 *   cube_ronk_transparent.png
 *   cube_white-black_transparent.png
 *   cube_pinkcore_transparent.png
 *   cube_hacker_transparent.png
 *   cube_pixel_transparent.png
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const args = ['.', '--cube-art-capture', '--ronk-dev'];

console.log('[capture-cube-art] Exporting loadout cube art (transparent PNG, 1024×1024, gray #888888)…');
console.log('[capture-cube-art] Output: d:\\mysteamgame\\art\\cube\\cube_gray_transparent.png + cube_<theme>_transparent.png');
console.log('[capture-cube-art] Themes: ronk, white-black, pinkcore, hacker, pixel');

const result = spawnSync(electronBin, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
});

if (result.error) {
    console.error('[capture-cube-art] Failed to start Electron:', result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 0);
