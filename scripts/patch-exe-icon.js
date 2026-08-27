/**
 * Patch Windows .exe icon in-place using resedit (no full electron-builder rebuild).
 * Usage: node scripts/patch-exe-icon.js [path-to-exe]
 */
const fs = require('fs');
const path = require('path');
const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'icon', 'icon.ico');
const DEFAULT_EXE = 'd:\\mysteamgame\\windows\\RonkBonk.exe';

const exePath = path.resolve(process.argv[2] || DEFAULT_EXE);

if (!fs.existsSync(ICON)) {
  console.error('[patch-exe-icon] Missing', ICON, '— run: node icon/generate-cube-icon.js');
  process.exit(1);
}
if (!fs.existsSync(exePath)) {
  console.error('[patch-exe-icon] Missing exe:', exePath);
  process.exit(1);
}

const buffer = fs.readFileSync(exePath);
const executable = NtExecutable.from(buffer);
const res = NtExecutableResource.from(executable);
const iconBuf = fs.readFileSync(ICON);
const iconFile = Data.IconFile.from(iconBuf);
const lang = 0x0409; // en-US
Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, lang, iconFile.icons.map((i) => i.data));
res.outputResource(executable);
fs.writeFileSync(exePath, Buffer.from(executable.generate()));
console.log('[patch-exe-icon] Updated icon ->', exePath);
