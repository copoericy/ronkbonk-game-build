/**
 * RonkBonk theme media — 1920×1080 screenshots + smooth 60fps ~10 min walkthrough MP4 + audio.
 * Run: node _theme_capture.js
 */
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const MARKETING = path.join(ROOT, 'steam-marketing');
const SHOT_DIR = path.join(MARKETING, 'screenshots');
const VID_DIR = path.join(MARKETING, 'trailer', 'full');
const TMP_DIR = path.join(MARKETING, 'trailer', '_tmp', 'playwright');
const BASE_URL = process.env.RONK_CAPTURE_URL || 'http://127.0.0.1:8888/';

/** Everything 1920×1080 per user spec */
const CAPTURE_VIEW = { width: 1920, height: 1080 };
const SHOT_VIEW = CAPTURE_VIEW;
const VIDEO_VIEW = CAPTURE_VIEW;
const VIDEO_FPS = 60;

const THEMES = [
    { index: 0, slug: 'ronk', label: 'RONK' },
    { index: 1, slug: 'white-black', label: 'BAPBAP' },
    { index: 2, slug: 'pinkcore', label: 'PINKCORE' },
    { index: 3, slug: 'hacker', label: 'HACKER' },
    { index: 4, slug: 'pixel', label: 'PIXEL' }
];

/** ~10 min per theme — continuous 60fps (menu/loadout/skills/jokers/gameplay) */
const DUR = process.env.RONK_CAPTURE_FAST === '1' ? {
    menu: 12000, loadout: 18000, skills: 15000, jokers: 15000,
    settings: 8000, online: 8000, gameplay: 35000, spectate: 20000
} : {
    menu: 30000,
    loadout: 120000,
    skills: 90000,
    jokers: 90000,
    settings: 20000,
    online: 20000,
    gameplay: 180000,
    spectate: 120000
};
const VIDEO_ONLY = process.env.RONK_VIDEO_ONLY === '1';

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function ffmpegBin() {
    const win = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    if (fs.existsSync(win)) return win;
    const unix = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(unix)) return unix;
    return 'ffmpeg';
}

function ensureDirs() {
    for (const d of [MARKETING, SHOT_DIR, VID_DIR, TMP_DIR]) {
        fs.mkdirSync(d, { recursive: true });
    }
}

function pingServer(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });
}

let serveProc = null;
async function ensureServer() {
    if (await pingServer(BASE_URL)) {
        console.log('[capture] Server OK:', BASE_URL);
        return;
    }
    console.log('[capture] Starting _local_serve.js…');
    serveProc = spawn(process.execPath, [path.join(ROOT, '_local_serve.js')], {
        cwd: ROOT, stdio: 'ignore'
    });
    for (let i = 0; i < 30; i++) {
        await sleep(500);
        if (await pingServer(BASE_URL)) return;
    }
    throw new Error('Game server did not start');
}

/** 60fps CDP screencast → ffmpeg MJPEG pipe → MP4 */
function createCdpRecorder(page, outPath, width, height, fps = VIDEO_FPS) {
    const ff = spawn(ffmpegBin(), [
        '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps),
        '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-profile:v', 'high', '-level', '4.1',
        // Short GOP so Windows Photos / Movies scrub & play without 1‑min jumps
        '-g', String(fps), '-keyint_min', String(fps), '-sc_threshold', '0',
        '-vsync', 'cfr', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        outPath
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let cdp = null;
    let stopped = false;
    let frames = 0;

    return {
        async start() {
            cdp = await page.context().newCDPSession(page);
            await cdp.send('Page.startScreencast', {
                format: 'jpeg',
                quality: 93,
                maxWidth: width,
                maxHeight: height,
                everyNthFrame: 1
            });
            cdp.on('Page.screencastFrame', async (params) => {
                if (stopped) return;
                try {
                    const buf = Buffer.from(params.data, 'base64');
                    if (ff.stdin.writable) ff.stdin.write(buf);
                    frames += 1;
                    await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });
                } catch (_) { /* ignore */ }
            });
        },
        async stop() {
            stopped = true;
            try { await cdp?.send('Page.stopScreencast'); } catch (_) { /* ignore */ }
            if (ff.stdin.writable) ff.stdin.end();
            await new Promise((resolve) => {
                ff.on('close', resolve);
                ff.on('error', resolve);
            });
            return frames;
        }
    };
}

