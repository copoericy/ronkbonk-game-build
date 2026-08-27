const { app, BrowserWindow, ipcMain, screen, Menu, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const STEAM_SCREENSHOT_WIDTH = 1920;
const STEAM_SCREENSHOT_HEIGHT = 1080;

/** Cross-platform marketing output (was hard-coded to d:\mysteamgame\ on Windows). */
const MARKETING_ROOT = process.env.RONK_MARKETING_DIR
    ? path.resolve(process.env.RONK_MARKETING_DIR)
    : path.join(__dirname, 'steam-marketing');
const STEAM_SCREENSHOT_DIR = path.join(MARKETING_ROOT, 'screenshots');
const TRAILER_DIR = path.join(MARKETING_ROOT, 'trailer');
const LOADOUT_CUBE_ART_DIR = path.join(MARKETING_ROOT, 'art', 'cube');
const ART_SCREENSHOT_DIR = path.join(MARKETING_ROOT, 'art');

app.setName('RonkBonk');
if (typeof process.title === 'string') process.title = 'RonkBonk';
if (process.platform === 'win32') {
    app.setAppUserModelId('com.copoeric.ronkbonk');
}

// Capture tools must not collide with a Steam-running RonkBonk instance lock.
const isMarketingCaptureLaunch = () => process.argv.some((arg) =>
    arg === '--steam-screenshot-mode'
    || arg === '--steam-batch-capture'
    || arg === '--trailer-capture'
    || arg === '--trailer-batch-capture'
    || arg === '--trailer-batch-capture-v2'
    || arg === '--trailer-batch-capture-hq'
    || arg === '--trailer-batch-capture-full'
    || arg === '--trailer-obs-capture'
    || arg === '--export-loadout-cube'
    || arg === '--cube-art-capture'
    || arg === '--art-background-capture'
);
if (isMarketingCaptureLaunch()) {
    try {
        app.setPath('userData', path.join(app.getPath('temp'), 'ronkbonk-marketing-capture'));
    } catch (_) { /* app path may already be locked in rare cases */ }
}

const STEAM_APP_ID = 4887920;
const PROGRESS_CLOUD_FILE = 'ronk_unlock_progress.dat';

let mainWindow = null;
/** @type {'fullscreen'|'windowed'} */
let displayMode = 'fullscreen';
/** Ignore leave-full-screen while we programmatically change display mode. */
let programmaticDisplayChange = false;
let displayTransitionTimer = null;

function beginDisplayTransition(ms = 700) {
    programmaticDisplayChange = true;
    if (displayTransitionTimer) clearTimeout(displayTransitionTimer);
    displayTransitionTimer = setTimeout(() => {
        programmaticDisplayChange = false;
        displayTransitionTimer = null;
    }, ms);
}

function hasLowGfxFlag() {
    return process.argv.some((arg) => arg === '--ronk-low-gfx');
}

function isSteamScreenshotMode() {
    return process.argv.some((arg) => arg === '--steam-screenshot-mode');
}

function isSteamBatchCapture() {
    return process.argv.some((arg) => arg === '--steam-batch-capture');
}

function isExportLoadoutCubeMode() {
    return process.argv.some((arg) => arg === '--export-loadout-cube' || arg === '--cube-art-capture');
}

function isArtBackgroundCaptureMode() {
    return process.argv.some((arg) => arg === '--art-background-capture');
}

function isTrailerObsCapture() {
    return process.argv.some((arg) => arg === '--trailer-obs-capture');
}

function isTrailerCaptureMode() {
    return process.argv.some((arg) =>
        arg === '--trailer-capture'
        || arg === '--trailer-batch-capture'
        || arg === '--trailer-batch-capture-v2'
        || arg === '--trailer-batch-capture-hq'
        || arg === '--trailer-batch-capture-full'
        || arg === '--trailer-obs-capture');
}

function isTrailerBatchCapture() {
    return process.argv.some((arg) =>
        arg === '--trailer-batch-capture'
        || arg === '--trailer-batch-capture-v2'
        || arg === '--trailer-batch-capture-hq'
        || arg === '--trailer-batch-capture-full'
        || arg === '--trailer-obs-capture');
}

function isTrailerBatchCaptureV2() {
    return process.argv.some((arg) =>
        arg === '--trailer-batch-capture-v2'
        || arg === '--trailer-batch-capture-hq'
        || arg === '--trailer-batch-capture-full'
        || arg === '--trailer-obs-capture');
}

function isTrailerBatchCaptureFull() {
    return process.argv.some((arg) => arg === '--trailer-batch-capture-full');
}

function isTrailerBatchCaptureHQ() {
    return process.argv.some((arg) =>
        arg === '--trailer-batch-capture-hq'
        || arg === '--trailer-batch-capture-full'
        || arg === '--trailer-obs-capture');
}

function isTrailerForceRecapture() {
    return process.argv.some((arg) => arg === '--trailer-force-recapture');
}

function isTrailerOneTheme() {
    return process.argv.some((arg) => arg === '--trailer-one-theme');
}

function getTrailerStartThemeArg() {
    const arg = process.argv.find((a) => a.startsWith('--trailer-from-theme='));
    return arg ? arg.split('=')[1] : '';
}

const TRAILER_WIDTH = 1920;
const TRAILER_HEIGHT = 1080;
const TRAILER_FPS = 60;
const TRAILER_CAPTURE_DIR = path.join(TRAILER_DIR, 'clips', '_capture');
const TRAILER_REQUEST_FILE = path.join(TRAILER_CAPTURE_DIR, 'request.json');
const TRAILER_ACK_FILE = path.join(TRAILER_CAPTURE_DIR, 'ack.json');

function ensureSteamScreenshotDir() {
    fs.mkdirSync(STEAM_SCREENSHOT_DIR, { recursive: true });
}

function resolveSteamScreenshotPath(filename) {
    const outName = filename || `steam-${String(++steamScreenshotCounter).padStart(2, '0')}.png`;
    const outPath = path.join(STEAM_SCREENSHOT_DIR, outName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    return { outName, outPath };
}

function applySteamScreenshotWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    beginDisplayTransition(500);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
    mainWindow.setMinimumSize(STEAM_SCREENSHOT_WIDTH, STEAM_SCREENSHOT_HEIGHT);
    if (isTrailerCaptureMode()) {
        mainWindow.setContentSize(TRAILER_WIDTH, TRAILER_HEIGHT);
    } else {
        mainWindow.setSize(STEAM_SCREENSHOT_WIDTH, STEAM_SCREENSHOT_HEIGHT);
    }
    mainWindow.center();
    mainWindow.webContents.setZoomFactor(1);
    displayMode = 'windowed';
    broadcastDisplayMode();
}

function getTrailerCaptureRect() {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const bounds = mainWindow.getContentBounds();
    return {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
    };
}

function applyTrailerCaptureWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    beginDisplayTransition(300);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setFullScreen(false);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setMinimumSize(TRAILER_WIDTH, TRAILER_HEIGHT);
    mainWindow.setContentSize(TRAILER_WIDTH, TRAILER_HEIGHT);
    mainWindow.center();
    mainWindow.webContents.setZoomFactor(1);
    const bounds = mainWindow.getContentBounds();
    if (bounds.width !== TRAILER_WIDTH || bounds.height !== TRAILER_HEIGHT) {
        mainWindow.setBounds({
            x: bounds.x,
            y: bounds.y,
            width: TRAILER_WIDTH,
            height: TRAILER_HEIGHT
        });
        mainWindow.center();
    }
    mainWindow.show();
    focusGameWindow();
    displayMode = 'windowed';
    broadcastDisplayMode();
}

