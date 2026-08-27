/**
 * Capture white-black theme menu/loadout marble background for marketing art.
 * Output: d:\mysteamgame\art\white-black_background.png (1920×1080)
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const args = ['.', '--art-background-capture', '--ronk-dev'];

console.log('[capture-wb-background] Capturing white-black theme background (1920×1080)…');
console.log('[capture-wb-background] Output: d:\\mysteamgame\\art\\white-black_background.png');

const result = spawnSync(electronBin, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
});

if (result.error) {
    console.error('[capture-wb-background] Failed to start Electron:', result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 0);