function muxVideoAudio(videoPath, audioPath, mp4Path) {
    const hasAudio = audioPath && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 4096;
    const args = [
        '-y',
        '-fflags', '+genpts',
        '-i', videoPath,
        ...(hasAudio ? ['-i', audioPath] : []),
        // Re-encode (don't copy) so PTS/GOP stay Windows-player friendly
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-vf', 'fps=30,format=yuv420p',
        '-vsync', 'cfr',
        ...(hasAudio
            ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-shortest']
            : ['-an']),
        '-movflags', '+faststart', mp4Path
    ];
    const r = spawnSync(ffmpegBin(), args, { encoding: 'utf8', timeout: 600000 });
    if (r.status !== 0) throw new Error((r.stderr || '').slice(-500) || 'mux failed');
}

async function prepLocalStorage(page) {
    await page.addInitScript(() => {
        try {
            localStorage.setItem('ronk_play_unlock_hint_seen', 'true');
            localStorage.setItem('ronk_tutorial_v2_complete', 'true');
            localStorage.setItem('ronk_language', 'en');
            localStorage.setItem('ronk_resolution', '1080p');
            localStorage.removeItem('ronk_keep_480p');
        } catch (_) { /* ignore */ }

        try {
            window.__ronkAudioChunks = [];
            window.__ronkTapTracks = [];
            const OrigAC = window.AudioContext || window.webkitAudioContext;
            if (!OrigAC) return;

            function wireContextTap(ctx) {
                if (ctx.__ronkTapGain) return;
                const tapGain = ctx.createGain();
                const tapDest = ctx.createMediaStreamDestination();
                tapGain.gain.value = 1;
                tapGain.connect(tapDest);
                ctx.__ronkTapGain = tapGain;
                ctx.__ronkTapDest = tapDest;
                window.__ronkTapTracks.push(...tapDest.stream.getAudioTracks());
            }

            const origConnect = AudioNode.prototype.connect;
            AudioNode.prototype.connect = function patchedConnect(dest, o, i) {
                const ret = origConnect.call(this, dest, o, i);
                const ctx = this.context;
                if (ctx?.__ronkTapGain && dest instanceof AudioDestinationNode) {
                    try { origConnect.call(this, ctx.__ronkTapGain); } catch (_) { /* ignore */ }
                }
                return ret;
            };

            const origMES = OrigAC.prototype.createMediaElementSource;
            OrigAC.prototype.createMediaElementSource = function patchedMES(media) {
                wireContextTap(this);
                const src = origMES.call(this, media);
                if (this.__ronkTapGain) {
                    try { src.connect(this.__ronkTapGain); } catch (_) { /* ignore */ }
                }
                return src;
            };

            function PatchedAC(...args) {
                const ctx = new OrigAC(...args);
                wireContextTap(ctx);
                return ctx;
            }
            PatchedAC.prototype = OrigAC.prototype;
            window.AudioContext = PatchedAC;
            window.webkitAudioContext = PatchedAC;

            const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus' : 'audio/webm';
            window.__ronkGetCaptureStream = () => {
                const s = new MediaStream();
                (window.__ronkTapTracks || []).forEach((t) => {
                    if (t.readyState === 'live') s.addTrack(t);
                });
                return s;
            };
            window.__ronkAudioRecorder = null;
            window.__ronkRestartCaptureRecorder = () => {
                if (window.__ronkAudioRecorder) {
                    try { window.__ronkAudioRecorder.stop(); } catch (_) { /* ignore */ }
                }
                const s = window.__ronkGetCaptureStream();
                if (!s.getAudioTracks().length) return;
                const r = new MediaRecorder(s, { mimeType: mime, audioBitsPerSecond: 192000 });
                r.ondataavailable = (e) => { if (e.data?.size) window.__ronkAudioChunks.push(e.data); };
                r.start(400);
                window.__ronkAudioRecorder = r;
            };
        } catch (_) { /* ignore */ }
    });
}

async function dismissAllBlockers(page) {
    await page.evaluate(() => {
        if (typeof hideTutorialGate === 'function') hideTutorialGate();
        if (typeof ensureTrailerShowcaseUnlocks === 'function') ensureTrailerShowcaseUnlocks();
        const gate = document.getElementById('tutorial-gate-overlay');
        if (gate) { gate.classList.add('hidden'); gate.style.display = 'none'; }
    });
    await sleep(200);
}

