/**
 * Launch RonkBonk and auto-capture Steam store screenshots (1920×1080)
 * for every theme into steam-marketing/screenshots/<theme>/steam-01.png …
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { resolveRonkLauncher } = require('./resolve-ronk-launcher');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'steam-marketing', 'screenshots');

const launch = resolveRonkLauncher(['--steam-screenshot-mode', '--steam-batch-capture'], { preferDev: true });

console.log('[capture] Multi-theme Steam screenshot batch (1920×1080)');
console.log('[capture] Output:', OUT);
console.log('[capture] Themes: ronk, white-black, pinkcore, hacker, pixel (10 scenes each)');
console.log(`[capture] Launcher: ${launch.label} (${launch.bin})`);

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
    console.error('[capture] Failed to start:', result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 0);
