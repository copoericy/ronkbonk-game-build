#!/usr/bin/env node
/**
 * Capture ~25 Steam store screenshots from the REAL localhost game
 * (same visuals you see in browser — not the broken Electron black-void dumps).
 *
 * Requires: game server on :8888
 *   node _local_serve.js
 *   node scripts/capture-steam-page-browser.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'steam-marketing', 'steam-page');
const PORT = Number(process.env.RONK_PORT || 8888);
const BASE = `http://127.0.0.1:${PORT}/index.html?steamStoreCapture=1&v=${Date.now()}`;

/** Primary Steam store set — no spectate (spectate = WASD tip + SPECTATE badge clutter). */
const SHOTS = [
    { file: '01_intro_animation.png', label: 'Intro / start animation', scene: 'intro' },
    { file: '02_main_menu.png', label: 'Main menu', scene: 'menu', theme: 0 },
    { file: '03_loadout.png', label: 'Loadout', scene: 'loadout', theme: 0 },
    { file: '04_skills.png', label: 'Skills picker', scene: 'skills', theme: 0 },
    { file: '05_jokers.png', label: 'Jokers picker', scene: 'jokers', theme: 0 },
    { file: '06_gameplay.png', label: 'Gameplay (Ronk)', scene: 'gameplay', theme: 0 },
    { file: '08_settings.png', label: 'Settings', scene: 'settings', theme: 0 },
    { file: '09_online.png', label: 'Online matchmake', scene: 'online', theme: 0 },
    // themes[] = ronk, white-black, pinkcore, hacker, pixel
    { file: '10_pinkcore_gameplay.png', label: 'Pinkcore gameplay', scene: 'gameplay', theme: 2 },
    { file: '11_hacker_gameplay.png', label: 'Hacker gameplay', scene: 'gameplay', theme: 3 },
    { file: '12_pixel_gameplay.png', label: 'Pixel gameplay', scene: 'gameplay', theme: 4 },
    { file: '13_whiteblack_gameplay.png', label: 'White/Black gameplay', scene: 'gameplay', theme: 1 },
    { file: '14_pinkcore_menu.png', label: 'Pinkcore menu', scene: 'menu', theme: 2 },
    { file: '15_pinkcore_loadout.png', label: 'Pinkcore loadout', scene: 'loadout', theme: 2 },
    { file: '16_hacker_menu.png', label: 'Hacker menu', scene: 'menu', theme: 3 },
    { file: '17_hacker_loadout.png', label: 'Hacker loadout', scene: 'loadout', theme: 3 },
    { file: '18_pixel_menu.png', label: 'Pixel menu', scene: 'menu', theme: 4 },
    { file: '19_pixel_loadout.png', label: 'Pixel loadout', scene: 'loadout', theme: 4 },
    { file: '20_whiteblack_menu.png', label: 'White/Black menu', scene: 'menu', theme: 1 },
    { file: '21_whiteblack_loadout.png', label: 'White/Black loadout', scene: 'loadout', theme: 1 }
];

function waitHttp(url, tries = 40) {
    return new Promise((resolve, reject) => {
        let n = 0;
        const tick = () => {
            n++;
            const req = http.get(url, (res) => {
                res.resume();
                if (res.statusCode && res.statusCode < 500) resolve(true);
                else if (n >= tries) reject(new Error('server not ready'));
                else setTimeout(tick, 250);
            });
            req.on('error', () => {
                if (n >= tries) reject(new Error('server not ready'));
                else setTimeout(tick, 250);
            });
        };
        tick();
    });
}

async function ensurePlaywright() {
    try {
        return require('playwright');
    } catch (_) {
        console.log('[steam-page] installing playwright (chromium)…');
        const r = spawn('npm', ['install', '--no-save', 'playwright@1.49.1'], {
            cwd: ROOT,
            stdio: 'inherit',
            shell: process.platform === 'win32'
        });
        await new Promise((resolve, reject) => {
            r.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('npm install failed'))));
        });
        const pw = require('playwright');
        const br = spawn(process.execPath, [
            path.join(ROOT, 'node_modules', 'playwright', 'cli.js'),
            'install',
            'chromium'
        ], { cwd: ROOT, stdio: 'inherit' });
        await new Promise((resolve) => br.on('exit', resolve));
        return pw;
    }
}

