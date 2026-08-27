# Steam rules audit — what can still fail (and how you fix it)

Based on Valve’s [Review Process](https://partner.steamgames.com/doc/store/review_process), [Depots](https://partner.steamgames.com/doc/store/application/depots), and common SteamPipe launch failures — plus what’s in this repo right now.

---

## CRITICAL (do these or review fails again)

### 1) Upload only per-OS depots (you already got dinged for this)
| Do | Don’t |
|----|--------|
| Upload `steam-depot-zips/RonkBonk-Depot-4887921-windows.zip` → depot **4887921** | Upload AllOS / combined zip |
| Same for Linux **4887922** / Mac **4887923** | Put Mac files in the Windows depot |
| Set each depot’s **OS filter** to that OS only | Leave depot OS = All |

**Where:** Steamworks → SteamPipe → Depots + your upload tool  
**Guide:** `STEAM_DEPOT_SPLIT.md`

### 2) Packages + Set Live + Launch (why Windows “won’t launch”)
Valve blocks builds that don’t start through Steam. Checklist:

1. [Associated packages](https://partner.steamgames.com/apps/associated/4887920) — **Store** and **Developer Comp** include depots 4887921 + 4887922 + 4887923  
2. [Launch options](https://partner.steamgames.com/apps/config/4887920) — Windows:
   - Executable: `windows/RonkBonk.exe`
   - Working Directory: `windows`
   - Then **Publish** config  
3. [Builds](https://partner.steamgames.com/apps/builds/4887920) — new build **Live on `default`**  
4. Fresh Steam install on Windows → folder has `windows/`, **no** `mac/`

### 3) Store platforms must match what you ship
Valve: product must launch on **every OS listed on the store**.

| Platform | Current ship reality | Action |
|----------|----------------------|--------|
| Windows | OK (`RonkBonk.exe` in windows depot) | Keep |
| Linux | OK if depot 4887922 is in packages | Keep + test |
| macOS | Pack is **Apple Silicon (arm64) only** | Either ship universal/Intel **or** don’t claim Intel Mac / test on a real Mac |

**Where:** Store Basic Info + Steamworks → Supported Operating Systems — lists must match, then Publish.

---

## HIGH (likely review / store checklist issues)

### 4) Features on store must exist in the build
Valve: remove store features that aren’t implemented yet.

| Claim | Reality | Fix |
|-------|---------|-----|
| Online PvP | Real (PeerJS) | Keep if it works |
| Shared / Split Screen | Local shared camera PvP | Keep “Shared/Split Screen” only if that’s what you selected; notes say shared camera (OK) |
| Spectate Steam Friend | **Stub / coming soon** | Don’t list as live feature; button already “coming soon” in EN — fix other languages |
| Full Controller Support | Partial | Keep **Partial Controller Support** only |
| Steam Cloud | Code exists; may not be store-enabled | Only check Cloud if you turn it on in Steamworks and test |

### 5) Third-party networking / privacy
Game uses **PeerJS cloud**, **Google STUN**, **Metered TURN**, nicknames + optional cube images between peers.

**You fix in Steamworks:** Privacy / questionnaire answers must mention third-party relay/signaling. Add a privacy policy URL if Steam asks for one.  
**Optional code later:** lower PeerJS `debug`, self-host PeerServer.

### 6) Screenshots / trailer honesty
Your notes already say media is outdated. Valve: screenshots = **gameplay only** (no awards / marketing text). Update before store-presence review, or they can reject the page.

### 7) Don’t ship `steam_appid.txt` in retail Steam depots
It’s in the depot zips (and asar) today. Valve expects it for **local testing outside Steam**, not retail installs.

**Fix in build (ask me if you want):** remove from electron-builder `files` + depot staging; keep only for local Electron runs.

---

## MEDIUM

| Issue | Why it matters | Fix |
|-------|----------------|-----|
| Mac not notarized (`notarize: false`) | Gatekeeper / “won’t open” on Mac review | Notarize Mac build before claiming Mac |
| Extra OS natives inside Windows `app.asar.unpacked` (osx/linux steamworks) | Bloat / messy; rare hard fail | Prune other-OS natives per depot |
| Anti-cheat DevTools / window-size kicks | False kicks during review | Soften for shipping |
| `ACH_SPECTATE_FRIEND` still in Steamworks fill list | Achievement for unfinished feature | Don’t publish that achievement in Steamworks |
| Custom image UGC | All-ages claims | Mark UGC appropriately; keep content filter |

---

## LOW / OK

- `steam_api64.dll` / `libsteam_api.*` next to binaries — good  
- Windows depot zip verified: has `windows/RonkBonk.exe`, no `.app` — good  
- Spectate Friend achievement **not** granted on stub click — good  
- No Steam Wallet / external IAP links found — good  

---

## Your action list (copy this)

**In Steamworks (today):**
1. [ ] Depot OS filters: Win / Linux / Mac only  
2. [ ] Packages include all three depots  
3. [ ] Launch options published (`windows/RonkBonk.exe` + WD `windows`)  
4. [ ] Upload **only** the three `steam-depot-zips/` files  
5. [ ] Set build live on **default**  
6. [ ] Uninstall → reinstall on Windows; confirm no Mac folder  
7. [ ] Store OS list matches reality (Mac = Apple Silicon until universal)  
8. [ ] Remove unfinished features from store (Spectate Friend, etc.)  
9. [ ] Fill privacy / network answers (PeerJS + STUN/TURN)  
10. [ ] Paste `STEAM_RESUBMIT_NOTES.txt` into the review reply  

**In the build (ask me to do):**
- [ ] Strip `steam_appid.txt` from retail depots  
- [ ] Align Spectate Friend strings in all languages  
- [ ] Soften anti-cheat false positives  
- [ ] Universal Mac + notarize (if you keep Mac on store)  
- [ ] Update gameplay screenshots / trailer  

Docs: `STEAM_DEPOT_SPLIT.md` · `STEAM_RESUBMIT_NOTES.txt` · `README_STEAM_UPLOAD.txt`
