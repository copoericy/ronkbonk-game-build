/**
 * 4K theme media — 10 PNG screenshots + ~5 min 60fps walkthrough MP4 per theme.
 * Gameplay = Spectate AI vs AI only (Elite bots).
 *
 * Run: node scripts/capture-4k-theme-media.js
 * Env: RONK_CAPTURE_THEMES=ronk,pixel  RONK_CAPTURE_FAST=1  RONK_VIDEO_ONLY=1
 */
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { prepareCaptureEnvironment } = require('./trailer-capture-utils');

const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'github-media', '4k');
const SHOT_DIR = path.join(OUT_ROOT, 'screenshots');
const VID_DIR = path.join(OUT_ROOT, 'videos');
const TMP_DIR = path.join(OUT_ROOT, '_tmp');
const BASE_URL = process.env.RONK_CAPTURE_URL || 'http://127.0.0.1:8888/';

/** Native 4K viewport — matches in-game 4k render scale */
const CAPTURE_VIEW = { width: 3840, height: 2160 };
const VIDEO_FPS = 60;

const THEMES = [
    { index: 0, slug: 'ronk', label: 'RONK' },
    { index: 1, slug: 'white-black', label: 'BAPBAP' },
    { index: 2, slug: 'pinkcore', label: 'PINKCORE' },
    { index: 3, slug: 'hacker', label: 'HACKER' },
    { index: 4, slug: 'pixel', label: 'PIXEL' }
];

/** ~5 min per theme @ 60fps — scaled for 4K screencast frame-drop (~1.75× wall clock) */
const DUR_SCALE = process.env.RONK_CAPTURE_FAST === '1' ? 1 : 1.75;
const DUR_RAW = process.env.RONK_CAPTURE_FAST === '1' ? {
    menu: 8000, loadout: 10000, skills: 8000, jokers: 8000,
    settings: 5000, online: 5000, spectate: 25000
} : {
    menu: 35000,
    loadout: 45000,
    skills: 35000,
    jokers: 35000,
    settings: 25000,
    online: 25000,
    spectate: 100000
};
const DUR = Object.fromEntries(Object.entries(DUR_RAW).map(([k, v]) => [k, Math.round(v * DUR_SCALE)]));

const VIDEO_ONLY = process.env.RONK_VIDEO_ONLY === '1';
const SHOT_NAMES = [
    '01-menu',
    '02-menu-multiplayer',
    '03-loadout',
    '04-loadout-skills',
    '05-loadout-jokers',
    '06-settings',
    '07-online',
    '08-spectate-gameplay-01',
    '09-spectate-gameplay-02',
    '10-spectate-gameplay-03'
];

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
    for (const d of [OUT_ROOT, SHOT_DIR, VID_DIR, TMP_DIR]) {
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
        console.log('[4k-capture] Server OK:', BASE_URL);
        return;
    }
    console.log('[4k-capture] Starting _local_serve.js…');
    serveProc = spawn(process.execPath, [path.join(ROOT, '_local_serve.js')], {
        cwd: ROOT, stdio: 'ignore'
    });
    for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (await pingServer(BASE_URL)) return;
    }
    throw new Error('Game server did not start on ' + BASE_URL);
}