async function setupStoreCapture(page) {
    await page.addInitScript(() => {
        try {
            localStorage.setItem('ronk_tutorial_v2_complete', 'true');
            localStorage.setItem('ronk_play_unlock_hint_seen', 'true');
            localStorage.setItem('ronk_resolution', '1080p');
            localStorage.setItem('ronk_keep_480p', '0');
        } catch (_) { /* ignore */ }
    });
}

async function prepareGameApi(page) {
    await page.waitForFunction(() => typeof window.__ronkGet === 'function' || typeof changeTheme === 'function', null, {
        timeout: 60000
    }).catch(() => {});
    await page.evaluate(() => {
        // Unlock everything for store shots — never show LOCKED kits
        try {
            if (typeof SKILL_DATA !== 'undefined' && typeof JOKER_DATA !== 'undefined') {
                const skills = SKILL_DATA.map((s) => s.id);
                const jokers = JOKER_DATA.map((j) => j.id);
                window.unlockProgressCache = { skills, jokers };
                window.unlockProgressHydrated = true;
            }
            document.body.classList.add('steam-store-capture');
            document.body.classList.remove('performance-mode', 'perf-chrome');
            if (typeof applyResolution === 'function') applyResolution('1080p');
        } catch (_) { /* ignore */ }
    });
}

/** Kill tips / chrome right before the shutter clicks. */
async function cleanMarketingChrome(page) {
    await page.evaluate(() => {
        try {
            document.body.classList.add('steam-store-capture');
            localStorage.setItem('ronk_tutorial_v2_complete', 'true');
            localStorage.setItem('ronk_play_unlock_hint_seen', 'true');
            const hideIds = [
                'theme-btn',
                'display-mode-btn',
                'display-mode-wrap',
                'match-mode-banner',
                'spectate-cam-hint',
                'tutorial-overlay',
                'play-unlock-hint-overlay',
                'unlock-notify',
                'anti-cheat-toast',
                'intro-skip-hint',
                'steam-capture-hint',
                'tutorial-gate',
                'countdown-overlay',
                'round-announcer'
            ];
            for (const id of hideIds) {
                const el = document.getElementById(id);
                if (!el) continue;
                el.classList.add('hidden');
                el.hidden = true;
                el.style.display = 'none';
                el.style.visibility = 'hidden';
                el.style.opacity = '0';
            }
            if (typeof __ronkSet === 'function') {
                __ronkSet('countdownValue', -1);
                __ronkSet('isPaused', false);
            }
        } catch (_) { /* ignore */ }
    });
}

async function skipIntro(page) {
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        try {
            const overlay = document.getElementById('intro-overlay');
            if (overlay) overlay.click();
            const btn = document.getElementById('intro-start-btn');
            if (btn) btn.click();
            const skip = document.getElementById('tutorial-gate-skip-btn');
            if (skip) skip.click();
            // Hard-force past intro if click path is slow
            if (typeof introFinished !== 'undefined') introFinished = true;
            document.body.classList.remove('intro-active');
            if (overlay) {
                overlay.style.display = 'none';
                overlay.classList.add('hidden');
            }
            if (typeof showMainMenu === 'function') showMainMenu();
            if (typeof resetToMainTier === 'function') resetToMainTier();
            if (typeof hideTutorialGate === 'function') hideTutorialGate();
        } catch (e) { console.warn('skipIntro', e); }
    });
    await page.waitForTimeout(700);
}

