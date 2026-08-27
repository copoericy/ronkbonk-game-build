const fs = require('fs');
const { spawnSync, execSync } = require('child_process');

/** Processes that draw FPS/GPU overlays on top of the desktop capture region */
const OVERLAY_PROCESSES = [
    'RTSS',
    'RTSSHooksLoader64',
    'RTSSHooksLoader',
    'MSIAfterburner',
    'EncoderServer',
    'NVIDIA Share',
    'nvsphelper64',
    'PresentMon'
];

function killPerformanceOverlays() {
    if (process.platform !== 'win32') return;
    const list = OVERLAY_PROCESSES.map((n) => `'${n}'`).join(', ');
    try {
        execSync(
            `$names = @(${list}); foreach ($n in $names) { Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }`,
            { shell: 'powershell.exe', stdio: 'ignore' }
        );
    } catch (_) { /* none running */ }
    console.log('[trailer-capture] Performance overlays disabled (RTSS/Afterburner/NVIDIA)');
}

function stopRunningRonkInstances() {
    try {
        if (process.platform === 'win32') {
            execSync(
                'Get-Process RonkBonk -ErrorAction SilentlyContinue | Stop-Process -Force',
                { shell: 'powershell.exe', stdio: 'ignore' }
            );
        } else {
            // Do not pkill all Electron (would kill Cursor). Only packaged RonkBonk / our capture argv.
            execSync('pkill -f "RonkBonk" 2>/dev/null || true', { stdio: 'ignore', shell: '/bin/bash' });
            execSync('pkill -f "steam-batch-capture|trailer-batch-capture|steam-screenshot-mode" 2>/dev/null || true', {
                stdio: 'ignore',
                shell: '/bin/bash'
            });
        }
    } catch (_) { /* no running instances */ }
    if (process.platform === 'win32') {
        spawnSync('powershell.exe', ['-Command', 'Start-Sleep -Seconds 2'], { stdio: 'ignore' });
    } else {
        spawnSync('sleep', ['2'], { stdio: 'ignore' });
    }
}

function prepareCaptureEnvironment() {
    stopRunningRonkInstances();
    killPerformanceOverlays();
}

function validateClipFile(filePath, label) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size < 200000) {
            return { ok: false, reason: `too_small:${Math.round(stat.size / 1024)}KB` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err.message || 'missing' };
    }
}

module.exports = {
    stopRunningRonkInstances,
    killPerformanceOverlays,
    prepareCaptureEnvironment,
    validateClipFile
};
