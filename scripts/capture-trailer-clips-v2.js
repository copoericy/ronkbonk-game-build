/**
 * Record RonkBonk trailer clips V2 — adds new MP4s alongside existing ones.
 * No gameplay. Skills/jokers show many at once. Two spectate clips per theme.
 *
 * Output: d:\mysteamgame\trailer\clips\<theme>\
 *   04_skills_all.mp4, 05_jokers_all.mp4, 07_spectate_a.mp4, 08_spectate_b.mp4
 */
const { spawnSync } = require('child_process');
const { resolveRonkLauncher } = require('./resolve-ronk-launcher');
const { stopRunningRonkInstances } = require('./trailer-capture-utils');

stopRunningRonkInstances();
const launch = resolveRonkLauncher(['--trailer-batch-capture-v2'], { preferDev: true });

console.log('[trailer-v2] RonkBonk — supplemental MP4 clips (keeps old files)');
console.log('[trailer-v2] No gameplay · skills/jokers grid · 2× spectate per theme');
console.log('[trailer-v2] Output: d:\\mysteamgame\\trailer\\clips\\<theme>\\04_skills_all.mp4 …');
console.log('[trailer-v2] Close RonkBonk first. Requires ffmpeg on PATH.');
console.log(`[trailer-v2] Launcher: ${launch.label} (${launch.bin})`);

const result = spawnSync(launch.bin, launch.args, {
    cwd: launch.cwd,
    stdio: 'inherit',
    shell: false
});

if (result.error) {
    console.error('[trailer-v2] Failed to start RonkBonk:', result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 0);
