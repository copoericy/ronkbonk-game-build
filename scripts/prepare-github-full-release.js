/**
 * One folder for GitHub: ALL/ = screenshots + videos + Win/Mac/Linux builds.
 * Output: github-media/ronkbonk-full-release/ALL/
 *
 * Run: node scripts/prepare-github-full-release.js
 * Optional: RONK_SKIP_BUILD=1 to skip electron-builder (use existing archives)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'github-media', 'ronkbonk-full-release');
const ALL = path.join(OUT, 'ALL');
const MEDIA_4K = path.join(ROOT, 'github-media', '4k');
const BUILD_DIR = path.join(ROOT, 'steam-build-fresh');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const GH_USER = 'copoericy';

function ensureDir(d) {
    fs.mkdirSync(d, { recursive: true });
}

function rmDir(d) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}

function copyFile(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

function run(cmd, label) {
    console.log(`\n[github-release] ${label}\n> ${cmd}\n`);
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true });
}

function findArchive(pattern) {
    if (!fs.existsSync(BUILD_DIR)) return null;
    return fs.readdirSync(BUILD_DIR)
        .filter((n) => pattern.test(n))
        .map((n) => path.join(BUILD_DIR, n))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function collectIntoAll() {
    ensureDir(ALL);
    let shots = 0;
    let vids = 0;
    let builds = 0;

    const srcRoot = path.join(MEDIA_4K, 'screenshots');
    if (fs.existsSync(srcRoot)) {
        for (const theme of fs.readdirSync(srcRoot)) {
            const themeDir = path.join(srcRoot, theme);
            if (!fs.statSync(themeDir).isDirectory()) continue;
            for (const file of fs.readdirSync(themeDir)) {
                if (!file.endsWith('.png')) continue;
                copyFile(path.join(themeDir, file), path.join(ALL, `${theme}-${file}`));
                shots++;
            }
        }
    }
    console.log(`[github-release] ${shots} screenshots → ALL/`);

    const vidSrc = path.join(MEDIA_4K, 'videos');
    if (fs.existsSync(vidSrc)) {
        for (const file of fs.readdirSync(vidSrc)) {
            if (!file.endsWith('.mp4')) continue;
            copyFile(path.join(vidSrc, file), path.join(ALL, file));
            vids++;
        }
    }
    console.log(`[github-release] ${vids} videos → ALL/`);

    const specs = [
        { pattern: /win64\.zip$/i, label: 'windows' },
        { pattern: /linux64\.tar\.gz$/i, label: 'linux' },
        { pattern: /mac.*\.zip$/i, label: 'mac' },
        { pattern: /arm64\.zip$/i, label: 'mac-arm' }
    ];
    const seen = new Set();
    for (const spec of specs) {
        const arch = findArchive(spec.pattern);
        if (!arch) {
            if (spec.label === 'mac-arm') continue;
            console.warn(`[github-release] Missing ${spec.label} build in steam-build-fresh/`);
            continue;
        }
        const destName = path.basename(arch);
        if (seen.has(destName)) continue;
        seen.add(destName);
        copyFile(arch, path.join(ALL, destName));
        const mb = (fs.statSync(arch).size / 1024 / 1024).toFixed(1);
        console.log(`[github-release] ${spec.label}: ${destName} (${mb} MB)`);
        builds++;
    }
    return { shots, vids, builds };
}

function writeReadme(shotCount, vidCount, buildCount) {
    const text = `# RonkBonk Full Release (${GH_USER})

**Everything is in \`ALL/\`** — screenshots, videos, and Windows / Linux / macOS game builds.

| In \`ALL/\` | Count |
|-------------|-------|
| Screenshots (4K PNG) | ${shotCount} |
| Videos (4K MP4) | ${vidCount} |
| Game builds | ${buildCount} (Win / Linux / Mac) |

## Play

- **Windows:** unzip \`ALL/RonkBonk-*-win64.zip\` → run \`RonkBonk.exe\`
- **Linux:** extract \`ALL/RonkBonk-*-linux64.tar.gz\` → run \`RonkBonk\`
- **macOS:** unzip \`ALL/RonkBonk-*-mac*.zip\` or arm64 zip → open \`RonkBonk.app\`

## Steam

App ID **4887920** — see \`HOW_TO_UPLOAD_STEAM.md\` in game source.

Built: ${new Date().toISOString()} · v${VERSION}
`;
    fs.writeFileSync(path.join(OUT, 'README.md'), text);
}

function writeGitAttributes() {
    fs.writeFileSync(path.join(OUT, '.gitattributes'), [
        '*.mp4 filter=lfs diff=lfs merge=lfs -text',
        '*.png filter=lfs diff=lfs merge=lfs -text',
        '*.zip filter=lfs diff=lfs merge=lfs -text',
        '*.tar.gz filter=lfs diff=lfs merge=lfs -text',
        ''
    ].join('\n'));
}

function writeGitignore() {
    fs.writeFileSync(path.join(OUT, '.gitignore'), '*.txt\n!README.md\n');
}

function maybeBuildPlatforms() {
    if (process.env.RONK_SKIP_BUILD === '1') {
        console.log('[github-release] RONK_SKIP_BUILD=1 — using existing builds');
        return;
    }
    if (!findArchive(/linux64\.tar\.gz$/i)) {
        try {
            run('npx electron-builder --linux tar.gz --x64 && node scripts/copy-builds.js linux', 'Building Linux x64 (tar.gz)');
        } catch (e) {
            console.warn('[github-release] Linux build failed:', e.message || e);
        }
    }
    if (!findArchive(/mac.*\.zip$/i) && !findArchive(/arm64\.zip$/i)) {
        try {
            run('npm run build:mac', 'Building macOS');
        } catch (e) {
            console.warn('[github-release] Mac build failed (needs macOS):', e.message || e);
        }
    }
    if (!findArchive(/win64\.zip$/i)) {
        try {
            run('npm run build:win', 'Building Windows x64');
        } catch (e) {
            console.warn('[github-release] Windows build failed:', e.message || e);
        }
    }
}

function main() {
    console.log('[github-release] Preparing github-media/ronkbonk-full-release/ALL/ …');
    ensureDir(OUT);
    maybeBuildPlatforms();

    // Refresh ALL/ (and remove old split folders)
    for (const sub of ['ALL', 'screenshots-all', 'videos', 'builds']) {
        rmDir(path.join(OUT, sub));
    }

    const { shots, vids, builds } = collectIntoAll();
    writeReadme(shots, vids, builds);
    writeGitAttributes();
    writeGitignore();

    console.log('\n[github-release] Done → github-media/ronkbonk-full-release/ALL/');
    console.log(`  URL:  https://github.com/${GH_USER}/ronkbonk-full-release`);
}

main();
