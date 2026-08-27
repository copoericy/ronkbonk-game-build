const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const www = path.join(root, 'www');

const includeFiles = [
  'index.html',
  'game.js',
  'style.css',
  'theme-ambience.css',
  'package.json'
];

const includeGlobs = ['*.wav', '*.mp3'];

function emptyDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

emptyDir(www);

for (const file of includeFiles) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) copyFile(src, path.join(www, file));
}

for (const name of fs.readdirSync(root)) {
  if (includeGlobs.some((pattern) => {
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
    return name === pattern;
  })) {
    copyFile(path.join(root, name), path.join(www, name));
  }
}

copyDir(path.join(root, 'icon'), path.join(www, 'icon'));
copyDir(path.join(root, 'ai_learning'), path.join(www, 'ai_learning'));

console.log('Staged web assets → www/');
