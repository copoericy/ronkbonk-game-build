# RonkBonk — store-ready Steam screenshots

Generated: 2026-08-21T17:40:27.643Z
Source: steam-marketing/steam-page (browser capture)

Upload these 1920×1080 PNGs to the Steam store page (avoid spectate / WASD-tip shots).

1. `01_intro.png` — Intro cube / title spin
2. `02_main_menu_ronk.png` — Main menu (Ronk)
3. `03_loadout_ronk.png` — Loadout
4. `04_skills.png` — Skills picker
5. `05_jokers.png` — Jokers picker
6. `06_gameplay_ronk.png` — Live gameplay (Ronk)
7. `07_gameplay_pinkcore.png` — Live gameplay (Pinkcore)
8. `08_gameplay_hacker.png` — Live gameplay (Hacker)
9. `09_gameplay_pixel.png` — Live gameplay (Pixel)
10. `10_gameplay_bapbap.png` — Live gameplay (White/Black)
11. `11_menu_pinkcore.png` — Pinkcore menu
12. `12_online.png` — Online matchmake

## Re-capture

```bash
cd "/Users/copoeric/the steam game/RONKBONK_NEWEST_2026-07-28/game-source"
node _local_serve.js          # terminal 1 — keep running
npm run capture:steam-page    # terminal 2 — Playwright 1920×1080
npm run curate:screenshots    # refresh this folder
```

Do **not** use pinkcore spectate (SPECTATE badge + WASD camera tip + cyan tip box) as a hero shot.