async function applyGameQuality(page) {
    if (page.isClosed()) return;
    await page.evaluate(() => {
        localStorage.setItem('ronk_resolution', '1080p');
        if (typeof applyResolution === 'function') applyResolution('1080p');
        document.body.classList.remove('performance-mode');
    }).catch(() => {});
    await sleep(300);
}

async function safeEval(page, fn, arg) {
    if (page.isClosed()) throw new Error('page_closed');
    return page.evaluate(fn, arg);
}

async function startInBrowserAudio(page) {
    await page.evaluate(async () => {
        window.__ronkRestartCaptureRecorder?.();
        if (typeof SFX !== 'undefined' && SFX.ctx) await SFX.ctx.resume();
        if (typeof Music !== 'undefined') {
            Music.init?.();
            if (Music.enabled) Music.play();
        }
    });
}

async function stopInBrowserAudio(page, outWebm) {
    const meta = await page.evaluate(async () => {
        const rec = window.__ronkAudioRecorder;
        if (!rec) return { ok: false };
        await new Promise((resolve) => {
            rec.onstop = resolve;
            try { rec.stop(); } catch (_) { resolve(); }
        });
        window.__ronkAudioRecorder = null;
        const blob = new Blob(window.__ronkAudioChunks || [], { type: 'audio/webm' });
        if (!blob.size) return { ok: false };
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return { ok: true, b64: btoa(s) };
    });
    if (!meta?.ok) return false;
    fs.writeFileSync(outWebm, Buffer.from(meta.b64, 'base64'));
    return fs.statSync(outWebm).size > 4096;
}

/** Wait while keeping the game animating — no frozen slideshow frames */
async function activeWait(page, ms, tickMs, tickFn) {
    const step = tickMs || 1200;
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const slice = Math.min(step, end - Date.now());
        if (slice <= 0) break;
        if (tickFn) await tickFn();
        await sleep(slice);
    }
}

async function setViewportForShots(page) {
    if (page.isClosed()) return;
    await page.setViewportSize(SHOT_VIEW);
    await applyGameQuality(page);
}

async function setViewportForVideo(page) {
    if (page.isClosed()) return;
    await page.setViewportSize(VIDEO_VIEW);
    await applyGameQuality(page);
}

async function shot(page, relPath) {
    const file = path.join(SHOT_DIR, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, type: 'png' });
    console.log(`  [screenshot] ${relPath}`);
}

async function shotPair(page, slug, num, betweenTick) {
    if (VIDEO_ONLY) return;
    const n = String(num).padStart(2, '0');
    await setViewportForShots(page);
    await shot(page, `${slug}/steam-${n}a.png`);
    if (betweenTick) await betweenTick();
    else await activeWait(page, 3500, 1200, async () => {
        await page.evaluate(() => document.getElementById('loadout-next-color')?.click());
    });
    await shot(page, `${slug}/steam-${n}b.png`);
    await setViewportForVideo(page);
}

async function skipIntro(page, captureIntro) {
    await page.waitForSelector('#intro-overlay, #loadout-page', { timeout: 45000 }).catch(() => {});
    await sleep(2500);
    if (captureIntro && !VIDEO_ONLY) {
        await setViewportForShots(page);
        await shot(page, 'common/00-intro-animation.png');
        await setViewportForVideo(page);
    }
    await page.evaluate(() => {
        document.getElementById('intro-start-btn')?.click();
        if (typeof introFinished !== 'undefined') introFinished = true;
        const ov = document.getElementById('intro-overlay');
        if (ov) { ov.classList.add('hidden'); ov.style.display = 'none'; }
        document.body.classList.remove('intro-active');
        if (typeof showLoadoutPage === 'function') showLoadoutPage();
    });
    await dismissAllBlockers(page);
    await sleep(800);
}

async function applyTheme(page, themeIndex) {
    await page.evaluate((idx) => {
        if (typeof changeTheme === 'function') changeTheme(idx, { force: true });
    }, themeIndex);
    await sleep(2000);
    await dismissAllBlockers(page);
}

