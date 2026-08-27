# Steam store screenshots — upload guide

## What was wrong with the hated shot

Typical bad frame = **Pinkcore SPECTATE**:
- `SPECTATE` badge + **WASD · move camera** tip
- Mid-screen cyan tip box
- Theme / Fullscreen corner chrome
- Distant camera — looks like watching bots, not playing

Do **not** upload `*spectate*` files as hero shots.

## Best shots available right now (already captured)

### A) Fresh browser set (2026-08-21) — preferred

Dir: `/Users/copoeric/the steam game/RONKBONK_NEWEST_2026-07-28/game-source/steam-marketing/steam-page/`

| File | Shows |
|------|--------|
| `02_main_menu.png` | Ronk main menu (clean red/black) |
| `03_loadout.png` | Loadout + cube picker |
| `04_skills.png` | Special skills picker |
| `05_jokers.png` | Jokers picker |
| `06_gameplay.png` | Live Ronk arena vs hard bot |
| `09_online.png` | Online matchmake |
| `10_pinkcore_gameplay.png` | Pinkcore live arena (theme variety) |
| `11_hacker_gameplay.png` | Hacker neon-green arena |
| `12_pixel_gameplay.png` | Pixel theme arena |
| `13_whiteblack_gameplay.png` | BAPBAP / white-black arena |
| `14_pinkcore_menu.png` | Pinkcore cloud menu |
| `01_intro_animation.png` | Intro / title moment |
| `08_settings.png` | Settings |

**Avoid uploading:** `07_spectate.png`, `22_*`–`25_*_spectate.png` (WASD tip + SPECTATE badge).

**Note:** Gameplay PNGs may still show Theme/Fullscreen corners until you re-run capture (CSS+JS hides are now wired). Menus/loadout/skills are already store-usable.

### B) Older dump (2026-07-29)

Dir: `/Users/copoeric/the steam game/Steam Screenshots 2026-07-29/steam-page/`

Useful for backup/compare; several gameplay frames are worse (countdown, invincible bot chrome, spectate). Prefer set A.

## After re-capture — curated folder

```bash
cd "/Users/copoeric/the steam game/RONKBONK_NEWEST_2026-07-28/game-source"
node _local_serve.js          # terminal 1
npm run capture:steam-page    # terminal 2
npm run curate:screenshots
```

Outputs:
- Full set: `.../game-source/steam-marketing/steam-page/`
- Upload set: `.../game-source/steam-screenshots/store-ready/`

## Pipeline notes

- **Recommended:** `npm run capture:steam-page` (Playwright vs localhost — real visuals)
- **Legacy:** `npm run capture:screenshots` (Electron batch → `steam-marketing/screenshots/<theme>/`)
- Store capture now hides: theme/fullscreen, SPECTATE banner, WASD spectate tip, tutorial/unlock toasts, countdown
- Spectate scenes removed from the primary capture list
