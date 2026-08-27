RONKBONK — Steam upload (2026-08-15)

══════════════════════════════════════════════════════════════════
USE THESE FOR STEAMPIPE / DEPOT UPLOAD (ONLY)
══════════════════════════════════════════════════════════════════
Folder: steam-depot-zips/

  RonkBonk-Depot-4887921-windows.zip  → depot 4887921 (Windows ONLY)
  RonkBonk-Depot-4887922-linux.zip      → depot 4887922 (Linux ONLY)
  RonkBonk-Depot-4887923-mac.zip          → depot 4887923 (macOS ONLY)

Full steps: STEAM_DEPOT_SPLIT.md
Resubmit reply text: STEAM_RESUBMIT_NOTES.txt

DO NOT upload any AllOS / combined zip to Steam.
DO NOT upload RONKBONK_Steam_Windows.zip for SteamPipe if it is a flat
layout without the windows/ folder — launch option expects windows/RonkBonk.exe.

══════════════════════════════════════════════════════════════════
STEAMWORKS MUST MATCH
══════════════════════════════════════════════════════════════════
1. Each depot OS filter = that OS only
2. Store + Developer Comp packages include all three depots
3. Launch Windows: windows/RonkBonk.exe  (Working Dir: windows)
4. Set build Live on "default"
5. Store platforms = Supported OS = what you actually ship
   (current Mac pack is Apple Silicon / arm64 — do not claim Intel Mac
    unless you upload a universal build)

══════════════════════════════════════════════════════════════════
MANUAL REVIEW ZIPS (humans unzipping — NOT SteamPipe)
══════════════════════════════════════════════════════════════════
  RONKBONK_Steam_Windows.zip / Linux / Mac — optional local testing only
