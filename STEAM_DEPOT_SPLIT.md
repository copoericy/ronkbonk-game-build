# RonkBonk — Separate Depots (Steam Review Fix)

App **4887920**

| Depot | OS filter (Steamworks) | Content |
|-------|------------------------|---------|
| **4887921** | **Windows only** | `windows/` + `steam_appid.txt` |
| **4887922** | **Linux only** | `linux/` + `steam_appid.txt` |
| **4887923** | **macOS only** | `mac/` + `steam_appid.txt` |

## Why review failed

Steam installed **Mac `.app` files on Windows** because one depot (or one zip) contained **all OSes**.
That causes **Disk Write Error** and a broken / incomplete Windows install → **won't launch**.

**Never upload** `RONKBONK_Steam_AllOS_*.zip` to SteamPipe / as a depot.
That zip is only for humans unzipping on a PC to test all platforms manually.

## Correct upload zips (this folder)

| File | Upload to depot |
|------|-----------------|
| `RonkBonk-Depot-4887921-windows.zip` | **4887921** |
| `RonkBonk-Depot-4887922-linux.zip` | **4887922** |
| `RonkBonk-Depot-4887923-mac.zip` | **4887923** |

Or use steamcmd + `app_build_4887920.vdf` (preferred).

## Steamworks checklist (do all of these)

### 1) Depots → OS filter
[Steamworks → App 4887920 → SteamPipe → Depots](https://partner.steamgames.com/apps/depots/4887920)

- **4887921** → Operating Systems = **Windows** only (uncheck Mac/Linux)
- Create **4887922** if missing → **Linux** only
- Create **4887923** if missing → **macOS** only

### 2) Packages include all three depots
[Associated packages](https://partner.steamgames.com/apps/associated/4887920)

- **Store** package → add depots 4887921, 4887922, 4887923  
- **Developer Comp** package → add the same three  
- Publish / save packages

### 3) Launch options (exact paths)
[Installation → Launch Options](https://partner.steamgames.com/apps/config/4887920)

| OS | Executable | Working Directory |
|----|------------|-------------------|
| Windows | `windows/RonkBonk.exe` | `windows` |
| Linux + SteamOS | `linux/RonkBonk` | `linux` |
| macOS | `mac/RonkBonk.app` | `mac` |

Optional Low Graphics (each OS): same exe + args `--ronk-low-gfx`  
**Publish** launch options after editing.

### 4) Upload build + Set Live
1. Upload the **three separate** depots (not AllOS)
2. [Builds](https://partner.steamgames.com/apps/builds/4887920) → set the new build **Live on `default`**
3. Wait for CDN, then test: Steam → uninstall RonkBonk → install on **Windows**  
   Confirm install folder has **`windows/`** and **no** `mac/RonkBonk.app`

### 5) Supported OS lists match
Store page platforms **and** Steamworks → General → Supported Operating Systems must both list Windows / macOS / Linux (as you ship), then **Publish**.

## Verify Windows install (after Set Live)

Steam library folder should look like:

```
…/steamapps/common/RonkBonk/
  steam_appid.txt          (optional at root)
  windows/
    RonkBonk.exe
    steam_api64.dll
    resources/app.asar
    …
```

**Must NOT** contain `mac/` or `RonkBonk.app` on a Windows install.

## Resubmit

Reply in Steamworks that:

1. Depots are now split per OS (4887921/22/23) with OS filters set  
2. AllOS zip is no longer used for SteamPipe  
3. Build is live on **default** and packages include all three depots  
4. Launch option is `windows/RonkBonk.exe` with working dir `windows`