async function goTheme(page, themeIndex) {
    if (themeIndex == null) return;
    const want = ['theme-ronk', 'theme-white-black', 'theme-pinkcore', 'theme-hacker', 'theme-pixel'][themeIndex];
    await page.evaluate((idx) => {
        try {
            document.body.classList.remove('intro-active', 'performance-mode', 'perf-chrome');
            if (typeof introFinished !== 'undefined') introFinished = true;
            if (typeof changeTheme === 'function') changeTheme(idx, { force: true });
            const themeClass = (typeof themes !== 'undefined' && themes[idx]) || null;
            if (themeClass) {
                // Force body class even if changeTheme is mid-transition
                document.body.className = document.body.className
                    .split(/\s+/)
                    .filter((c) => c && !c.startsWith('theme-'))
                    .concat([themeClass, 'steam-store-capture', 'main-menu-visible'])
                    .join(' ');
                if (typeof initThemeBackground === 'function') {
                    initThemeBackground(themeClass, { force: true });
                }
                if (typeof themeBtn !== 'undefined' && themeBtn) {
                    const name = themeClass === 'theme-white-black'
                        ? 'BAPBAP'
                        : themeClass.replace('theme-', '').toUpperCase().replace('-', ' ');
                    themeBtn.textContent = 'THEME: ' + name;
                }
            }
        } catch (e) { console.warn('goTheme', e); }
    }, themeIndex);
    await page.waitForFunction((cls) => document.body.classList.contains(cls), want, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1100);
}

async function exitGame(page) {
    await page.evaluate(() => {
        try {
            if (typeof returnToLobbyState === 'function') returnToLobbyState({ stopLoop: true });
            if (typeof hideGameplayUI === 'function') hideGameplayUI();
            document.body.classList.remove('in-game');
            if (typeof showMainMenu === 'function') showMainMenu();
            if (typeof resetToMainTier === 'function') resetToMainTier();
        } catch (_) { /* ignore */ }
    });
    await page.waitForTimeout(500);
}

