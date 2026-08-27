# RonkBonk — Steam marketing assets

## Upload these (store-ready)

After capture + curate:

**`../steam-screenshots/store-ready/`** — curated 1920×1080 PNGs (no spectate clutter)

Full capture dump:

**`steam-page/`** — browser Playwright shots (live-game look)

| Prefer | Avoid |
|--------|--------|
| Main menu, loadout, skills, jokers | Spectate mode (`SPECTATE` badge) |
| Live bot gameplay (any theme) | Mid-screen WASD / camera tips |
| Theme menus (optional variety) | Theme / Fullscreen corner chrome |
| Online panel | Round countdown / skill toasts |

## Why old / bad shots looked wrong

Typical hated frame = **pinkcore spectate**:
- `SPECTATE` banner + “WASD · move camera”
- Cyan tip box in the middle of the arena
- Theme / Fullscreen pills in the corners
- Distant camera, little sense of “you’re playing”

Electron `capturePage` dumps also produced empty black voids. Prefer browser capture.

## Capture (recommended)

```bash
cd game-source
node _local_serve.js          # keep running on :8888
npm run capture:steam-page    # Playwright → steam-marketing/steam-page/
npm run curate:screenshots    # → steam-screenshots/store-ready/
```

Optional multi-theme Electron batch (older path):

```bash
npm run capture:screenshots   # → steam-marketing/screenshots/<theme>/
```

## Trailer

- Upload: `trailer/RonkBonk_Steam_Trailer.mp4` (if present)
