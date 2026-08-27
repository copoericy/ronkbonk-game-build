/**
 * Curate Steam-page screenshots for upload.
 *
 * Prefer fresh browser captures in steam-marketing/steam-page/ (no spectate).
 * Also mirrors a short “upload these” set into steam-screenshots/store-ready/.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_PAGE = path.join(ROOT, 'steam-marketing', 'steam-page');
const SRC_BATCH = path.join(ROOT, 'steam-marketing', 'screenshots');
const OUT_PAGE = SRC_PAGE;
const OUT_READY = path.join(ROOT, 'steam-screenshots', 'store-ready');

/** Best marketing set from browser capture (filenames match capture-steam-page-browser.js). */
const BROWSER_PICKS = [
    { src: '01_intro_animation.png', out: '01_intro.png', label: 'Intro cube / title spin' },
    { src: '02_main_menu.png', out: '02_main_menu_ronk.png', label: 'Main menu (Ronk)' },
    { src: '03_loadout.png', out: '03_loadout_ronk.png', label: 'Loadout' },
    { src: '04_skills.png', out: '04_skills.png', label: 'Skills picker' },
    { src: '05_jokers.png', out: '05_jokers.png', label: 'Jokers picker' },
    { src: '06_gameplay.png', out: '06_gameplay_ronk.png', label: 'Live gameplay (Ronk)' },
    { src: '10_pinkcore_gameplay.png', out: '07_gameplay_pinkcore.png', label: 'Live gameplay (Pinkcore)' },
    { src: '11_hacker_gameplay.png', out: '08_gameplay_hacker.png', label: 'Live gameplay (Hacker)' },
    { src: '12_pixel_gameplay.png', out: '09_gameplay_pixel.png', label: 'Live gameplay (Pixel)' },
    { src: '13_whiteblack_gameplay.png', out: '10_gameplay_bapbap.png', label: 'Live gameplay (White/Black)' },
    { src: '14_pinkcore_menu.png', out: '11_menu_pinkcore.png', label: 'Pinkcore menu' },
    { src: '09_online.png', out: '12_online.png', label: 'Online matchmake' }
];

/** Legacy Electron batch fallback (older naming). */
const BATCH_PICKS = [
    { src: 'ronk/steam-09.png', out: '01_intro.png', label: 'Intro' },
    { src: 'ronk/steam-01.png', out: '02_main_menu_ronk.png', label: 'Main menu' },
    { src: 'ronk/steam-02.png', out: '03_loadout_ronk.png', label: 'Loadout' },
    { src: 'ronk/steam-03.png', out: '06_gameplay_ronk.png', label: 'Gameplay' },
    { src: 'pinkcore/steam-03.png', out: '07_gameplay_pinkcore.png', label: 'Pinkcore gameplay' },
    { src: 'hacker/steam-03.png', out: '08_gameplay_hacker.png', label: 'Hacker gameplay' },
    { src: 'pixel/steam-03.png', out: '09_gameplay_pixel.png', label: 'Pixel gameplay' },
    { src: 'white-black/steam-03.png', out: '10_gameplay_bapbap.png', label: 'White/Black gameplay' },
    { src: 'ronk/steam-07.png', out: '04_skills.png', label: 'Skills' },
    { src: 'ronk/steam-08.png', out: '05_jokers.png', label: 'Jokers' },
    { src: 'ronk/steam-06.png', out: '12_online.png', label: 'Online' }
];

function copyPick(from, to, label) {
    if (!fs.existsSync(from)) {
        console.warn('[steam-page] missing', path.relative(ROOT, from));
        return false;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log('[steam-page]', label, '→', path.basename(to));
    return true;
}

fs.mkdirSync(OUT_READY, { recursive: true });
fs.mkdirSync(OUT_PAGE, { recursive: true });

let copied = 0;
const useBrowser = BROWSER_PICKS.some((p) => fs.existsSync(path.join(SRC_PAGE, p.src)));
const picks = useBrowser ? BROWSER_PICKS : BATCH_PICKS;
const srcRoot = useBrowser ? SRC_PAGE : SRC_BATCH;

console.log('[steam-page] source:', useBrowser ? 'browser steam-page/' : 'theme batch screenshots/');

for (const pick of picks) {
    const from = path.join(srcRoot, pick.src);
    const readyTo = path.join(OUT_READY, pick.out);
    if (copyPick(from, readyTo, pick.label)) copied++;
    // Keep steam-page/ names stable for browser pipeline outputs
    if (useBrowser && pick.src !== pick.out) {
        // already in SRC_PAGE — nothing else required
    }
}

const readme = `# RonkBonk — store-ready Steam screenshots

Generated: ${new Date().toISOString()}
Source: ${useBrowser ? 'steam-marketing/steam-page (browser capture)' : 'steam-marketing/screenshots (Electron batch)'}

Upload these 1920×1080 PNGs to the Steam store page (avoid spectate / WASD-tip shots).

${picks.map((p, i) => `${i + 1}. \`${p.out}\` — ${p.label}`).join('\n')}

## Re-capture

\`\`\`bash
cd "${ROOT}"
node _local_serve.js          # terminal 1 — keep running
npm run capture:steam-page    # terminal 2 — Playwright 1920×1080
npm run curate:screenshots    # refresh this folder
\`\`\`

Do **not** use pinkcore spectate (SPECTATE badge + WASD camera tip + cyan tip box) as a hero shot.
`;

fs.writeFileSync(path.join(OUT_READY, 'README.md'), readme);
console.log(`[steam-page] ${copied} screenshots → ${OUT_READY}`);
if (!copied) process.exit(1);