// Unlock high refresh: always disable GPU vsync (not only low-gfx / trailer).
// Does not change look/SFX — just lets RAF run above 60 on 100–165Hz displays.
app.commandLine.appendSwitch('disable-gpu-vsync');
try {
    app.commandLine.appendSwitch('force_high_performance_gpu');
} catch (_) { /* ignore */ }
if (hasLowGfxFlag()) {
    // Extra low-end path already covered by vsync off above
}

const isProductionBuild = app.isPackaged && !process.argv.includes('--ronk-dev');

function hardenBrowserWindow(win) {
    if (!win || !isProductionBuild) return;
    win.webContents.on('devtools-opened', () => {
        win.webContents.closeDevTools();
    });
    win.webContents.on('context-menu', (event) => {
        event.preventDefault();
    });
    win.webContents.on('before-input-event', (event, input) => {
        const key = (input.key || '').toLowerCase();
        if (isSteamScreenshotMode() && key === 'f9') return;
        if (key === 'f12') event.preventDefault();
        if (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c')) event.preventDefault();
        if (input.control && (key === 'u' || key === 's')) event.preventDefault();
    });
}

// Prefer process reuse — fewer Chromium processes = less RAM on 8GB Macs
if (typeof app.allowRendererProcessReuse === 'boolean') {
    app.allowRendererProcessReuse = true;
}

// Memory budget helpers — no visual/audio quality change, just smaller Chromium caches
try {
    // Cap HTTP/disk cache so Steam/Electron builds don't hoard hundreds of MB
    app.commandLine.appendSwitch('disk-cache-size', String(48 * 1024 * 1024));
    // Avoid spawning extra renderers for unused targets
    app.commandLine.appendSwitch('renderer-process-limit', '3');
    // Drop unused feature services that add idle process RAM
    app.commandLine.appendSwitch('disable-features', 'BackForwardCache,MediaSessionService,CalculateNativeWinOcclusion');
} catch (_) { /* ignore */ }

// Capture / trailer tools need uncapped timers. Normal play must NOT force that —
// on 8GB MacBooks it keeps Chromium awake and burns RAM/CPU in the background.
const keepRendererHot = typeof isMarketingCaptureLaunch === 'function' && isMarketingCaptureLaunch();
if (keepRendererHot) {
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-background-timer-throttling');
}
if (isTrailerCaptureMode()) {
    app.commandLine.appendSwitch('force-device-scale-factor', '1');
    app.commandLine.appendSwitch('high-dpi-support', '1');
}
if (isTrailerBatchCaptureHQ()) {
    app.commandLine.appendSwitch('disable-gpu-vsync');
    app.commandLine.appendSwitch('force_high_performance_gpu');
}

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder');
}

try {
    const steamworks = require('steamworks.js');
    steamworks.electronEnableSteamOverlay();

    // Capture / marketing launches must stay in this Electron process — do not
    // redirect to the Steam-installed build via restartAppIfNecessary.
    const skipSteamRelaunch = isSteamScreenshotMode()
        || isSteamBatchCapture()
        || isTrailerCaptureMode()
        || isExportLoadoutCubeMode()
        || isArtBackgroundCaptureMode()
        || process.argv.includes('--ronk-dev');

    if (!skipSteamRelaunch && steamworks.restartAppIfNecessary(STEAM_APP_ID)) {
        app.quit();
    } else {
        global.__ronkSteamClient = steamworks.init(STEAM_APP_ID);
        global.__ronkSteamInitError = null;
        try {
            console.log('[Steam] Logged in as', global.__ronkSteamClient.localplayer.getName());
        } catch (_) {
            console.log('[Steam] Client initialized');
        }
        // Soft ownership: packaged retail without a live Steam session blocks online.
        // --ronk-dev / capture flags keep local play + tooling working.
        global.__ronkSteamOwnershipBlocked = false;
        if (isProductionBuild && !global.__ronkSteamClient) {
            global.__ronkSteamOwnershipBlocked = true;
        }
    }
} catch (err) {
    global.__ronkSteamInitError = err.message || String(err);
    global.__ronkSteamClient = null;
    // Packaged retail: Steam unavailable / not owned → soft-gate online only
    global.__ronkSteamOwnershipBlocked = !!(app.isPackaged
        && !process.argv.includes('--ronk-dev')
        && !isSteamScreenshotMode()
        && !isSteamBatchCapture()
        && !isTrailerCaptureMode()
        && !isExportLoadoutCubeMode()
        && !isArtBackgroundCaptureMode());
    console.warn('[Steam] Init skipped:', global.__ronkSteamInitError);
    if (global.__ronkSteamOwnershipBlocked) {
        console.warn('[Steam] Ownership soft-gate ON — online blocked; launch via Steam.');
    }
}

function focusGameWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'win32' && typeof mainWindow.moveTop === 'function') {
        mainWindow.moveTop();
    }
}

function displayModeLabel(mode) {
    if (mode === 'windowed') {
        return { label: 'WINDOW', title: 'Click for fullscreen (ESC does not change display mode)' };
    }
    return { label: 'FULLSCREEN', title: 'Click for windowed mode (ESC only pauses — does not leave fullscreen)' };
}

function broadcastDisplayMode() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const payload = { mode: displayMode, ...displayModeLabel(displayMode) };
    mainWindow.webContents.send('display-mode-changed', {
        ...payload,
        fullscreen: displayMode === 'fullscreen'
    });
}

function ensureStartupFullscreen() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    displayMode = 'fullscreen';
    try {
        mainWindow.setAlwaysOnTop(false);
    } catch (_) { /* ignore */ }
    mainWindow.show();
    focusGameWindow();
    const goFullscreen = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
            if (typeof mainWindow.isFullScreen === 'function' && mainWindow.isFullScreen()) {
                displayMode = 'fullscreen';
                broadcastDisplayMode();
                return;
            }
            // Prefer true fullscreen — do not setBounds first (that exits fullscreen into a small window)
            if (typeof mainWindow.maximize === 'function') {
                try { mainWindow.maximize(); } catch (_) { /* ignore */ }
            }
            mainWindow.setFullScreen(true);
        } catch (_) { /* ignore */ }
        displayMode = 'fullscreen';
        broadcastDisplayMode();
        focusGameWindow();
    };
    goFullscreen();
    setTimeout(goFullscreen, 120);
    setTimeout(goFullscreen, 400);
    setTimeout(goFullscreen, 900);
    setTimeout(focusGameWindow, 250);
    setTimeout(focusGameWindow, 900);
}