async function runScene(page, scene) {
    switch (scene) {
    case 'intro': {
        // Reload fresh for intro
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await setupStoreCapture(page);
        await page.waitForTimeout(2200);
        // Don't skip — capture mid-spin
        break;
    }
    case 'menu': {
        await skipIntro(page);
        await prepareGameApi(page);
        await page.evaluate(() => {
            if (typeof showMainMenu === 'function') showMainMenu();
            if (typeof resetToMainTier === 'function') resetToMainTier();
            document.body.classList.add('main-menu-visible');
            document.body.classList.remove('in-game', 'intro-active');
            const themeClass = themes[currentThemeIndex];
            if (themeClass && typeof initThemeBackground === 'function') {
                initThemeBackground(themeClass, { force: true });
            }
        });
        await page.waitForTimeout(700);
        break;
    }
    case 'loadout': {
        await page.evaluate(() => {
            if (typeof showLoadoutPage === 'function') showLoadoutPage();
        });
        await page.waitForTimeout(900);
        break;
    }
    case 'skills': {
        await page.evaluate(() => {
            if (typeof showLoadoutPage === 'function') showLoadoutPage();
            if (typeof openLoadoutPanel === 'function' && typeof loadoutSkillPanel !== 'undefined') {
                openLoadoutPanel(loadoutSkillPanel);
            }
        });
        await page.waitForTimeout(800);
        break;
    }
    case 'jokers': {
        await page.evaluate(() => {
            if (typeof showLoadoutPage === 'function') showLoadoutPage();
            if (typeof openLoadoutPanel === 'function' && typeof loadoutJokerPanel !== 'undefined') {
                openLoadoutPanel(loadoutJokerPanel);
            }
            if (typeof renderJokersGrid === 'function') renderJokersGrid();
        });
        await page.waitForTimeout(800);
        break;
    }
    case 'settings': {
        await exitGame(page);
        await page.evaluate(() => {
            if (typeof hideOverlayPanel === 'function' && typeof menu !== 'undefined') hideOverlayPanel(menu);
            if (typeof showOverlayPanel === 'function' && typeof settingsPage !== 'undefined') showOverlayPanel(settingsPage);
            if (typeof setActiveNavigation === 'function') setActiveNavigation('settings');
        });
        await page.waitForTimeout(600);
        break;
    }
    case 'online': {
        await exitGame(page);
        await page.evaluate(() => {
            try {
                if (typeof currentLanguage === 'undefined') {
                    window.currentLanguage = localStorage.getItem('ronk_language') || 'en';
                }
            } catch (_) { /* ignore */ }
            try {
                if (typeof openOnlinePanel === 'function' && typeof onlineMatchmakePanel !== 'undefined') {
                    openOnlinePanel(onlineMatchmakePanel, 'matchmake');
                } else {
                    const panel = document.getElementById('online-matchmake-panel') || document.querySelector('[id*="online"]');
                    if (panel) {
                        panel.classList.remove('hidden');
                        panel.style.display = 'flex';
                        panel.style.visibility = 'visible';
                        panel.style.opacity = '1';
                    }
                }
            } catch (err) {
                console.warn('online panel', err);
            }
        });
        await page.waitForTimeout(700);
        break;
    }
    case 'gameplay': {
        await exitGame(page);
        await page.evaluate(() => {
            try {
                if (typeof setBotDifficulty === 'function') setBotDifficulty('hard');
                if (typeof launchGameMode === 'function') {
                    launchGameMode({ spectate: false, multiplayer: false, botDifficulty: 'hard' });
                }
            } catch (e) { console.warn(e); }
        });
        await page.waitForTimeout(1200);
        // Force past countdown into live play
        for (let i = 0; i < 8; i++) {
            await page.evaluate(() => {
                try {
                    if (typeof __ronkSet === 'function') {
                        __ronkSet('countdownValue', -1);
                        __ronkSet('gameHasStarted', true);
                        __ronkSet('isPaused', false);
                        __ronkSet('gameState', 'PLAYING');
                    } else {
                        if (typeof countdownValue !== 'undefined') countdownValue = -1;
                        if (typeof gameHasStarted !== 'undefined') gameHasStarted = true;
                        if (typeof isPaused !== 'undefined') isPaused = false;
                        if (typeof gameState !== 'undefined') gameState = 'PLAYING';
                    }
                    const cd = document.getElementById('countdown-display') || document.querySelector('.countdown');
                    if (cd) { cd.style.display = 'none'; cd.classList.add('hidden'); }
                } catch (_) { /* ignore */ }
            });
            await page.waitForTimeout(400);
        }
        // Let bots fight so the board looks alive (beams / cubes in motion)
        await page.waitForTimeout(5200);
        await cleanMarketingChrome(page);
        await page.waitForTimeout(200);
        break;
    }
    default:
        break;
    }
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    console.log('[steam-page] waiting for http://127.0.0.1:' + PORT);
    await waitHttp(`http://127.0.0.1:${PORT}/`);
    const playwright = await ensurePlaywright();
    const browser = await playwright.chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1
    });
    const page = await context.newPage();
    await setupStoreCapture(page);

    const manifest = {
        generatedAt: new Date().toISOString(),
        count: 0,
        target: SHOTS.length,
        method: 'localhost-browser-capture',
        note: 'Matches live game visuals (not Electron capturePage black-void dumps)',
        files: []
    };

    // Warm load once
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    for (let i = 0; i < SHOTS.length; i++) {
        const shot = SHOTS[i];
        console.log(`[steam-page] ${i + 1}/${SHOTS.length} ${shot.label}`);
        if (shot.scene === 'intro') {
            await runScene(page, 'intro');
            // Boot once after intro for all remaining shots
            await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(600);
            await skipIntro(page);
            await prepareGameApi(page);
        } else {
            if (i === 1) {
                // already booted after intro; if intro failed path, boot now
                const ready = await page.evaluate(() => !!document.body.classList.contains('steam-store-capture') || typeof changeTheme === 'function');
                if (!ready) {
                    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await page.waitForTimeout(600);
                    await skipIntro(page);
                    await prepareGameApi(page);
                }
            }
            await exitGame(page);
            await goTheme(page, shot.theme);
            await runScene(page, shot.scene);
        }
        await cleanMarketingChrome(page);
        const outPath = path.join(OUT, shot.file);
        await page.screenshot({ path: outPath, type: 'png', fullPage: false });
        manifest.files.push({ file: shot.file, label: shot.label, scene: shot.scene, theme: shot.theme });
        manifest.count++;
    }

    fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
    await browser.close();
    console.log(`[steam-page] ${manifest.count} screenshots → ${OUT}`);
}

main().catch((err) => {
    console.error('[steam-page] FAILED', err);
    process.exit(1);
});
