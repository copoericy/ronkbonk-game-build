const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const androidDir = path.join(root, 'android');
const uploadRoot = path.join(root, '..', 'android-version');

function run(cmd, opts = {}) {
  console.log('>', cmd);
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
}

require('./stage-www.js');

if (!fs.existsSync(androidDir)) {
  console.log('Initializing Capacitor Android project…');
  run('npx cap add android');
}

run('npx cap sync android');

const gradlew = path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
if (!fs.existsSync(gradlew)) {
  console.error('Android Gradle wrapper not found. Install Android Studio + SDK, then run: npm run setup:android');
  process.exit(1);
}

run(`"${gradlew}" assembleRelease`);

const apkDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release');
if (!fs.existsSync(apkDir)) {
  console.error('Release APK folder not found:', apkDir);
  process.exit(1);
}

const apk = fs.readdirSync(apkDir).find((f) => f.endsWith('.apk'));
if (!apk) {
  console.error('No release APK produced in', apkDir);
  process.exit(1);
}

fs.mkdirSync(uploadRoot, { recursive: true });
const dest = path.join(uploadRoot, 'RonkBonk.apk');
fs.copyFileSync(path.join(apkDir, apk), dest);
console.log('→ android-version/RonkBonk.apk');