function applyFullscreenMode() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    beginDisplayTransition(800);
    displayMode = 'fullscreen';
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
    const bounds = screen.getPrimaryDisplay().bounds;
    mainWindow.setBounds(bounds);
    mainWindow.show();
    setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.setFullScreen(true);
        displayMode = 'fullscreen';
        broadcastDisplayMode();
        focusGameWindow();
    }, 280);
}

function applyWindowedMode() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    beginDisplayTransition(600);
    // Preference flips first so leave-full-screen does not bounce us back
    displayMode = 'windowed';
    broadcastDisplayMode();
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
    setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.setSize(1280, 720);
        mainWindow.center();
        displayMode = 'windowed';
        broadcastDisplayMode();
        focusGameWindow();
    }, 180);
}

function applyDisplayMode(mode) {
    if (!mainWindow || mainWindow.isDestroyed()) return displayMode;
    if (mode === 'fullscreen') {
        applyFullscreenMode();
    } else {
        applyWindowedMode();
    }
    return displayMode;
}

function cycleDisplayMode() {
    applyDisplayMode(displayMode === 'fullscreen' ? 'windowed' : 'fullscreen');
    return displayMode;
}

function createWindow() {
    const trailerMode = isTrailerCaptureMode();
    const specialCaptureMode = trailerMode
        || isSteamScreenshotMode()
        || isArtBackgroundCaptureMode()
        || isExportLoadoutCubeMode();
    mainWindow = new BrowserWindow({
        width: trailerMode ? TRAILER_WIDTH : 1280,
        height: trailerMode ? TRAILER_HEIGHT : 720,
        minWidth: trailerMode ? TRAILER_WIDTH : 800,
        minHeight: trailerMode ? TRAILER_HEIGHT : 450,
        useContentSize: trailerMode,
        frame: !trailerMode,
        backgroundColor: '#000000',
        title: 'RonkBonk',
        // Start fullscreen on Win / Mac / Linux for normal play.
        fullscreen: !specialCaptureMode,
        fullscreenable: true,
        simpleFullscreen: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            // Allow Chromium to idle when unfocused — big win on 8GB unified memory
            backgroundThrottling: !keepRendererHot
        },
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'icon', 'icon.png'),
        show: false
    });

    const loadQuery = {};
    if (hasLowGfxFlag()) loadQuery.launch = 'low';
    if (isSteamScreenshotMode()) loadQuery.steamScreenshot = '1';
    if (isSteamBatchCapture()) loadQuery.steamBatch = '1';
    if (isExportLoadoutCubeMode()) loadQuery.exportLoadoutCube = '1';
    if (isArtBackgroundCaptureMode()) loadQuery.artBackgroundCapture = '1';
    if (isTrailerCaptureMode()) loadQuery.trailerCapture = '1';
    if (isTrailerBatchCapture()) loadQuery.trailerBatch = '1';
    if (isTrailerBatchCaptureV2()) loadQuery.trailerBatchV2 = '1';
    if (isTrailerBatchCaptureHQ()) loadQuery.trailerBatchHQ = '1';
    if (isTrailerBatchCaptureFull()) loadQuery.trailerBatchFull = '1';
    if (isTrailerObsCapture()) loadQuery.trailerObsCapture = '1';
    if (isTrailerForceRecapture()) loadQuery.trailerForceRecapture = '1';
    if (isTrailerOneTheme()) loadQuery.trailerOneTheme = '1';
    const fromTheme = getTrailerStartThemeArg();
    if (fromTheme) loadQuery.trailerFromTheme = fromTheme;
    const loadOpts = Object.keys(loadQuery).length ? { query: loadQuery } : {};
    mainWindow.loadFile('index.html', loadOpts);
    hardenBrowserWindow(mainWindow);

    mainWindow.on('page-title-updated', (event) => {
        event.preventDefault();
        if (!mainWindow.isDestroyed()) mainWindow.setTitle('RonkBonk');
    });

    const revealMainWindow = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (isExportLoadoutCubeMode()) {
            return;
        }
        if (isTrailerCaptureMode()) {
            displayMode = 'windowed';
            applySteamScreenshotWindow();
            mainWindow.show();
            focusGameWindow();
            broadcastDisplayMode();
            return;
        }
        if (isArtBackgroundCaptureMode()) {
            displayMode = 'windowed';
            applySteamScreenshotWindow();
            mainWindow.show();
            focusGameWindow();
            broadcastDisplayMode();
            return;
        }
        if (isSteamScreenshotMode()) {
            displayMode = 'windowed';
            applySteamScreenshotWindow();
            mainWindow.show();
            focusGameWindow();
            broadcastDisplayMode();
            return;
        }
        ensureStartupFullscreen();
    };

    mainWindow.once('ready-to-show', revealMainWindow);

    // Fallback: some GPU/Steam overlay combos never fire ready-to-show while show:false
    mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
            console.warn('[Window] ready-to-show missed — forcing show');
            revealMainWindow();
        }, 3000);
    });

    mainWindow.on('show', () => {
        if (!programmaticDisplayChange) focusGameWindow();
    });

    mainWindow.on('enter-full-screen', () => {
        displayMode = 'fullscreen';
        broadcastDisplayMode();
    });

    // ESC / OS must NOT leave fullscreen — only the FULLSCREEN/WINDOW button does.
    // Accidental leave snaps back when preference is still fullscreen.
    mainWindow.on('leave-full-screen', () => {
        if (programmaticDisplayChange) return;
        if (displayMode === 'fullscreen') {
            setTimeout(() => {
                if (!mainWindow || mainWindow.isDestroyed()) return;
                if (displayMode !== 'fullscreen') return;
                if (typeof mainWindow.isFullScreen === 'function' && mainWindow.isFullScreen()) return;
                beginDisplayTransition(500);
                try { mainWindow.setFullScreen(true); } catch (_) { /* ignore */ }
                broadcastDisplayMode();
                focusGameWindow();
            }, 16);
            return;
        }
        broadcastDisplayMode();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

ipcMain.handle('get-client-shield', () => ({
    packaged: app.isPackaged,
    devMode: !isProductionBuild,
    ownershipBlocked: !!global.__ronkSteamOwnershipBlocked
}));

ipcMain.handle('agent-debug-log', (_event, line) => {
    try {
        const payload = String(line || '').trim();
        if (!payload) return { ok: true };
        const row = payload + '\n';
        const fp = path.join(__dirname, 'debug-736746.log');
        const fpCursor = path.join(__dirname, '.cursor', 'debug-736746.log');
        fs.appendFileSync(fp, row);
        fs.mkdirSync(path.dirname(fpCursor), { recursive: true });
        fs.appendFileSync(fpCursor, row);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
    }
});

ipcMain.handle('get-steam-ownership', () => ({
    blocked: !!global.__ronkSteamOwnershipBlocked,
    steamReady: !!global.__ronkSteamClient,
    initError: global.__ronkSteamInitError || null
}));

ipcMain.handle('get-display-mode', () => ({
    mode: displayMode,
    fullscreen: displayMode === 'fullscreen',
    ...displayModeLabel(displayMode)
}));

ipcMain.handle('cycle-display-mode', () => {
    cycleDisplayMode();
    return {
        mode: displayMode,
        fullscreen: displayMode === 'fullscreen',
        ...displayModeLabel(displayMode)
    };
});

ipcMain.handle('set-display-mode', (_event, mode) => {
    if (mode === 'fullscreen' || mode === 'windowed') {
        applyDisplayMode(mode);
    }
    return {
        mode: displayMode,
        fullscreen: displayMode === 'fullscreen',
        ...displayModeLabel(displayMode)
    };
});

ipcMain.handle('get-fullscreen', () => ({
    mode: displayMode,
    fullscreen: displayMode === 'fullscreen'
}));

ipcMain.handle('toggle-fullscreen', () => {
    cycleDisplayMode();
    return {
        mode: displayMode,
        fullscreen: displayMode === 'fullscreen'
    };
});

ipcMain.handle('set-fullscreen', (_event, flag) => {
    applyDisplayMode(flag ? 'fullscreen' : 'windowed');
    return {
        mode: displayMode,
        fullscreen: displayMode === 'fullscreen'
    };
});

function getSteamCloudClient() {
    return global.__ronkSteamClient || null;
}

ipcMain.handle('steam-cloud-read', (_event, filename) => {
    const client = getSteamCloudClient();
    const name = filename || PROGRESS_CLOUD_FILE;
    if (!client?.cloud) {
        return { ok: false, error: 'steam_unavailable', data: null };
    }
    try {
        if (!client.cloud.isEnabledForAccount() || !client.cloud.isEnabledForApp()) {
            return { ok: false, error: 'cloud_disabled', data: null };
        }
        if (!client.cloud.fileExists(name)) {
            return { ok: true, data: null };
        }
        const data = client.cloud.readFile(name);
        return { ok: true, data: typeof data === 'string' ? data : String(data ?? '') };
    } catch (err) {
        return { ok: false, error: err.message || String(err), data: null };
    }
});

let steamScreenshotCounter = 0;

ipcMain.handle('get-steam-screenshot-mode', () => ({
    enabled: isSteamScreenshotMode(),
    batch: isSteamBatchCapture(),
    width: STEAM_SCREENSHOT_WIDTH,
    height: STEAM_SCREENSHOT_HEIGHT,
    outputDir: STEAM_SCREENSHOT_DIR
}));

ipcMain.handle('capture-steam-screenshot', async (_event, filename) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'no_window' };
    }
    try {
        ensureSteamScreenshotDir();
        if (isSteamScreenshotMode()) {
            applySteamScreenshotWindow();
            await new Promise((resolve) => setTimeout(resolve, 120));
        }
        const bounds = mainWindow.getContentBounds();
        const image = await mainWindow.webContents.capturePage({
            x: 0,
            y: 0,
            width: bounds.width,
            height: bounds.height
        });
        const resized = image.getSize().width === STEAM_SCREENSHOT_WIDTH && image.getSize().height === STEAM_SCREENSHOT_HEIGHT
            ? image
            : image.resize({ width: STEAM_SCREENSHOT_WIDTH, height: STEAM_SCREENSHOT_HEIGHT, quality: 'best' });
        const png = resized.toPNG();
        let outName = filename;
        if (!outName) {
            steamScreenshotCounter += 1;
            outName = `steam-${String(steamScreenshotCounter).padStart(2, '0')}.png`;
        }
        const { outPath } = resolveSteamScreenshotPath(outName);
        fs.writeFileSync(outPath, png);
        return {
            ok: true,
            path: outPath,
            filename: outName,
            width: STEAM_SCREENSHOT_WIDTH,
            height: STEAM_SCREENSHOT_HEIGHT
        };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('save-screenshot', (_event, filename, base64Data) => {
    try {
        ensureSteamScreenshotDir();
        const { outName, outPath } = resolveSteamScreenshotPath(filename);
        const raw = String(base64Data || '').replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(outPath, Buffer.from(raw, 'base64'));
        return { ok: true, path: outPath, filename: outName };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('steam-batch-complete', () => {
    setTimeout(() => app.quit(), 350);
    return { ok: true };
});

ipcMain.handle('save-loadout-cube-png', (_event, payload) => {
    try {
        const filename = payload?.filename || 'loadout_cube_transparent.png';
        const raw = String(payload?.data || '').replace(/^data:image\/\w+;base64,/, '');
        fs.mkdirSync(LOADOUT_CUBE_ART_DIR, { recursive: true });
        const outPath = path.join(LOADOUT_CUBE_ART_DIR, filename);
        fs.writeFileSync(outPath, Buffer.from(raw, 'base64'));
        return {
            ok: true,
            path: outPath,
            filename,
            width: payload?.width || null,
            height: payload?.height || null
        };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('capture-art-screenshot', async (_event, filename) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'no_window' };
    }
    try {
        fs.mkdirSync(ART_SCREENSHOT_DIR, { recursive: true });
        if (isArtBackgroundCaptureMode()) {
            applySteamScreenshotWindow();
            await new Promise((resolve) => setTimeout(resolve, 120));
        }
        const bounds = mainWindow.getContentBounds();
        const image = await mainWindow.webContents.capturePage({
            x: 0,
            y: 0,
            width: bounds.width,
            height: bounds.height
        });
        const resized = image.getSize().width === STEAM_SCREENSHOT_WIDTH && image.getSize().height === STEAM_SCREENSHOT_HEIGHT
            ? image
            : image.resize({ width: STEAM_SCREENSHOT_WIDTH, height: STEAM_SCREENSHOT_HEIGHT, quality: 'best' });
        const png = resized.toPNG();
        const outName = filename || 'white-black_background.png';
        const outPath = path.join(ART_SCREENSHOT_DIR, outName);
        fs.writeFileSync(outPath, png);
        return {
            ok: true,
            path: outPath,
            filename: outName,
            width: STEAM_SCREENSHOT_WIDTH,
            height: STEAM_SCREENSHOT_HEIGHT
        };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('art-background-capture-complete', () => {
    setTimeout(() => app.quit(), 200);
    return { ok: true };
});

ipcMain.handle('export-loadout-cube-complete', () => {
    setTimeout(() => app.quit(), 200);
    return { ok: true };
});

function ensureTrailerDir(subdir) {
    const dir = subdir ? path.join(TRAILER_DIR, subdir) : TRAILER_DIR;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function sanitizeTrailerClipPath(clip) {
    return String(clip || 'clip')
        .replace(/\\/g, '/')
        .split('/')
        .map((part) => part.replace(/[^a-zA-Z0-9_-]/g, '_'))
        .filter(Boolean)
        .join('/');
}

function resolveFfmpegBinary() {
    const candidates = [
        process.env.FFMPEG_PATH,
        path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
        path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
        'ffmpeg',
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages',
            'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-8.1.2-full_build', 'bin', 'ffmpeg.exe')
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (candidate === 'ffmpeg') {
            const cmd = process.platform === 'win32' ? 'where' : 'which';
            const probe = spawnSync(cmd, ['ffmpeg'], { encoding: 'utf8' });
            if (probe.status === 0 && probe.stdout.trim()) return 'ffmpeg';
            continue;
        }
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function resolveFfprobeBinary() {
    const ffmpeg = resolveFfmpegBinary();
    if (!ffmpeg) return null;
    if (ffmpeg === 'ffmpeg') {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const probe = spawnSync(cmd, ['ffprobe'], { encoding: 'utf8' });
        if (probe.status === 0 && probe.stdout.trim()) return 'ffprobe';
        return null;
    }
    const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    return fs.existsSync(probe) ? probe : null;
}

function nativeImageToBgra(image) {
    let frame = image;
    const size = frame.getSize();
    if (size.width !== TRAILER_WIDTH || size.height !== TRAILER_HEIGHT) {
        frame = frame.resize({ width: TRAILER_WIDTH, height: TRAILER_HEIGHT });
    }
    if (typeof frame.toBitmap === 'function') {
        return frame.toBitmap({ scaleFactor: 1.0 });
    }
    return frame.getBitmap();
}

function resolveFfmpegVideoEncoder(ffmpegBin) {
    if (process.env.RONK_TRAILER_ENCODER === 'libx264') {
        return { name: 'libx264', livePreset: 'ultrafast', qualPreset: 'slow', crf: 12 };
    }
    try {
        const probe = spawnSync(ffmpegBin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000 });
        const out = `${probe.stdout || ''}${probe.stderr || ''}`;
        if (out.includes('h264_nvenc')) {
            const test = spawnSync(ffmpegBin, [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
                '-c:v', 'h264_nvenc', '-preset', 'p1', '-f', 'null', '-'
            ], { encoding: 'utf8', timeout: 10000 });
            if (test.status === 0) {
                return { name: 'h264_nvenc', livePreset: 'p1', qualPreset: 'p5', cq: 16 };
            }
            console.warn('[TrailerCapture] h264_nvenc unavailable, using libx264:',
                (test.stderr || '').slice(0, 200));
        }
    } catch (_) { /* fall through */ }
    return { name: 'libx264', livePreset: 'ultrafast', qualPreset: 'slow', crf: 12 };
}

function ffprobeVideoSize(ffprobeBin, filePath) {
    try {
        const probe = spawnSync(ffprobeBin, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=p=0:s=x', filePath
        ], { encoding: 'utf8', timeout: 15000 });
        const parts = String(probe.stdout || '').trim().split('x');
        const width = parseInt(parts[0], 10);
        const height = parseInt(parts[1], 10);
        return { width, height };
    } catch (_) {
        return { width: 0, height: 0 };
    }
}

function ffprobeDuration(ffprobeBin, filePath) {
    try {
        const probe = spawnSync(ffprobeBin, [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', filePath
        ], { encoding: 'utf8', timeout: 15000 });
        const value = parseFloat(String(probe.stdout || '').trim());
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (_) {
        return 0;
    }
}

function waitForProcess(proc) {
    return new Promise((resolve) => {
        let stderr = '';
        if (proc.stderr) proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('close', (code) => resolve({ code, stderr }));
        proc.on('error', (err) => resolve({ code: -1, stderr: err.message || String(err) }));
    });
}

const TRAILER_RAW_FRAME_BYTES = TRAILER_WIDTH * TRAILER_HEIGHT * 4;
/** Deeper queue on Mac/CPU encode so gameplay clips don't starve to a few frames */
const TRAILER_MAX_PENDING_FRAMES = 32;

/** @type {{ clip: string, mp4Path: string, rawPath: string, rawStream: import('fs').WriteStream, encoder: ReturnType<typeof resolveFfmpegVideoEncoder>, frameCount: number, pendingFrames: Buffer[], draining: boolean, pumping: boolean, bridgeSeq?: number, bridgeMode?: boolean, durationMs?: number, audioPath?: string, audioProc?: import('child_process').ChildProcessWithoutNullStreams, withAudio?: boolean } | null} */
let trailerRecording = null;
let trailerBridgeSeq = 0;
let cachedWasapiLoopbackDevice = null;

function isTrailerWithAudio() {
    return process.argv.some((arg) => arg === '--trailer-with-audio')
        || isTrailerBatchCapture()
        || isTrailerCaptureMode();
}

function resolveWasapiLoopbackDevice(ffmpegBin) {
    if (cachedWasapiLoopbackDevice) return cachedWasapiLoopbackDevice;
    if (process.platform !== 'win32') return null;
    try {
        const r = spawnSync(ffmpegBin, ['-hide_banner', '-list_devices', 'true', '-f', 'wasapi', '-i', 'dummy'], {
            encoding: 'utf8',
            timeout: 15000
        });
        const listing = `${r.stderr || ''}\n${r.stdout || ''}`;
        const loopMatch = listing.match(/"([^"]+)"\s*\(loopback\)/i);
        if (loopMatch) {
            cachedWasapiLoopbackDevice = loopMatch[1];
            return cachedWasapiLoopbackDevice;
        }
        const alt = listing.match(/"([^"]*(?:Speaker|Output|Headphone|Realtek|HD Audio)[^"]*)"/i);
        if (alt) {
            cachedWasapiLoopbackDevice = alt[1];
            return cachedWasapiLoopbackDevice;
        }
    } catch (_) { /* fallback below */ }
    cachedWasapiLoopbackDevice = 'default';
    return cachedWasapiLoopbackDevice;
}

function startTrailerAudioRecording(ffmpegBin, audioPath, durationSec) {
    const duration = Math.max(1, durationSec + 1.5);
    let args;
    if (process.platform === 'win32') {
        const dev = resolveWasapiLoopbackDevice(ffmpegBin) || 'default';
        args = [
            '-y', '-f', 'wasapi', '-audio_source', 'loopback', '-i', dev,
            '-t', duration.toFixed(3),
            '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
            audioPath
        ];
    } else if (process.platform === 'darwin') {
        args = ['-y', '-f', 'avfoundation', '-i', ':0', '-t', duration.toFixed(3), audioPath];
    } else {
        args = ['-y', '-f', 'pulse', '-i', 'default', '-t', duration.toFixed(3), audioPath];
    }
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', () => { /* swallow */ });
    console.log('[TrailerCapture] Audio recording →', audioPath);
    return proc;
}

function stopTrailerAudioProcess(audioProc) {
    if (!audioProc || audioProc.killed) return;
    try {
        audioProc.stdin?.write('q');
    } catch (_) { /* ignore */ }
    try {
        audioProc.kill('SIGINT');
    } catch (_) { /* ignore */ }
}

async function waitForAudioFile(audioPath, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const stat = fs.statSync(audioPath);
            if (stat.size > 4096) return true;
        } catch (_) { /* not ready */ }
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return false;
}

async function muxTrailerVideoWithAudio(ffmpegBin, videoPath, audioPath) {
    if (!fs.existsSync(audioPath)) return { ok: false, reason: 'no_audio_file' };
    const audioStat = fs.statSync(audioPath);
    if (audioStat.size < 4096) return { ok: false, reason: 'audio_too_small' };

    const tmpOut = `${videoPath}.mux.tmp.mp4`;
    const ffArgs = [
        '-y', '-i', videoPath, '-i', audioPath,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-shortest', tmpOut
    ];
    const result = await new Promise((resolve) => {
        const ff = spawn(ffmpegBin, ffArgs);
        let stderr = '';
        ff.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        ff.on('close', (code) => resolve({ code, stderr }));
        ff.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    });
    if (result.code !== 0 || !fs.existsSync(tmpOut)) {
        try { fs.unlinkSync(tmpOut); } catch (_) { /* ignore */ }
        console.warn('[TrailerCapture] Audio mux failed:', result.stderr?.slice(-300));
        return { ok: false, reason: 'mux_failed' };
    }
    fs.renameSync(tmpOut, videoPath);
    console.log('[TrailerCapture] Muxed audio into', videoPath);
    return { ok: true };
}

function writeTrailerBridgeRequest(payload) {
    fs.mkdirSync(TRAILER_CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(TRAILER_REQUEST_FILE, JSON.stringify(payload, null, 2));
}

function readTrailerBridgeAck() {
    try {
        if (!fs.existsSync(TRAILER_ACK_FILE)) return null;
        return JSON.parse(fs.readFileSync(TRAILER_ACK_FILE, 'utf8'));
    } catch (_) {
        return null;
    }
}

function waitForTrailerBridgeAck(seq, phase, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
            const ack = readTrailerBridgeAck();
            if (ack && ack.seq === seq && ack.phase === phase) {
                resolve(ack);
                return;
            }
            if (Date.now() >= deadline) {
                reject(new Error(`bridge_ack_timeout_${phase}`));
                return;
            }
            setTimeout(poll, 50);
        };
        poll();
    });
}

async function startTrailerBridgeRecording(clip, durationMs) {
    const seq = ++trailerBridgeSeq;
    applyTrailerCaptureWindow();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const captureRect = getTrailerCaptureRect();
    writeTrailerBridgeRequest({
        seq,
        phase: 'start',
        clip,
        durationMs,
        captureRect,
        ts: Date.now()
    });
    const ready = await waitForTrailerBridgeAck(seq, 'ready', 90000);
    return { seq, capturePid: ready.capturePid };
}

async function stopTrailerBridgeRecording(seq, clip, durationMs) {
    writeTrailerBridgeRequest({
        seq,
        phase: 'stop',
        clip,
        durationMs,
        ts: Date.now()
    });
    return waitForTrailerBridgeAck(seq, 'saved', 180000);
}

function pumpTrailerRawFrames(rec) {
    if (!rec || rec.pumping || rec.draining || !rec.rawStream?.writable) return;
    rec.pumping = true;
    try {
        while (rec.pendingFrames.length > 0 && rec.rawStream?.writable) {
            const bmp = rec.pendingFrames[0];
            const ok = rec.rawStream.write(bmp);
            if (!ok) {
                rec.draining = true;
                rec.rawStream.once('drain', () => {
                    rec.draining = false;
                    rec.frameCount++;
                    rec.pendingFrames.shift();
                    rec.pumping = false;
                    pumpTrailerRawFrames(rec);
                });
                return;
            }
            rec.frameCount++;
            rec.pendingFrames.shift();
        }
    } finally {
        if (!rec.draining) rec.pumping = false;
    }
}

function enqueueTrailerRawFrame(rec, bmp) {
    if (!rec || !rec.rawStream?.writable) return;
    if (rec.pendingFrames.length >= TRAILER_MAX_PENDING_FRAMES) return;
    rec.pendingFrames.push(bmp);
    pumpTrailerRawFrames(rec);
}

function closeTrailerRawStream(rec) {
    return new Promise((resolve) => {
        if (!rec?.rawStream || rec.rawStream.destroyed) {
            resolve();
            return;
        }
        const stream = rec.rawStream;
        const finish = () => resolve();
        stream.once('close', finish);
        stream.once('error', finish);
        if (rec.pendingFrames.length > 0 || rec.draining) {
            const wait = () => {
                if (!rec.pendingFrames.length && !rec.draining) {
                    stream.end(finish);
                } else {
                    setImmediate(wait);
                }
            };
            wait();
            return;
        }
        stream.end(finish);
    });
}

function stopTrailerFrameRecording() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.endFrameSubscription(); } catch (_) { /* ignore */ }
    }
    const rec = trailerRecording;
    trailerRecording = null;
    if (!rec) return;
    if (rec.rawStream && !rec.rawStream.destroyed) {
        try { rec.rawStream.destroy(); } catch (_) { /* ignore */ }
    }
    if (rec.rawPath) {
        try { fs.unlinkSync(rec.rawPath); } catch (_) { /* ignore */ }
    }
}

function cleanupTrailerTmpDir() {
    const tmpDir = path.join(TRAILER_DIR, 'clips', '_tmp');
    try {
        if (!fs.existsSync(tmpDir)) return;
        for (const name of fs.readdirSync(tmpDir)) {
            try { fs.unlinkSync(path.join(tmpDir, name)); } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }
}

ipcMain.handle('trailer-clip-exists', (_event, payload) => {
    const clip = sanitizeTrailerClipPath(payload?.clip);
    const mp4Path = path.join(TRAILER_DIR, 'clips', `${clip}.mp4`);
    const exists = fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 4096;
    return { ok: true, exists, path: mp4Path };
});

ipcMain.handle('trailer-start-recording', async (_event, payload) => {
    try {
        const clip = sanitizeTrailerClipPath(payload?.clip);
        if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'no_window' };

        stopTrailerFrameRecording();
        cleanupTrailerTmpDir();
        applyTrailerCaptureWindow();
        await new Promise((resolve) => setTimeout(resolve, 400));

        const mp4Path = path.join(TRAILER_DIR, 'clips', `${clip}.mp4`);
        fs.mkdirSync(path.dirname(mp4Path), { recursive: true });

        const durationMs = Math.max(1000, Number(payload?.durationMs) || 10000);

        if (isTrailerObsCapture()) {
            const bridge = await startTrailerBridgeRecording(clip, durationMs);
            trailerRecording = {
                clip, mp4Path, bridgeMode: true, bridgeSeq: bridge.seq, durationMs,
                rawPath: '', rawStream: null, encoder: null,
                frameCount: 0, pendingFrames: [], draining: false, pumping: false
            };
            console.log('[TrailerCapture] External bridge recording', clip,
                `${TRAILER_WIDTH}x${TRAILER_HEIGHT} (OBS/ffmpeg)`);
            return { ok: true, path: mp4Path, bridge: true };
        }

        const ffmpegBin = resolveFfmpegBinary();
        if (!ffmpegBin) return { ok: false, error: 'no_ffmpeg' };

        const withAudio = isTrailerWithAudio();
        let audioPath = '';
        let audioProc = null;
        if (withAudio) {
            audioPath = path.join(TRAILER_DIR, 'clips', '_tmp', `${clip.replace(/\//g, '_')}.wav`);
            try { fs.unlinkSync(audioPath); } catch (_) { /* ignore */ }
            audioProc = startTrailerAudioRecording(ffmpegBin, audioPath, durationMs / 1000);
        }

        const rawPath = path.join(TRAILER_DIR, 'clips', '_tmp', `${clip.replace(/\//g, '_')}.raw`);
        fs.mkdirSync(path.dirname(mp4Path), { recursive: true });
        fs.mkdirSync(path.dirname(rawPath), { recursive: true });
        try { fs.unlinkSync(rawPath); } catch (_) { /* ignore */ }

        const encoder = resolveFfmpegVideoEncoder(ffmpegBin);
        const rawStream = fs.createWriteStream(rawPath, { highWaterMark: 64 * 1024 * 1024 });
        const rec = {
            clip, mp4Path, rawPath, rawStream, encoder,
            frameCount: 0, pendingFrames: [], draining: false, pumping: false,
            durationMs, withAudio, audioPath, audioProc
        };
        trailerRecording = rec;

        mainWindow.webContents.beginFrameSubscription(false, (image) => {
            if (!trailerRecording || trailerRecording.rawStream !== rawStream) return;
            setImmediate(() => {
                try {
                    if (!trailerRecording || trailerRecording.rawStream !== rawStream) return;
                    const bmp = nativeImageToBgra(image);
                    enqueueTrailerRawFrame(trailerRecording, bmp);
                } catch (err) {
                    console.warn('[TrailerCapture] frame error:', err.message);
                }
            });
        });

        console.log('[TrailerCapture] Recording', clip,
            `${TRAILER_WIDTH}x${TRAILER_HEIGHT} raw→${encoder.name} (max queue ${TRAILER_MAX_PENDING_FRAMES})`);
        return { ok: true, path: mp4Path };
    } catch (err) {
        stopTrailerFrameRecording();
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('trailer-stop-recording', async (_event, payload) => {
    if (!trailerRecording) return { ok: false, error: 'not_recording' };

    const durationMs = Math.max(100, Number(payload?.durationMs) || trailerRecording.durationMs || 0);
    const targetSec = durationMs / 1000;
    const rec = trailerRecording;
    trailerRecording = null;

    if (rec.bridgeMode) {
        try {
            const ack = await stopTrailerBridgeRecording(rec.bridgeSeq, rec.clip, durationMs);
            const mp4Path = ack.path || rec.mp4Path;
            const ffprobeBin = resolveFfprobeBinary();
            const outDur = ffprobeBin ? ffprobeDuration(ffprobeBin, mp4Path) : ack.durationSec;
            const outSize = ffprobeBin ? ffprobeVideoSize(ffprobeBin, mp4Path) : { width: ack.width, height: ack.height };
            if (outSize.width < TRAILER_WIDTH || outSize.height < TRAILER_HEIGHT) {
                return { ok: false, error: 'below_1080p', width: outSize.width, height: outSize.height };
            }
            const stat = fs.statSync(mp4Path);
            console.log('[TrailerCapture] Bridge MP4 saved', mp4Path,
                `${outSize.width}x${outSize.height} @${(ack.fps || 60).toFixed(1)}fps → ${outDur.toFixed(2)}s`,
                `${(stat.size / 1024 / 1024).toFixed(1)} MB (${ack.encoder || 'external'})`);
            return {
                ok: true, path: mp4Path, frames: 0, dropped: 0,
                fps: ack.fps || 60, durationSec: outDur, bridge: true
            };
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        }
    }

    const ffmpegBin = resolveFfmpegBinary();
    if (!ffmpegBin) return { ok: false, error: 'no_ffmpeg' };
    const ffprobeBin = resolveFfprobeBinary();
    try { mainWindow.webContents.endFrameSubscription(); } catch (_) { /* ignore */ }
    trailerRecording = null;

    await closeTrailerRawStream(rec);
    const { mp4Path, rawPath, encoder, frameCount, withAudio, audioPath, audioProc } = rec;

    if (audioProc) {
        stopTrailerAudioProcess(audioProc);
        await new Promise((resolve) => setTimeout(resolve, 350));
    }

    if (!frameCount || !fs.existsSync(rawPath)) {
        try { fs.unlinkSync(rawPath); } catch (_) { /* ignore */ }
        console.warn('[TrailerCapture] no frames captured');
        return { ok: false, error: 'no_frames' };
    }

    const rawBytes = fs.statSync(rawPath).size;
    const expectedBytes = frameCount * TRAILER_RAW_FRAME_BYTES;
    if (rawBytes < expectedBytes * 0.95) {
        console.warn('[TrailerCapture] raw size mismatch', rawBytes, 'expected ~', expectedBytes);
    }

    const inFps = Math.max(1, frameCount / targetSec);
    const ffArgs = [
        '-y',
        '-f', 'rawvideo', '-pix_fmt', 'bgra',
        '-s', `${TRAILER_WIDTH}x${TRAILER_HEIGHT}`,
        '-r', inFps.toFixed(6),
        '-i', rawPath,
        '-t', targetSec.toFixed(6)
    ];
    if (encoder.name === 'h264_nvenc') {
        ffArgs.push('-c:v', 'h264_nvenc', '-preset', encoder.qualPreset, '-rc', 'vbr', '-cq', String(encoder.cq),
            '-b:v', '8M', '-maxrate', '12M', '-bufsize', '16M');
    } else {
        ffArgs.push('-c:v', 'libx264', '-preset', encoder.qualPreset, '-crf', String(encoder.crf),
            '-b:v', '8M', '-maxrate', '12M', '-bufsize', '16M',
            '-profile:v', 'high', '-level', '4.2');
    }
    ffArgs.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Path);

    const encodeResult = await new Promise((resolve) => {
        const ff = spawn(ffmpegBin, ffArgs);
        let stderr = '';
        ff.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        ff.on('close', (code) => resolve({ code, stderr }));
        ff.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    });

    try { fs.unlinkSync(rawPath); } catch (_) { /* ignore */ }

    if (encodeResult.code !== 0 || !fs.existsSync(mp4Path)) {
        console.warn('[TrailerCapture] encode failed', encodeResult.stderr?.slice(0, 400));
        return { ok: false, error: 'ffmpeg_failed' };
    }

    const outDur = ffprobeBin ? ffprobeDuration(ffprobeBin, mp4Path) : targetSec;
    const outSize = ffprobeBin ? ffprobeVideoSize(ffprobeBin, mp4Path) : { width: TRAILER_WIDTH, height: TRAILER_HEIGHT };
    if (outSize.width && outSize.width < TRAILER_WIDTH) {
        try { fs.unlinkSync(mp4Path); } catch (_) { /* ignore */ }
        return { ok: false, error: 'below_1080p', width: outSize.width, height: outSize.height };
    }
    const stat = fs.statSync(mp4Path);
    let hasAudio = false;
    if (withAudio && audioPath) {
        const audioReady = await waitForAudioFile(audioPath);
        if (audioReady) {
            const mux = await muxTrailerVideoWithAudio(ffmpegBin, mp4Path, audioPath);
            hasAudio = !!mux.ok;
        } else {
            console.warn('[TrailerCapture] No audio captured for', rec.clip);
        }
        try { fs.unlinkSync(audioPath); } catch (_) { /* ignore */ }
    }
    const finalStat = fs.statSync(mp4Path);
    console.log('[TrailerCapture] MP4 saved', mp4Path,
        `${frameCount} frames @ ${inFps.toFixed(1)}fps → ${outDur.toFixed(2)}s (target ${targetSec.toFixed(1)}s)`,
        `${encoder.name} ${(finalStat.size / 1024 / 1024).toFixed(1)} MB${hasAudio ? ' +audio' : ''}`);
    return { ok: true, path: mp4Path, frames: frameCount, dropped: 0, fps: inFps, durationSec: outDur, hasAudio };
});

ipcMain.handle('get-trailer-capture-source-id', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'no_window' };
    }
    if (isTrailerCaptureMode()) {
        applySteamScreenshotWindow();
    }
    const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 }
    });
    const title = mainWindow.getTitle() || 'RonkBonk';
    const match = sources.find((s) => s.name === title || /RonkBonk/i.test(s.name));
    const id = (match || sources[0])?.id;
    if (!id) return { ok: false, error: 'no_capture_source' };
    return { ok: true, sourceId: id, sourceName: match?.name || sources[0]?.name };
});

