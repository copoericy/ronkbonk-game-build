# How to upload RonkBonk for Steam review (Windows launch + all OS)

App ID: **4887920**

Valve’s latest block: **fails to launch on Windows through the Steam client.**
That is almost always Steamworks config, not a missing `.exe`. Reviewers install
from the **Developer Comp** package. If that package has no Windows depot, or
launch paths don’t match the zip, Play does nothing.

## What went wrong before
Uploading **Windows + Mac in one zip** made Windows also download Mac files →
**Disk Write Error** → broken install → **won’t launch**. Keep depots split.

## What to upload (ONLY these 3 files)

Folder (open in Finder):  
`game-source/steam-depot-zips/`

| File | Upload into depot |
|------|-------------------|
| `RonkBonk-Depot-4887921-windows.zip` | **4887921** |
| `RonkBonk-Depot-4887922-linux.zip` | **4887922** |
| `RonkBonk-Depot-4887923-mac.zip` | **4887923** |

**Never upload:** AllOS zip, combined zip, `RONKBONK_Steam_Windows.zip` (flat, no `windows/` folder), or any zip with `windows/` + `mac/` inside.

If you upload the flat `RONKBONK_Steam_Windows.zip` while launch is `windows/RonkBonk.exe`, Windows **will not start**.

---

## This exact Valve error — do these 4 things in order

Valve listed the same 4 links they always list when Play fails on Windows.

### 1) Packages (this is the usual miss)
https://partner.steamgames.com/apps/associated/4887920

Open **both** packages. Each must list depots **4887921, 4887922, 4887923**:

| Package | Why |
|---------|-----|
| **Store** | What customers download |
| **Developer Comp** | What **Valve reviewers** download |

If Developer Comp only has an empty/old depot, Larry’s Steam client has no `RonkBonk.exe` → this exact block.

Save both, then **Publish** (gold bar at the top of Steamworks).

### 2) Launch options (must match the depot zips)
https://partner.steamgames.com/apps/config/4887920

You need **three Default launch options** (one per OS). Use forward slashes.

**Windows**

| Field | Exact value |
|-------|-------------|
| Description | `RonkBonk` |
| Operating System | Windows |
| Executable | `windows/RonkBonk.exe` |
| Working Directory | `windows` |
| Launch Type | Default |

**Linux + SteamOS**

| Field | Exact value |
|-------|-------------|
| Description | `RonkBonk` |
| Operating System | Linux + SteamOS |
| Executable | `linux/RonkBonk` |
| Working Directory | `linux` |
| Launch Type | Default |

**macOS**

| Field | Exact value |
|-------|-------------|
| Description | `RonkBonk` |
| Operating System | macOS |
| Executable | `mac/RonkBonk.app` |
| Working Directory | `mac` |
| Launch Type | Default |

Delete any leftover launch row that says only `RonkBonk.exe` with a blank working directory — that path is for the flat zip, not these depots.

**Publish** launch options.

### 3) Upload the 3 depot zips (not the flat zips)
SteamPipe → Depots (or HTTP upload per depot):

| File in `game-source/steam-depot-zips/` | Depot |
|------------------------------------------|-------|
| `RonkBonk-Depot-4887921-windows.zip` | **4887921** |
| `RonkBonk-Depot-4887922-linux.zip` | **4887922** |
| `RonkBonk-Depot-4887923-mac.zip` | **4887923** |

### 4) Set the new build Live on default
https://partner.steamgames.com/apps/builds/4887920

Set Live on branch **`default`**. Preview / beta branches do **not** count for review.

Then wait until Steam finishes processing (often 15–60 min).

---

## After that — test like Valve
1. Steam → Library → RonkBonk → **Uninstall**
2. Install again on **Windows**
3. Right-click → Manage → Browse local files. You must see:
   ```
   …/RonkBonk/windows/RonkBonk.exe
   ```
   and **no** `mac/` folder
4. Click **Play**. If that works, resubmit. Paste `STEAM_RESUBMIT_NOTES.txt` in the review reply.

Also keep depot OS filters: 4887921 Windows only, 4887922 Linux only, 4887923 macOS only.
https://partner.steamgames.com/apps/depots/4887920

Then **Publish** the gold bar at the top of Steamworks after every change.


---

## Quick “did I screw up?” check

| Question | Good answer |
|----------|-------------|
| Did I upload 3 separate zips? | Yes |
| Does Windows zip contain `.app` or `mac/`? | No |
| Launch exe = `windows/RonkBonk.exe`? | Yes |
| Build live on **default**? | Yes |
| Store + Dev Comp have all 3 depots? | Yes |

If any answer is wrong, Valve can fail you again the same way.