async function captureTheme(browser, theme, introAlreadyDone) {
    const slug = theme.slug;
    const totalSec = Object.values(DUR).reduce((a, b) => a + b, 0) / 1000;
    console.log(`\n=== ${theme.label} (${slug}) — ~${Math.round(totalSec / 60)} min @ ${VIDEO_FPS}fps 1920×1080 ===`);

    const videoOnlyPath = path.join(TMP_DIR, `${slug}-video-60fps.mp4`);
    const audioWebmPath = path.join(TMP_DIR, `${slug}-audio.webm`);
    const mp4Path = path.join(VID_DIR, `${slug}-walkthrough.mp4`);

    const context = await browser.newContext({
        viewport: VIDEO_VIEW,
        ignoreHTTPSErrors: true,
        deviceScaleFactor: 1
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    page.on('crash', () => console.error(`  [crash] ${slug} page crashed`));

    let recorder = null;
    try {
    await prepLocalStorage(page);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(1500);
    await dismissAllBlockers(page);
    await applyGameQuality(page);

    if (!introAlreadyDone) await skipIntro(page, true);
    else {
        await safeEval(page, () => {
            introFinished = true;
            document.getElementById('intro-overlay')?.classList.add('hidden');
        });
        await dismissAllBlockers(page);
    }

    await applyTheme(page, theme.index);
    await startInBrowserAudio(page);

    recorder = createCdpRecorder(page, videoOnlyPath, VIDEO_VIEW.width, VIDEO_VIEW.height);
    await recorder.start();
    console.log(`  [video] 60fps recording started`);

    // --- MENU (continuous, not frozen) ---
    await page.evaluate(() => { showMainMenu?.(); resetToMainTier?.(); });
    await dismissAllBlockers(page);
    await shotPair(page, slug, 1, async () => {
        await activeWait(page, 4000, 2000, async () => {
            await page.evaluate(() => document.getElementById('matchmake-btn')?.click());
            await sleep(800);
            await page.evaluate(() => document.getElementById('matchmake-back-btn')?.click());
        });
    });
    await activeWait(page, DUR.menu, 2500, async () => {
        await page.evaluate(() => document.getElementById('open-settings-btn')?.click());
        await sleep(600);
        await page.evaluate(() => document.getElementById('close-settings-btn')?.click());
    });

    // --- LOADOUT + spinning cube (constant motion) ---
    await page.evaluate(() => showLoadoutPage?.());
    await dismissAllBlockers(page);
    await sleep(600);
    await shotPair(page, slug, 2, async () => {
        for (let i = 0; i < 4; i++) {
            await page.evaluate(() => document.getElementById('loadout-next-color')?.click());
            await sleep(900);
        }
    });
    await activeWait(page, DUR.loadout, 1100, async () => {
        await page.evaluate(() => document.getElementById('loadout-next-color')?.click());
    });

    // --- SKILLS ---
    await page.evaluate(() => document.getElementById('loadout-skill-btn')?.click());
    await sleep(500);
    await shotPair(page, slug, 7, async () => {
        await page.evaluate(() => document.getElementById('next-skill')?.click());
        await sleep(1200);
        await page.evaluate(() => document.getElementById('next-skill')?.click());
    });
    await activeWait(page, DUR.skills, 1400, async () => {
        await page.evaluate(() => document.getElementById('next-skill')?.click());
    });
    await page.evaluate(() => document.getElementById('loadout-skill-done-btn')?.click());
    await sleep(300);

    // --- JOKERS ---
    await page.evaluate(() => document.getElementById('loadout-joker-btn')?.click());
    await sleep(500);
    await shotPair(page, slug, 8, async () => {
        await page.evaluate(() => {
            const grid = document.getElementById('jokers-grid');
            const items = grid?.querySelectorAll('.collection-item, [data-joker-id], button') || [];
            if (items[3]) items[3].click();
        });
        await sleep(1000);
    });
    await activeWait(page, DUR.jokers, 1300, async () => {
        await page.evaluate((t) => {
            const grid = document.getElementById('jokers-grid');
            const items = grid?.querySelectorAll('.collection-item, [data-joker-id], button') || grid?.children || [];
            if (items.length) items[t % items.length]?.click?.();
        }, Math.floor(Date.now() / 1300));
    });
    await page.evaluate(() => document.getElementById('loadout-joker-done-btn')?.click());
    await sleep(300);

    // --- SETTINGS ---
    await page.evaluate(() => continueFromLoadout?.());
    await dismissAllBlockers(page);
    await page.evaluate(() => document.getElementById('open-settings-btn')?.click());
    await sleep(500);
    await shotPair(page, slug, 5);
    await activeWait(page, DUR.settings, 2000, async () => {
        await page.keyboard.press('ArrowDown').catch(() => {});
    });
    await page.evaluate(() => document.getElementById('close-settings-btn')?.click());
    await sleep(300);

    // --- ONLINE ---
    await page.evaluate(() => document.getElementById('matchmake-btn')?.click());
    await sleep(500);
    await shotPair(page, slug, 6);
    await activeWait(page, DUR.online, 1800, async () => {
        await page.evaluate(() => {
            const nick = document.getElementById('matchmake-nickname');
            if (nick) nick.value = 'TRAILER';
        });
    });
    await page.evaluate(() => document.getElementById('matchmake-back-btn')?.click());
    await sleep(300);

    // --- GAMEPLAY (real-time match — main smooth section) ---
    await page.evaluate(() => {
        setBotDifficulty?.('hard');
        launchGameMode?.({ spectate: false, multiplayer: false, botDifficulty: 'hard' });
    });
    await sleep(4000);
    await shotPair(page, slug, 3, async () => {
        await sleep(8000);
    });
    await activeWait(page, DUR.gameplay, 2000, async () => {
        await page.keyboard.press('KeyF').catch(() => {});
        await sleep(80);
        await page.keyboard.press('KeyC').catch(() => {});
    });

    // --- SPECTATE ---
    await page.evaluate(() => {
        returnToLobbyState?.({ stopLoop: true });
        hideGameplayUI?.();
        document.body.classList.remove('in-game');
        showMainMenu?.();
        launchGameMode?.({ spectate: true, multiplayer: false, botDifficulty: 'invincible' });
    });
    await sleep(4000);
    await shotPair(page, slug, 4, async () => {
        await sleep(6000);
    });
    await activeWait(page, DUR.spectate, 1500, null);

    const gotAudio = await stopInBrowserAudio(page, audioWebmPath);
    const frameCount = await recorder.stop();
    recorder = null;

    console.log(`  [video] ${frameCount} frames captured`);
    if (gotAudio) console.log(`  [audio] OK`);

    console.log(`  [mux] ${path.basename(mp4Path)} (${VIDEO_FPS}fps + audio)…`);
    muxVideoAudio(videoOnlyPath, gotAudio ? audioWebmPath : null, mp4Path);
    const stat = fs.statSync(mp4Path);
    console.log(`  [done] ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    try { fs.unlinkSync(videoOnlyPath); } catch (_) {}
    try { fs.unlinkSync(audioWebmPath); } catch (_) {}
    } finally {
        if (recorder) {
            try { await recorder.stop(); } catch (_) { /* ignore */ }
        }
        try { await context.close(); } catch (_) { /* ignore */ }
    }
}

async function main() {
    ensureDirs();
    await ensureServer();

    console.log('[capture] 1920×1080 screenshots + 60fps ~10min video + audio');
    console.log(`[capture] Shots: ${SHOT_VIEW.width}×${SHOT_VIEW.height} (2 per scene, intro once)`);
    console.log(`[capture] Video: ${VIDEO_VIEW.width}×${VIDEO_VIEW.height} @ ${VIDEO_FPS}fps`);

    const browser = await chromium.launch({
        headless: false,
        args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-gl=angle', '--enable-webgl',
            '--disable-dev-shm-usage', '--no-sandbox',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            `--window-size=${VIDEO_VIEW.width},${VIDEO_VIEW.height}`
        ]
    });

    let introDone = false;
    const filter = (process.env.RONK_CAPTURE_THEMES || '').split(',').map((s) => s.trim()).filter(Boolean);
    const themeList = filter.length ? THEMES.filter((t) => filter.includes(t.slug)) : THEMES;

    for (const theme of themeList) {
        try {
            await captureTheme(browser, theme, introDone);
            introDone = true;
        } catch (err) {
            console.error(`FAILED ${theme.slug}:`, err.message || err);
        }
    }

    await browser.close();
    if (serveProc) try { serveProc.kill(); } catch (_) {}
    console.log('\n[capture] Complete.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