ipcMain.handle('save-trailer-video', async (_event, payload) => {
    try {
        const clip = sanitizeTrailerClipPath(payload?.clip);
        const raw = Buffer.from(String(payload?.data || ''), 'base64');
        if (!raw.length) {
            return { ok: false, error: 'empty_video' };
        }
        const mp4Path = path.join(TRAILER_DIR, 'clips', `${clip}.mp4`);
        const webmPath = path.join(TRAILER_DIR, 'clips', `${clip}.webm`);
        fs.mkdirSync(path.dirname(mp4Path), { recursive: true });
        fs.writeFileSync(webmPath, raw);

        const ffmpegBin = resolveFfmpegBinary();
        if (!ffmpegBin) {
            console.warn('[TrailerCapture] ffmpeg not found — kept webm:', webmPath);
            return { ok: true, path: webmPath, format: 'webm', note: 'install ffmpeg for mp4' };
        }

        const ff = spawnSync(
            ffmpegBin,
            [
                '-y', '-i', webmPath,
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                '-crf', '14', '-preset', 'slow',
                '-movflags', '+faststart',
                mp4Path
            ],
            { encoding: 'utf8' }
        );

        if (ff.status === 0 && fs.existsSync(mp4Path)) {
            try { fs.unlinkSync(webmPath); } catch (_) { /* keep webm */ }
            const stat = fs.statSync(mp4Path);
            console.log('[TrailerCapture] MP4 saved', mp4Path, `${(stat.size / 1024 / 1024).toFixed(1)} MB`);
            return { ok: true, path: mp4Path, format: 'mp4' };
        }

        console.warn('[TrailerCapture] ffmpeg failed — kept webm:', webmPath, ff.stderr?.slice(0, 200));
        return { ok: true, path: webmPath, format: 'webm', note: 'install ffmpeg for mp4' };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('trailer-batch-complete', () => {
    console.log('[TrailerCapture] Batch complete — MP4 clips in', path.join(TRAILER_DIR, 'clips'));
    if (isTrailerObsCapture()) {
        writeTrailerBridgeRequest({ phase: 'batch-complete', ts: Date.now() });
    }
    setTimeout(() => app.quit(), 400);
    return { ok: true, outputDir: path.join(TRAILER_DIR, 'clips') };
});

const STEAM_INTRO_THEME_FOLDERS = ['ronk', 'white-black', 'pinkcore', 'hacker', 'pixel'];

ipcMain.handle('steam-distribute-intro-captures', (_event, payload) => {
    try {
        const sourceTheme = payload?.sourceTheme || 'ronk';
        const filenames = Array.isArray(payload?.filenames) ? payload.filenames : ['steam-09.png'];
        const copied = [];
        for (const filename of filenames) {
            const srcPath = path.join(STEAM_SCREENSHOT_DIR, sourceTheme, filename);
            if (!fs.existsSync(srcPath)) {
                console.warn('[SteamCapture] Intro source missing:', srcPath);
                continue;
            }
            for (const theme of STEAM_INTRO_THEME_FOLDERS) {
                if (theme === sourceTheme) continue;
                const destPath = path.join(STEAM_SCREENSHOT_DIR, theme, filename);
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.copyFileSync(srcPath, destPath);
                copied.push(`${theme}/${filename}`);
            }
        }
        console.log('[SteamCapture] Copied intro captures to all themes:', copied.join(', '));
        return { ok: true, copied };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

function writeSteamCloudFile(name, content) {
    const client = getSteamCloudClient();
    if (!client?.cloud) {
        return { ok: false, error: 'steam_unavailable' };
    }
    try {
        if (!client.cloud.isEnabledForAccount() || !client.cloud.isEnabledForApp()) {
            return { ok: false, error: 'cloud_disabled' };
        }
        const wrote = client.cloud.writeFile(name, String(content ?? ''));
        return { ok: !!wrote };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

ipcMain.handle('steam-cloud-write', (_event, filename, content) => {
    const name = filename || PROGRESS_CLOUD_FILE;
    return writeSteamCloudFile(name, content);
});

ipcMain.on('steam-cloud-write-sync', (event, filename, content) => {
    const name = filename || PROGRESS_CLOUD_FILE;
    event.returnValue = writeSteamCloudFile(name, content);
});

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    app.setAboutPanelOptions({
        applicationName: 'RonkBonk',
        applicationVersion: app.getVersion(),
        copyright: 'Copyright © 2026 CopoEric'
    });

    const gotSingleInstanceLock = app.requestSingleInstanceLock();
    if (!gotSingleInstanceLock) {
        app.quit();
        return;
    }

    app.on('second-instance', () => {
        focusGameWindow();
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else {
            focusGameWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
