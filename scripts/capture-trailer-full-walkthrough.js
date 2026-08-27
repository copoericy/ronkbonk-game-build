/**
 * Record ~10 min full walkthrough per theme (1920×1080 + game audio).
 * Clips: menu, loadout cube, skills, jokers, settings, online, gameplay, spectate.
 * Output: steam-marketing/trailer/clips/<theme>/*.mp4
 * Then run: npm run stitch:theme-videos
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { resolveRonkLauncher } = require('./resolve-ronk-launcher');
const { prepareCaptureEnvironment } = require('./trailer-capture-utils');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'steam-marketing', 'trailer', 'clips');

prepareCaptureEnvironment();

const extra = [
    '--trailer-batch-capture-full',
    '--trailer-force-recapture',
    '--trailer-with-audio'
];
const only = process.env.RONK_TRAILER_THEME || '';
if (only) extra.push(`--trailer-from-theme=${only}`, '--trailer-one-theme');

const launch = resolveRonkLauncher(extra, { preferDev: true });

console.log('[trailer-full] RonkBonk full theme walkthrough (~10 min/theme, 1920×1080 + audio)');
console.log('[trailer-full] Output clips:', OUT);
if (only) console.log('[trailer-full] Theme filter:', only);
console.log(`[trailer-full] Launcher: ${launch.label} (${launch.bin})`);

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
    console.error('[trailer-full] Failed to start:', result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 0);