function createCdpRecorder(page, outPath, width, height, fps = VIDEO_FPS) {
    const ff = spawn(ffmpegBin(), [
        '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps),
        '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '14',
        '-profile:v', 'high', '-level', '5.1',
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
                quality: 98,
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
        '-y', '-fflags', '+genpts',
        '-i', videoPath,
        ...(hasAudio ? ['-i', audioPath] : []),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '14',
        '-g', String(VIDEO_FPS), '-keyint_min', String(VIDEO_FPS), '-sc_threshold', '0',
        '-vf', `fps=${VIDEO_FPS},format=yuv420p`,
        '-vsync', 'cfr',
        ...(hasAudio
            ? ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2', '-shortest']
            : ['-an']),
        '-movflags', '+faststart', mp4Path
    ];
    const r = spawnSync(ffmpegBin(), args, { encoding: 'utf8', timeout: 1200000 });
    if (r.status !== 0) throw new Error((r.stderr || '').slice(-800) || 'mux failed');
}

async function prepLocalStorage(page) {
    await page.addInitScript(() => {
        try {
            localStorage.setItem('ronk_play_unlock_hint_seen', 'true');
            localStorage.setItem('ronk_tutorial_v2_complete', 'true');
            localStorage.setItem('ronk_language', 'en');
            localStorage.setItem('ronk_resolution', '4k');
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
                const r = new MediaRecorder(s, { mimeType: mime, audioBitsPerSecond: 256000 });
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
        localStorage.setItem('ronk_resolution', '4k');
        if (typeof applyResolution === 'function') applyResolution('4k');
        document.body.classList.remove('performance-mode');
        document.body.classList.add('trailer-capture-active');
    }).catch(() => {});
    await sleep(400);
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

async function activeWait(page, ms, tickMs, tickFn) {
    const step = tickMs || 1500;
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const slice = Math.min(step, end - Date.now());
        if (slice <= 0) break;
        if (tickFn) await tickFn();
        await sleep(slice);
    }
}

async function shot(page, relPath) {
    const file = path.join(SHOT_DIR, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, type: 'png' });
    console.log(`  [screenshot] ${relPath}`);
}

async function skipIntro(page) {
    await page.waitForSelector('#intro-overlay, #loadout-page', { timeout: 60000 }).catch(() => {});
    await sleep(2000);
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
    await sleep(2500);
    await dismissAllBlockers(page);
}

async function launchSpectateElite(page) {
    await page.evaluate(() => {
        returnToLobbyState?.({ stopLoop: true });
        hideGameplayUI?.();
        document.body.classList.remove('in-game');
        showMainMenu?.();
        launchGameMode?.({ spectate: true, multiplayer: false, botDifficulty: 'invincible' });
    });
    await sleep(5000);
}

async function captureTheme(browser, theme, introAlreadyDone) {
    const slug = theme.slug;
    const totalSec = Object.values(DUR).reduce((a, b) => a + b, 0) / 1000;
    console.log(`\n=== ${theme.label} (${slug}) — ~${Math.round(totalSec / 60)} min @ ${VIDEO_FPS}fps ${CAPTURE_VIEW.width}×${CAPTURE_VIEW.height} ===`);

    const videoOnlyPath = path.join(TMP_DIR, `${slug}-video-60fps.mp4`);
    const audioWebmPath = path.join(TMP_DIR, `${slug}-audio.webm`);
    const mp4Path = path.join(VID_DIR, `${slug}-walkthrough-4k.mp4`);

    const context = await browser.newContext({
        viewport: CAPTURE_VIEW,
        ignoreHTTPSErrors: true,
        deviceScaleFactor: 1
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    page.on('crash', () => console.error(`  [crash] ${slug} page crashed`));

    let recorder = null;
    let shotIdx = 0;
    const takeShot = async (name) => {
        if (VIDEO_ONLY) return;
        shotIdx += 1;
        await shot(page, `${slug}/${name}.png`);
    };

    try {
        await prepLocalStorage(page);
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await sleep(2000);
        await dismissAllBlockers(page);
        await applyGameQuality(page);

        if (!introAlreadyDone) await skipIntro(page);
        else {
            await safeEval(page, () => {
                introFinished = true;
                document.getElementById('intro-overlay')?.classList.add('hidden');
            });
            await dismissAllBlockers(page);
        }

        await applyTheme(page, theme.index);
        await startInBrowserAudio(page);

        recorder = createCdpRecorder(page, videoOnlyPath, CAPTURE_VIEW.width, CAPTURE_VIEW.height);
        await recorder.start();
        console.log(`  [video] 60fps 4K recording started`);

        // --- MENU ---
        await page.evaluate(() => { showMainMenu?.(); resetToMainTier?.(); });
        await dismissAllBlockers(page);
        await sleep(1200);
        await takeShot(SHOT_NAMES[0]);
        await page.evaluate(() => document.getElementById('multiplayer-tier-btn')?.click());
        await sleep(800);
        await takeShot(SHOT_NAMES[1]);
        await page.evaluate(() => document.getElementById('back-tier-btn')?.click());
        await sleep(400);
        await activeWait(page, DUR.menu, 2500, async () => {
            await page.evaluate(() => document.getElementById('open-settings-btn')?.click());
            await sleep(500);
            await page.evaluate(() => document.getElementById('close-settings-btn')?.click());
        });

        // --- LOADOUT ---
        await page.evaluate(() => showLoadoutPage?.());
        await dismissAllBlockers(page);
        await sleep(800);
        await takeShot(SHOT_NAMES[2]);
        await activeWait(page, DUR.loadout, 1100, async () => {
            await page.evaluate(() => document.getElementById('loadout-next-color')?.click());
        });

        // --- SKILLS ---
        await page.evaluate(() => document.getElementById('loadout-skill-btn')?.click());
        await sleep(600);
        await takeShot(SHOT_NAMES[3]);
        await activeWait(page, DUR.skills, 1400, async () => {
            await page.evaluate(() => document.getElementById('next-skill')?.click());
        });
        await page.evaluate(() => document.getElementById('loadout-skill-done-btn')?.click());
        await sleep(300);

        // --- JOKERS ---
        await page.evaluate(() => document.getElementById('loadout-joker-btn')?.click());
        await sleep(600);
        await takeShot(SHOT_NAMES[4]);
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
        await sleep(700);
        await takeShot(SHOT_NAMES[5]);
        await activeWait(page, DUR.settings, 2000, async () => {
            await page.keyboard.press('ArrowDown').catch(() => {});
        });
        await page.evaluate(() => document.getElementById('close-settings-btn')?.click());
        await sleep(300);

        // --- ONLINE ---
        await page.evaluate(() => document.getElementById('matchmake-btn')?.click());
        await sleep(700);
        await takeShot(SHOT_NAMES[6]);
        await activeWait(page, DUR.online, 1800, async () => {
            await page.evaluate(() => {
                const nick = document.getElementById('matchmake-nickname');
                if (nick) nick.value = '4K-CAPTURE';
            });
        });
        await page.evaluate(() => document.getElementById('matchmake-back-btn')?.click());
        await sleep(300);

        // --- SPECTATE AI VS AI (gameplay — 3 screenshots + long video segment) ---
        await launchSpectateElite(page);
        await sleep(3000);
        await takeShot(SHOT_NAMES[7]);
        await sleep(12000);
        await takeShot(SHOT_NAMES[8]);
        await sleep(12000);
        await takeShot(SHOT_NAMES[9]);

        const spectateRemain = Math.max(5000, DUR.spectate - 27000);
        await activeWait(page, spectateRemain, 2000, async () => {
            await page.keyboard.press('KeyW').catch(() => {});
            await sleep(120);
            await page.keyboard.press('KeyA').catch(() => {});
            await sleep(120);
            await page.keyboard.press('KeyS').catch(() => {});
            await sleep(120);
            await page.keyboard.press('KeyD').catch(() => {});
        });

        const gotAudio = await stopInBrowserAudio(page, audioWebmPath);
        const frameCount = await recorder.stop();
        recorder = null;

        console.log(`  [video] ${frameCount} frames captured`);
        if (gotAudio) console.log(`  [audio] OK`);

        console.log(`  [mux] ${path.basename(mp4Path)}…`);
        muxVideoAudio(videoOnlyPath, gotAudio ? audioWebmPath : null, mp4Path);
        const stat = fs.statSync(mp4Path);
        console.log(`  [done] ${(stat.size / 1024 / 1024).toFixed(1)} MB — ${shotIdx} screenshots`);

        try { fs.unlinkSync(videoOnlyPath); } catch (_) {}
        try { fs.unlinkSync(audioWebmPath); } catch (_) {}
    } finally {
        if (recorder) {
            try { await recorder.stop(); } catch (_) { /* ignore */ }
        }
        try { await context.close(); } catch (_) { /* ignore */ }
    }
}

async function writeManifest(themeList) {
    const manifest = {
        capturedAt: new Date().toISOString(),
        resolution: `${CAPTURE_VIEW.width}x${CAPTURE_VIEW.height}`,
        videoFps: VIDEO_FPS,
        videoDurationSec: Object.values(DUR).reduce((a, b) => a + b, 0) / 1000,
        screenshotsPerTheme: SHOT_NAMES.length,
        gameplayMode: 'spectate-ai-vs-ai-elite',
        themes: themeList.map((t) => ({
            slug: t.slug,
            label: t.label,
            screenshots: SHOT_NAMES.map((n) => `screenshots/${t.slug}/${n}.png`),
            video: `videos/${t.slug}-walkthrough-4k.mp4`
        }))
    };
    fs.writeFileSync(path.join(OUT_ROOT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
}

async function main() {
    prepareCaptureEnvironment();
    ensureDirs();
    await ensureServer();

    const totalMin = (Object.values(DUR).reduce((a, b) => a + b, 0) / 1000 / 60) * THEMES.length;
    console.log(`[4k-capture] ${CAPTURE_VIEW.width}×${CAPTURE_VIEW.height} PNG + ${VIDEO_FPS}fps ~${Math.round(Object.values(DUR).reduce((a, b) => a + b, 0) / 60000)}min/theme`);
    console.log(`[4k-capture] Est. total runtime ~${Math.round(totalMin)} min for all themes`);

    const browser = await chromium.launch({
        headless: false,
        args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-gl=angle', '--enable-webgl',
            '--disable-dev-shm-usage', '--no-sandbox',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            `--window-size=${CAPTURE_VIEW.width},${CAPTURE_VIEW.height}`
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
    await writeManifest(themeList);
    console.log('\n[4k-capture] Complete → github-media/4k/');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
