/**
 * Record full trailer clips (intro + menus + gameplay + spectate) per theme.
 * Output: steam-marketing/trailer/clips/<theme>/*.mp4
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { resolveRonkLauncher } = require('./resolve-ronk-launcher');
const { stopRunningRonkInstances } = require('./trailer-capture-utils');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'steam-marketing', 'trailer', 'clips');

stopRunningRonkInstances();

const extra = ['--trailer-batch-capture', '--trailer-force-recapture'];
const only = process.env.RONK_TRAILER_THEME || '';
if (only) extra.push(`--trailer-from-theme=${only}`, '--trailer-one-theme');

const launch = resolveRonkLauncher(extra, { preferDev: true });

console.log('[trailer] RonkBonk trailer clip capture (1920×1080)');
console.log('[trailer] Output:', OUT);
if (only) console.log('[trailer] Theme filter:', only);
console.log(`[trailer] Launcher: ${launch.label} (${launch.bin})`);

const result = spawnSync(launch.bin, launch.args, {
    cwd: launch.cwd,
    stdio: 'inherit',
    shell: false,
    env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        RONK_MARKETING_DIR: path.join(ROOT, 'steam-marketing')
    }
});

if (result.error) {
    console.error('[trailer] Failed to start:', result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 0);
