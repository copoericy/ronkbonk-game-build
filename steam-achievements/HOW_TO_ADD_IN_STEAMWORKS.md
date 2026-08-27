# How to Add RonkBonk Achievements in Steamworks

App ID: **4887920**  
Achievements admin: https://partner.steamgames.com/apps/achievements/4887920

Use this pack’s `STEAMWORKS_FILL_LIST.md` / `achievements.csv` for exact strings, and the JPG icons under `icons/`.

## Steps

1. Open https://partner.steamgames.com/apps/achievements/4887920 while logged into Steamworks Partner.
2. Click **New Achievement**.
3. Paste the **API Name** exactly (e.g. `ACH_TUTORIAL`). Do not change casing or spelling — the game code unlocks by this name.
4. Paste the **Display Name** and **Description** from the fill list / CSV.
5. Upload icons:
   - **Achieved** icon: `icons/achieved/<API_NAME>.jpg`
   - **Unachieved** icon: `icons/unachieved/<API_NAME>.jpg`
6. Set **Hidden** to **No** (all achievements in this pack are visible).
7. Save the achievement.
8. Repeat steps 2–7 for every row in the fill list (31 total).
9. When all achievements are added and look correct, click **Publish** so they go live for the app.
10. If needed, enable **Achievements** under the app’s **Supported Features** (or equivalent Steamworks App Admin feature flags) so Steam exposes achievements for this App ID.

## Checklist

- [ ] All 31 API names match the game exactly
- [ ] Display names and descriptions pasted correctly
- [ ] Achieved + unachieved 256×256 icons uploaded for each
- [ ] Hidden = No for all
- [ ] Published
- [ ] Achievements supported feature enabled (if not already)

## Notes

- API names are permanent once published; fix typos before publish.
- Icons in this pack are 256×256 JPG, suitable for Steamworks upload.
