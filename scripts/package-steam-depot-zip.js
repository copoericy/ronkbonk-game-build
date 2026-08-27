/**
 * Stage per-OS Steam depots and create SteamPipe VDFs + optional HTTP zips.
 *
 * Download size fix: one depot per OS so Steam only downloads the matching platform.
 *   4887921 = Windows
 *   4887922 = Linux
 *   4887923 = macOS
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, '..', 'output');
const ARCHIVES = path.join(OUTPUT, 'archives');
const STAGING = path.join(OUTPUT, 'steam', 'depot-staging');
const STEAM_DIR = path.join(OUTPUT, 'steam');
const MYSTEAM = process.platform === 'win32'
    ? 'd:\\mysteamgame'
    : path.join(OUTPUT, 'mysteam-mirror');
const APP_ID = '4887920';
/** Planned depot IDs — create 4887922/4887923 in Steamworks if missing; IDs are usually sequential. */
const DEPOT = {
    windows: '4887921',
    linux: '4887922',
    mac: '4887923'
};
const DEPOT_ZIP = path.join(STEAM_DIR, `RonkBonk-Depot-${DEPOT.windows}-windows.zip`);
const DEPOT_ZIP_COPY = path.join(MYSTEAM, `RonkBonk-Depot-${DEPOT.windows}-windows.zip`);
const VERSION = require(path.join(ROOT, 'package.json')).version;

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function rmDir(dir) {
    if (!fs.existsSync(dir)) return;
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        console.warn('[depot] Could not remove staging dir, using fresh subfolder:', err.message);
    }
}

function copyDir(src, dest) {
    ensureDir(path.dirname(dest));
    fs.cpSync(src, dest, { recursive: true, force: true });
}

function findArchive(pattern) {
    if (!fs.existsSync(ARCHIVES)) return null;
    return fs.readdirSync(ARCHIVES)
        .filter((name) => !name.startsWith('._') && !name.startsWith('.'))
        .filter((name) => pattern.test(name))
        .map((name) => path.join(ARCHIVES, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function extractWinZip(zipPath, destDir) {
    ensureDir(destDir);
    console.log('[depot] Extracting Windows ->', destDir);
    if (process.platform === 'win32') {
        execSync(
            `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force"`,
            { stdio: 'inherit', shell: true }
        );
        return;
    }
    execSync(
        `tar -xf "${zipPath}" -C "${destDir}"`,
        { stdio: 'inherit', shell: true }
    );
}

function stageWindows(stagingRoot) {
    const destDir = path.join(stagingRoot, 'windows');
    const candidates = [
        path.join(ROOT, '_steam_pack', 'windows'),
        path.join(ROOT, 'steam-build', 'win-unpacked'),
        path.join(ROOT, 'steam-build-fresh', 'win-unpacked')
    ];
    // Prefer the newest RonkBonk.exe among candidates that exist.
    const existing = candidates
        .filter((p) => fs.existsSync(path.join(p, 'RonkBonk.exe')))
        .sort((a, b) => fs.statSync(path.join(b, 'RonkBonk.exe')).mtimeMs - fs.statSync(path.join(a, 'RonkBonk.exe')).mtimeMs);
    for (const unpacked of existing) {
        console.log('[depot] Copying Windows unpacked ->', destDir, 'from', unpacked);
        copyDir(unpacked, destDir);
        return;
    }
    const winZip = findArchive(/win64\.zip$/i) || findArchive(/windows.*\.zip$/i) || findArchive(/-win.*\.zip$/i);
    if (winZip) extractWinZip(winZip, destDir);
    else console.warn('[depot] Missing Windows build in steam-build/ or output/archives/');
}

function stageLinux(stagingRoot) {
    const destDir = path.join(stagingRoot, 'linux');
    const candidates = [
        path.join(ROOT, '_steam_pack', 'linux'),
        path.join(ROOT, 'steam-build-fresh', 'linux-unpacked'),
        path.join(ROOT, 'steam-build', 'linux-unpacked')
    ];
    const existing = candidates
        .filter((p) => fs.existsSync(path.join(p, 'RonkBonk')))
        .sort((a, b) => fs.statSync(path.join(b, 'resources', 'app.asar')).mtimeMs - fs.statSync(path.join(a, 'resources', 'app.asar')).mtimeMs);
    for (const unpacked of existing) {
        console.log('[depot] Copying Linux unpacked ->', destDir, 'from', unpacked);
        copyDir(unpacked, destDir);
        return;
    }
    const linuxTar = findArchive(/linux64.*\.tar\.gz$/i);
    if (linuxTar) extractLinuxTar(linuxTar, destDir);
    else console.warn('[depot] Missing Linux build in steam-build/ or output/archives/');
}

function extractLinuxTar(tarPath, destDir) {
    ensureDir(destDir);
    console.log('[depot] Extracting Linux ->', destDir);
    execSync(
        `tar -xzf "${tarPath}" -C "${destDir}"`,
        { stdio: 'inherit', shell: true }
    );
}

function extractMacZip(zipPath, destDir) {
    ensureDir(destDir);
    console.log('[depot] Extracting macOS ->', destDir);
    execSync(
        `tar -xf "${zipPath}" -C "${destDir}"`,
        { stdio: 'inherit', shell: true }
    );
}

function pruneAppleDouble(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.name === '__MACOSX' || entry.name.startsWith('._')) {
            fs.rmSync(full, { recursive: true, force: true });
            continue;
        }
        if (entry.isDirectory()) pruneAppleDouble(full);
    }
}

/** macOS .app copied on Windows becomes XSym stub files instead of symlinks — materialize real files. */
function isXSymStub(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        return buf.toString() === 'XSym';
    } catch {
        return false;
    }
}

function readXSymTarget(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    return lines[lines.length - 1].trim();
}

function resolveMacRelativePath(baseDir, relPath) {
    const segments = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
    let current = baseDir;
    for (const segment of segments) {
        const next = path.join(current, segment);
        if (!fs.existsSync(next)) {
            throw new Error(`[depot] Missing Mac path segment: ${next}`);
        }
        if (isXSymStub(next)) {
            const target = readXSymTarget(next);
            current = path.isAbsolute(target) ? target : path.resolve(path.dirname(next), target);
            continue;
        }
        current = next;
    }
    return current;
}

function resolveXSymPath(filePath, depth = 0) {
    if (depth > 12) {
        throw new Error(`[depot] XSym resolution too deep: ${filePath}`);
    }
    if (!isXSymStub(filePath)) {
        return filePath;
    }
    const rel = readXSymTarget(filePath);
    const resolved = resolveMacRelativePath(path.dirname(filePath), rel);
    if (isXSymStub(resolved)) {
        return resolveXSymPath(resolved, depth + 1);
    }
    return resolved;
}

function materializeMacApp(srcApp, destApp) {
    if (!fs.existsSync(srcApp)) {
        throw new Error(`[depot] Missing macOS app: ${srcApp}`);
    }
    if (fs.existsSync(destApp)) {
        fs.rmSync(destApp, { recursive: true, force: true });
    }

    /** Same resolved source -> hardlink so Framework binaries are not triplicated on disk/zip. */
    const resolvedCopyMap = new Map();

    function walk(src, dest) {
        const resolvedSrc = resolveXSymPath(src);
        const stat = fs.statSync(resolvedSrc);
        if (stat.isDirectory()) {
            materializeTree(resolvedSrc, dest);
        } else {
            ensureDir(path.dirname(dest));
            const prior = resolvedCopyMap.get(resolvedSrc);
            if (prior && prior !== dest && fs.existsSync(prior)) {
                try {
                    fs.linkSync(prior, dest);
                } catch {
                    fs.copyFileSync(prior, dest);
                }
            } else {
                fs.copyFileSync(resolvedSrc, dest);
                resolvedCopyMap.set(resolvedSrc, dest);
            }
            try {
                fs.chmodSync(dest, stat.mode & 0o777 || 0o755);
            } catch {
                /* Windows */
            }
        }
    }

    function materializeTree(src, dest) {
        ensureDir(dest);
        for (const name of fs.readdirSync(src)) {
            if (name === '__MACOSX' || name.startsWith('._')) continue;
            walk(path.join(src, name), path.join(dest, name));
        }
    }

    materializeTree(srcApp, destApp);
    dedupeMacFrameworkCopies(destApp);
    console.log('[depot] Materialized macOS app (resolved symlinks) ->', destApp);
}

/**
 * Windows materialization expands Current -> A into a full second copy (~260MB+).
 * Keep Versions/A as canonical; drop Versions/Current and recreate junction when possible.
 */
function dedupeMacFrameworkCopies(appRoot) {
    const frameworks = path.join(appRoot, 'Contents', 'Frameworks');
    if (!fs.existsSync(frameworks)) return;

    for (const name of fs.readdirSync(frameworks)) {
        if (!name.endsWith('.framework')) continue;
        const versionsDir = path.join(frameworks, name, 'Versions');
        const versionA = path.join(versionsDir, 'A');
        const versionCurrent = path.join(versionsDir, 'Current');
        if (!fs.existsSync(versionA) || !fs.existsSync(versionCurrent)) continue;
        if (versionA === versionCurrent) continue;

        try {
            fs.rmSync(versionCurrent, { recursive: true, force: true });
            // Prefer a directory junction so on-disk size stays lean for SteamPipe.
            execSync(`cmd /c mklink /J "${versionCurrent}" "${versionA}"`, {
                stdio: 'ignore',
                shell: true
            });
            console.log('[depot] Deduped macOS framework Current -> A junction:', name);
        } catch (err) {
            console.warn('[depot] Could not junction Current->A for', name, '-', err.message);
            // Fallback: leave Current removed; top-level framework files remain real copies.
        }
    }
}

function stageMac(stagingRoot) {
    const destApp = path.join(stagingRoot, 'mac', 'RonkBonk.app');
    const candidates = [
        path.join(ROOT, '_steam_pack', 'mac', 'RonkBonk.app'),
        path.join(OUTPUT, 'mac', 'RonkBonk.app'),
        path.join(ROOT, 'steam-build-fresh', 'mac-arm64', 'RonkBonk.app'),
        path.join(ROOT, 'steam-build-fresh', 'mac', 'RonkBonk.app'),
        path.join(ROOT, 'steam-build', 'mac-arm64', 'RonkBonk.app'),
        path.join(ROOT, 'steam-build', 'mac', 'RonkBonk.app')
    ];
    for (const app of candidates) {
        if (fs.existsSync(path.join(app, 'Contents', 'MacOS', 'RonkBonk'))) {
            materializeMacApp(app, destApp);
            return;
        }
    }
    const macZip = findArchive(/mac.*\.zip$/i) || findArchive(/arm64\.zip$/i);
    if (macZip) {
        const extractDir = path.join(stagingRoot, 'mac');
        ensureDir(extractDir);
        extractMacZip(macZip, extractDir);
        pruneAppleDouble(extractDir);
        const extracted = path.join(extractDir, 'RonkBonk.app');
        if (fs.existsSync(extracted)) {
            materializeMacApp(extracted, destApp);
            return;
        }
    }
    console.warn('[depot] Missing macOS app in output/mac/, steam-build/, or archives/');
}

/** Patch ZIP central directory so Linux/macOS binaries keep +x after HTTP upload (Windows tar -a loses modes). */
function patchZipUnixModes(zipPath, execPathSuffixes) {
    const buf = fs.readFileSync(zipPath);
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset < 0) {
        throw new Error('[depot] Invalid zip: EOCD not found');
    }

    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    const suffixes = execPathSuffixes.map((s) => s.replace(/\\/g, '/'));
    let offset = cdOffset;
    const end = cdOffset + cdSize;
    let patched = 0;

    while (offset < end) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) break;
        const fnLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const fileName = buf.slice(offset + 46, offset + 46 + fnLen).toString('utf8').replace(/\\/g, '/');

        const isExec = suffixes.some((suffix) => fileName === suffix || fileName.endsWith('/' + suffix));
        if (isExec) {
            buf.writeUInt16LE(0x0317, offset + 6);
            buf.writeUInt32LE(((0o100000 | 0o755) << 16) >>> 0, offset + 38);
            patched++;
        }

        offset += 46 + fnLen + extraLen + commentLen;
    }

    fs.writeFileSync(zipPath, buf);
    console.log(`[depot] Patched ${patched} zip entries with unixexecutable (755)`);
}

function collectUnixExecutables(stagingRoot) {
    const suffixes = ['linux/RonkBonk'];
    const macRoot = path.join(stagingRoot, 'mac', 'RonkBonk.app');
    if (!fs.existsSync(macRoot)) return suffixes;

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (entry.name === 'RonkBonk' || entry.name.endsWith('.app') || entry.name.endsWith(' Helper')) {
                suffixes.push(path.relative(stagingRoot, full).replace(/\\/g, '/'));
            }
            if (full.includes(`${path.sep}MacOS${path.sep}`) || full.includes(`${path.sep}Helpers${path.sep}`)) {
                const rel = path.relative(stagingRoot, full).replace(/\\/g, '/');
                if (!suffixes.includes(rel)) suffixes.push(rel);
            }
        }
    }
    walk(macRoot);
    return suffixes;
}

function validateStaging(stagingRoot) {
    const checks = [
        ['windows/RonkBonk.exe', path.join(stagingRoot, 'windows', 'RonkBonk.exe')],
        ['linux/RonkBonk', path.join(stagingRoot, 'linux', 'RonkBonk')],
        ['mac/RonkBonk.app', path.join(stagingRoot, 'mac', 'RonkBonk.app')],
        ['mac/RonkBonk.app/Contents/MacOS/RonkBonk', path.join(stagingRoot, 'mac', 'RonkBonk.app', 'Contents', 'MacOS', 'RonkBonk')],
        ['mac/RonkBonk.app/Contents/Info.plist', path.join(stagingRoot, 'mac', 'RonkBonk.app', 'Contents', 'Info.plist')],
        ['steam_appid.txt', path.join(stagingRoot, 'steam_appid.txt')],
        ['windows/steam_api64.dll', path.join(stagingRoot, 'windows', 'steam_api64.dll')],
        ['linux/libsteam_api.so', path.join(stagingRoot, 'linux', 'libsteam_api.so')]
    ];
    const missing = checks.filter(([, p]) => !fs.existsSync(p)).map(([label]) => label);
    if (missing.length) {
        throw new Error(`[depot] Staging validation failed — missing: ${missing.join(', ')}`);
    }

    const macFramework = path.join(
        stagingRoot,
        'mac',
        'RonkBonk.app',
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Electron Framework'
    );
    if (fs.existsSync(macFramework) && isXSymStub(macFramework)) {
        throw new Error('[depot] macOS Electron Framework still a broken XSym stub after materialize');
    }

    const linuxSize = fs.statSync(path.join(stagingRoot, 'linux', 'RonkBonk')).size;
    const winSize = fs.statSync(path.join(stagingRoot, 'windows', 'RonkBonk.exe')).size;
    if (linuxSize < 50_000_000 || winSize < 50_000_000) {
        throw new Error('[depot] Platform binary sizes look too small — rebuild electron-builder outputs first');
    }

    const winHasMacApp = path.join(stagingRoot, 'windows');
    if (fs.existsSync(winHasMacApp)) {
        const { execSync: execCheck } = require('child_process');
        try {
            const hit = execCheck(`find "${winHasMacApp}" -iname "*.app" -o -iname "RonkBonk.app"`, {
                encoding: 'utf8'
            }).trim();
            if (hit) {
                throw new Error('[depot] Windows staging contains macOS .app files — aborting mixed-OS depot');
            }
        } catch (err) {
            if (String(err.message || err).includes('mixed-OS')) throw err;
        }
    }

    console.log('[depot] Staging validation passed (all launch paths present)');
}

function writeStamp(stagingRoot) {
    const stamp = [
        `RonkBonk depot staging (per-OS depots)`,
        `Version: ${VERSION}`,
        `Built: ${new Date().toISOString()}`,
        `App ID: ${APP_ID}`,
        `Depots: Windows ${DEPOT.windows} | Linux ${DEPOT.linux} | macOS ${DEPOT.mac}`,
        '',
        'Layout (each OS is its OWN depot — Steam downloads only the matching OS):',
        `  windows/  -> depot ${DEPOT.windows} (Windows only)`,
        `  linux/    -> depot ${DEPOT.linux} (Linux only)`,
        `  mac/      -> depot ${DEPOT.mac} (macOS only)`,
        '  steam_appid.txt — included in each depot root + beside each binary',
        '',
        'Steamworks Launch Options — 2 per OS (paths unchanged):',
        '  Windows: windows/RonkBonk.exe',
        '  Linux:   linux/RonkBonk',
        '  macOS:   mac/RonkBonk.app',
        '  See STEAM_LAUNCH_SETUP.md and STEAM_DEPOT_SPLIT.md',
        ''
    ].join('\n');
    fs.writeFileSync(path.join(stagingRoot, 'DEPOT_README.txt'), stamp);
    fs.copyFileSync(path.join(ROOT, 'steam_appid.txt'), path.join(stagingRoot, 'steam_appid.txt'));
    const copyrightTxt = path.join(ROOT, 'COPYRIGHT.txt');
    if (fs.existsSync(copyrightTxt)) {
        fs.copyFileSync(copyrightTxt, path.join(stagingRoot, 'COPYRIGHT.txt'));
    }
}

/** Drop other-OS Steamworks natives so a Windows depot never contains macOS binaries. */
function pruneOtherOsSteamworksNatives(stagingRoot) {
    const pairs = [
        {
            unpacked: path.join(stagingRoot, 'windows', 'resources', 'app.asar.unpacked', 'node_modules', 'steamworks.js', 'dist'),
            keep: ['win32', 'win64']
        },
        {
            unpacked: path.join(stagingRoot, 'linux', 'resources', 'app.asar.unpacked', 'node_modules', 'steamworks.js', 'dist'),
            keep: ['linux64']
        },
        {
            unpacked: path.join(stagingRoot, 'mac', 'RonkBonk.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'steamworks.js', 'dist'),
            keep: ['osx']
        }
    ];
    for (const { unpacked, keep } of pairs) {
        if (!fs.existsSync(unpacked)) continue;
        for (const name of fs.readdirSync(unpacked)) {
            if (keep.includes(name)) continue;
            const full = path.join(unpacked, name);
            try {
                fs.rmSync(full, { recursive: true, force: true });
                console.log('[depot] Pruned other-OS Steamworks native ->', path.relative(stagingRoot, full));
            } catch (err) {
                console.warn('[depot] Could not prune', full, err.message);
            }
        }
    }
}

/** steam_appid.txt must sit beside each binary for Steam API / dev launches. */
function copySteamAppIdBesideBinaries(stagingRoot) {
    const appIdSrc = path.join(ROOT, 'steam_appid.txt');
    const targets = [
        path.join(stagingRoot, 'windows', 'steam_appid.txt'),
        path.join(stagingRoot, 'linux', 'steam_appid.txt'),
        path.join(stagingRoot, 'mac', 'RonkBonk.app', 'Contents', 'MacOS', 'steam_appid.txt'),
        path.join(stagingRoot, 'mac', 'RonkBonk.app', 'Contents', 'Resources', 'steam_appid.txt')
    ];
    for (const dest of targets) {
        if (fs.existsSync(path.dirname(dest))) {
            fs.copyFileSync(appIdSrc, dest);
        }
    }
}

/** Steam redistributables beside each binary (Steamworks partner checklist). */
function copySteamApiRedist(stagingRoot) {
    const pairs = [
        [
            path.join(stagingRoot, 'windows', 'resources', 'app.asar.unpacked', 'node_modules', 'steamworks.js', 'dist', 'win64', 'steam_api64.dll'),
            path.join(stagingRoot, 'windows', 'steam_api64.dll')
        ],
        [
            path.join(stagingRoot, 'linux', 'resources', 'app.asar.unpacked', 'node_modules', 'steamworks.js', 'dist', 'linux64', 'libsteam_api.so'),
            path.join(stagingRoot, 'linux', 'libsteam_api.so')
        ],
        [
            path.join(stagingRoot, 'mac', 'RonkBonk.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'steamworks.js', 'dist', 'osx', 'libsteam_api.dylib'),
            path.join(stagingRoot, 'mac', 'RonkBonk.app', 'Contents', 'MacOS', 'libsteam_api.dylib')
        ]
    ];
    for (const [src, dest] of pairs) {
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            console.log('[depot] Copied Steam API ->', path.relative(stagingRoot, dest));
        } else {
            console.warn('[depot] Missing Steam API redist:', src);
        }
    }
}

/** Linux/macOS binaries need +x in depot; chmod locally when possible (zip modes patched separately). */
function markUnixExecutables(stagingRoot) {
    const targets = [
        path.join(stagingRoot, 'linux', 'RonkBonk'),
        path.join(stagingRoot, 'mac', 'RonkBonk.app', 'Contents', 'MacOS', 'RonkBonk')
    ];
    const macRoot = path.join(stagingRoot, 'mac', 'RonkBonk.app');
    if (fs.existsSync(macRoot)) {
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (full.includes(`${path.sep}MacOS${path.sep}`) || full.includes(`${path.sep}Helpers${path.sep}`)) {
                    targets.push(full);
                }
            }
        })(macRoot);
    }
    for (const bin of targets) {
        if (!fs.existsSync(bin)) continue;
        try {
            fs.chmodSync(bin, 0o755);
            console.log('[depot] Marked executable (755) ->', path.relative(stagingRoot, bin));
        } catch (err) {
            console.warn('[depot] Could not chmod:', path.relative(stagingRoot, bin), err.message);
        }
    }
}

function collectUnixExecutablePaths(stagingRoot) {
    const paths = ['linux/RonkBonk'];
    const macRoot = path.join(stagingRoot, 'mac', 'RonkBonk.app');
    if (!fs.existsSync(macRoot)) return paths;

    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (
                (full.includes(`${path.sep}MacOS${path.sep}`) ||
                    full.includes(`${path.sep}Helpers${path.sep}`) ||
                    entry.name.endsWith(' Helper') ||
                    entry.name === 'RonkBonk') &&
                !entry.name.endsWith('.dylib') &&
                entry.name !== 'steam_appid.txt'
            ) {
                paths.push(path.relative(stagingRoot, full).replace(/\\/g, '/'));
            }
        }
    })(macRoot);

    return [...new Set(paths)];
}

function formatFileProperties(relPaths) {
    return relPaths
        .map(
            (rel) => `\t"FileProperties"
\t{
\t\t"LocalPath" "${rel}"
\t\t"Attributes" "unixexecutable"
\t}`
        )
        .join('\n');
}

function buildDepotVdf(depotId, contentRoot, folder, fileProperties = '') {
    const props = fileProperties ? `\n${fileProperties}` : '';
    return `"DepotBuild"
{
\t"DepotID" "${depotId}"
\t"ContentRoot" "${contentRoot}"
\t"FileMapping"
\t{
\t\t"LocalPath" "${folder}/*"
\t\t"DepotPath" "${folder}/"
\t\t"recursive" "1"
\t}
\t"FileMapping"
\t{
\t\t"LocalPath" "steam_appid.txt"
\t\t"DepotPath" "."
\t}
\t"FileMapping"
\t{
\t\t"LocalPath" "COPYRIGHT.txt"
\t\t"DepotPath" "."
\t}
\t"FileExclusion" "*.pdb"
\t"FileExclusion" "*.zip"${props}
}
`;
}

function writeSteampipeConfig(vdfDir, contentRoot, desc, stagingRoot) {
    ensureDir(vdfDir);
    const unixPaths = collectUnixExecutablePaths(stagingRoot);
    const linuxProps = formatFileProperties(unixPaths.filter((p) => p.startsWith('linux/')));
    const macProps = formatFileProperties(unixPaths.filter((p) => p.startsWith('mac/')));

    const depotWindows = buildDepotVdf(DEPOT.windows, contentRoot, 'windows');
    const depotLinux = buildDepotVdf(DEPOT.linux, contentRoot, 'linux', linuxProps);
    const depotMac = buildDepotVdf(DEPOT.mac, contentRoot, 'mac', macProps);

    const appVdf = `"AppBuild"
{
\t"AppID" "${APP_ID}"
\t"Desc" "${desc}"
\t"ContentRoot" "${contentRoot}"
\t"BuildOutput" "./steampipe-logs"
\t"Depots"
\t{
\t\t"${DEPOT.windows}" "depot_build_${DEPOT.windows}.vdf"
\t\t"${DEPOT.linux}" "depot_build_${DEPOT.linux}.vdf"
\t\t"${DEPOT.mac}" "depot_build_${DEPOT.mac}.vdf"
\t}
}
`;

    fs.writeFileSync(path.join(vdfDir, `depot_build_${DEPOT.windows}.vdf`), depotWindows);
    fs.writeFileSync(path.join(vdfDir, `depot_build_${DEPOT.linux}.vdf`), depotLinux);
    fs.writeFileSync(path.join(vdfDir, `depot_build_${DEPOT.mac}.vdf`), depotMac);
    // Legacy alias → Windows-only (do not ship all OSes again)
    fs.writeFileSync(path.join(vdfDir, 'depot_build_content.vdf'), depotWindows);
    fs.writeFileSync(path.join(vdfDir, `app_build_${APP_ID}.vdf`), appVdf);
    fs.writeFileSync(path.join(vdfDir, 'app_build.vdf'), appVdf);
    console.log('[depot] Updated steampipe config (per-OS depots) ->', vdfDir);
    console.log(`[depot] Depots: Win ${DEPOT.windows} | Linux ${DEPOT.linux} | Mac ${DEPOT.mac}`);
}

function writeDepotSplitDoc() {
    const srcDoc = path.join(MYSTEAM, 'STEAM_DEPOT_SPLIT.md');
    if (!fs.existsSync(srcDoc)) {
        console.warn('[depot] STEAM_DEPOT_SPLIT.md missing under mysteamgame — skip mirror');
        return;
    }
    ensureDir(STEAM_DIR);
    fs.copyFileSync(srcDoc, path.join(STEAM_DIR, 'STEAM_DEPOT_SPLIT.md'));
}

function writeLaunchDocs(stagingRoot) {
    const launchMd = `# RonkBonk — Steam Launch Setup (App ${APP_ID} / Depots ${DEPOT.windows}·${DEPOT.linux}·${DEPOT.mac})

Path: **Steamworks → Installation → General Installation → Launch Options**

Per-OS depots (download size fix): see **STEAM_DEPOT_SPLIT.md**. Launch paths below are unchanged.

Use **exactly 2 launch options per OS** (Normal + Low Graphics). All paths use **forward slashes**.

---

## Windows (2 options)

### 1 — RonkBonk (Normal) — **Default**

| Field | Value |
|-------|-------|
| **Description** | \`RonkBonk\` |
| **Operating System** | Windows |
| **Executable** | \`windows/RonkBonk.exe\` |
| **Working Directory** | \`windows\` |
| **Launch Type** | Default |

### 2 — RonkBonk (Low Graphics)

| Field | Value |
|-------|-------|
| **Description** | \`RonkBonk — Low Graphics\` |
| **Operating System** | Windows |
| **Executable** | \`windows/RonkBonk.exe\` |
| **Launch Options / Arguments** | \`--ronk-low-gfx\` |
| **Working Directory** | \`windows\` |

---

## Linux + SteamOS (2 options)

### 1 — Default

| Field | Value |
|-------|-------|
| **Description** | \`RonkBonk\` |
| **Operating System** | Linux + SteamOS |
| **Executable** | \`linux/RonkBonk\` |
| **Working Directory** | \`linux\` |
| **Launch Type** | Default |

### 2 — Low Graphics

| Field | Value |
|-------|-------|
| **Description** | \`RonkBonk — Low Graphics\` |
| **Operating System** | Linux + SteamOS |
| **Executable** | \`linux/RonkBonk\` |
| **Launch Options / Arguments** | \`--ronk-low-gfx\` |
| **Working Directory** | \`linux\` |

---

## macOS (2 options)

### 1 — Default

| Field | Value |
|-------|-------|
| **Description** | \`RonkBonk\` |
| **Operating System** | macOS |
| **Executable** | \`mac/RonkBonk.app\` |
| **Working Directory** | \`mac\` |
| **Launch Type** | Default |

### 2 — Low Graphics

| Field | Value |
|-------|-------|
| **Description** | \`RonkBonk — Low Graphics\` |
| **Operating System** | macOS |
| **Executable** | \`mac/RonkBonk.app\` |
| **Launch Options / Arguments** | \`--ronk-low-gfx\` |
| **Working Directory** | \`mac\` |

---

## Depot layout

Each OS is a **separate depot** (\`${DEPOT.windows}\` / \`${DEPOT.linux}\` / \`${DEPOT.mac}\`), but install paths still use \`windows/\`, \`linux/\`, \`mac/\` prefixes.

See **STEAM_DEPOT_SPLIT.md** and **STEAM_PLATFORM_FIX.md**.

Rebuild: \`npm run build:steam:zip\` from game-source.
`;

    const uploadTxt = `RonkBonk — Per-OS Depot Upload (Steam download size < 1 GB)
============================================================

App ID:   ${APP_ID}
Depots:   ${DEPOT.windows} = Windows
          ${DEPOT.linux} = Linux
          ${DEPOT.mac} = macOS

UPLOAD (recommended)
--------------------
cd /d d:\\mysteamgame\\steampipe-config
steamcmd +login <user> +run_app_build app_build_${APP_ID}.vdf +quit

Then: SteamPipe → Builds → Set Live on "default"

HTTP ZIPS (optional)
--------------------
RonkBonk-Depot-${DEPOT.windows}-windows.zip  -> depot ${DEPOT.windows}
RonkBonk-Depot-${DEPOT.linux}-linux.zip      -> depot ${DEPOT.linux}
RonkBonk-Depot-${DEPOT.mac}-mac.zip          -> depot ${DEPOT.mac}

DO NOT upload a combined all-OS zip.

STEAMWORKS (one-time)
---------------------
1. Depot ${DEPOT.windows}: OS = Windows only
2. Create depot ${DEPOT.linux}: OS = Linux
3. Create depot ${DEPOT.mac}: OS = macOS
4. Store + Dev Comp packages: include all three depots
5. Full steps: STEAM_DEPOT_SPLIT.md

LAUNCH OPTIONS (unchanged)
--------------------------
Windows: windows/RonkBonk.exe
Linux:   linux/RonkBonk
macOS:   mac/RonkBonk.app
+ Low Graphics with --ronk-low-gfx

Built: ${new Date().toISOString()}
Version: ${VERSION}
`;

    const mdPath = path.join(STEAM_DIR, 'STEAM_LAUNCH_SETUP.md');
    const uploadPath = path.join(STEAM_DIR, 'DEPOT_UPLOAD_README.txt');
    ensureDir(STEAM_DIR);
    ensureDir(MYSTEAM);
    fs.writeFileSync(mdPath, launchMd);
    fs.writeFileSync(uploadPath, uploadTxt);
    fs.writeFileSync(path.join(stagingRoot, 'DEPOT_UPLOAD_README.txt'), uploadTxt);
    fs.copyFileSync(mdPath, path.join(MYSTEAM, 'STEAM_LAUNCH_SETUP.md'));
    fs.copyFileSync(uploadPath, path.join(MYSTEAM, 'DEPOT_UPLOAD_README.txt'));
    writeDepotSplitDoc();
}

function writePlatformFixDoc(stagingRoot) {
    const fixMd = `# RonkBonk — STEAM_PLATFORM_FIX (App ${APP_ID} / Per-OS Depots)

## Download size

Steam install size is **per depot**. Use **one depot per OS** so Windows stays under 1 GB.
See **STEAM_DEPOT_SPLIT.md** (depots ${DEPOT.windows} / ${DEPOT.linux} / ${DEPOT.mac}).

## Root cause (Platform Support Matches)

**"Platform Support Matches" does NOT validate your local zip.** Steam compares:

1. **Store page** → Basic Info → Supported platforms
2. **Steamworks** → General Application Settings → **Supported Operating Systems**

Those lists must match and be **published**.

| Checklist item | What Steam needs |
|----------------|------------------|
| Launch Options Defined | 6 launch options configured **and published** |
| At least one build configured | steamcmd/HTTP upload, build **live on default** |
| Launch paths resolve | Live per-OS depots contain files at paths below |

---

## Depot layout (paths use windows/ linux/ mac/ prefixes)

\`\`\`
steam_appid.txt
windows/RonkBonk.exe          (depot ${DEPOT.windows})
linux/RonkBonk                (depot ${DEPOT.linux})
mac/RonkBonk.app              (depot ${DEPOT.mac})
\`\`\`

---

## Launch options

Same as STEAM_LAUNCH_SETUP.md (paths unchanged). Publish after editing.

---

## Package / depot settings

| Depot | OS filter | Content |
|-------|-----------|---------|
| ${DEPOT.windows} | Windows | \`windows/\` |
| ${DEPOT.linux} | Linux | \`linux/\` |
| ${DEPOT.mac} | macOS | \`mac/\` |

**Associated Packages** (Store + Dev Comp): include **all three** depots.

---

## Upload

\`\`\`bat
cd /d d:\\mysteamgame\\steampipe-config
steamcmd +login YOUR_STEAM_USER +run_app_build app_build_${APP_ID}.vdf +quit
\`\`\`

Set build live on **default**. Full UI steps: **STEAM_DEPOT_SPLIT.md**.

Built: ${new Date().toISOString()} | Version: ${VERSION}
`;

    const paths = [
        path.join(STEAM_DIR, 'STEAM_PLATFORM_FIX.md'),
        path.join(MYSTEAM, 'STEAM_PLATFORM_FIX.md')
    ];
    for (const p of paths) {
        ensureDir(path.dirname(p));
        fs.writeFileSync(p, fixMd);
    }
    writeDepotSplitDoc();
    console.log('[depot] Wrote STEAM_PLATFORM_FIX.md + STEAM_DEPOT_SPLIT.md');
}

function copyDepotToMySteamGame(stagingRoot) {
    const destRoot = MYSTEAM;
    ensureDir(destRoot);
    const platformDirs = ['windows', 'linux', 'mac'];
    for (const name of platformDirs) {
        const src = path.join(stagingRoot, name);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(destRoot, name);
        if (fs.existsSync(dest)) {
            try {
                fs.rmSync(dest, { recursive: true, force: true });
            } catch (err) {
                console.warn(`[depot] Could not remove old ${name}/ — skipping sync (close RonkBonk if running):`, err.message);
                continue;
            }
        }
        try {
            copyDir(src, dest);
            if (name === 'mac') {
                const app = path.join(dest, 'RonkBonk.app');
                if (fs.existsSync(app)) dedupeMacFrameworkCopies(app);
            }
            console.log('[depot] Synced', name, '->', dest);
        } catch (err) {
            console.warn(`[depot] Could not sync ${name}/ — zip is still valid:`, err.message);
        }
    }
    for (const file of ['steam_appid.txt', 'COPYRIGHT.txt', 'DEPOT_README.txt', 'DEPOT_UPLOAD_README.txt', 'PLAY-RONKBONK.bat', 'ronkbonk-launcher.json', 'WINDOWS_LAUNCH_README.txt']) {
        const src = path.join(stagingRoot, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(destRoot, file));
        }
    }
    const launchDoc = path.join(STEAM_DIR, 'STEAM_LAUNCH_SETUP.md');
    if (fs.existsSync(launchDoc)) {
        fs.copyFileSync(launchDoc, path.join(destRoot, 'STEAM_LAUNCH_SETUP.md'));
    }
    const uploadDoc = path.join(STEAM_DIR, 'DEPOT_UPLOAD_README.txt');
    if (fs.existsSync(uploadDoc)) {
        fs.copyFileSync(uploadDoc, path.join(destRoot, 'DEPOT_UPLOAD_README.txt'));
    }
    console.log('[depot] Staged depot folder ->', destRoot);
}

function stageWindowsLaunchers(stagingRoot) {
    const launchRoot = path.join(ROOT, 'steam-launchers');
    if (!fs.existsSync(launchRoot)) return;
    const winLaunch = path.join(launchRoot, 'windows');
    if (fs.existsSync(winLaunch)) {
        copyDir(winLaunch, path.join(stagingRoot, 'windows'));
        console.log('[depot] Merged Windows launchers ->', path.join(stagingRoot, 'windows'));
    }
    for (const file of ['PLAY-RONKBONK.bat', 'ronkbonk-launcher.json', 'WINDOWS_LAUNCH_README.txt']) {
        const src = path.join(launchRoot, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(stagingRoot, file));
        }
    }
}

function zipWithSevenZipOrTar(zipPath, cwd, entries) {
    const tmpZip = `${zipPath}.tmp-${Date.now()}.zip`;
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
    const sevenZipCandidates = [
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe'
    ];
    const sevenZip = sevenZipCandidates.find((p) => fs.existsSync(p));
    try {
        if (sevenZip) {
            execSync(
                `"${sevenZip}" a -tzip -mx=9 -mmt=on "${tmpZip}" ${entries.map((e) => `"${e}"`).join(' ')}`,
                { stdio: 'inherit', shell: true, cwd }
            );
        } else {
            execSync(
                `tar -a -cf "${tmpZip}" -C "${cwd}" ${entries.map((e) => `"${e}"`).join(' ')}`,
                { stdio: 'inherit', shell: true }
            );
        }
        if (fs.existsSync(zipPath)) {
            try {
                fs.unlinkSync(zipPath);
            } catch {
                const bak = `${zipPath}.old-${Date.now()}`;
                fs.renameSync(zipPath, bak);
                try { fs.unlinkSync(bak); } catch { /* locked; left as .old */ }
            }
        }
        fs.renameSync(tmpZip, zipPath);
    } finally {
        if (fs.existsSync(tmpZip)) {
            try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
        }
    }
}

function createZip(stagingRoot) {
    const uploadDir = path.join(ROOT, 'steam-depot-zips');
    ensureDir(uploadDir);

    const specs = [
        { id: DEPOT.windows, folder: 'windows', name: 'windows' },
        { id: DEPOT.linux, folder: 'linux', name: 'linux' },
        { id: DEPOT.mac, folder: 'mac', name: 'mac' }
    ];

    for (const spec of specs) {
        const platformPath = path.join(stagingRoot, spec.folder);
        if (!fs.existsSync(platformPath)) {
            throw new Error(`[depot] Missing ${spec.folder}/ for depot ${spec.id}`);
        }
        const zipName = `RonkBonk-Depot-${spec.id}-${spec.name}.zip`;
        const zipPath = path.join(uploadDir, zipName);
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
            console.log('[depot] Removed old upload zip ->', zipPath);
        }
        const entries = [spec.folder, 'steam_appid.txt', 'COPYRIGHT.txt'].filter((e) =>
            fs.existsSync(path.join(stagingRoot, e))
        );
        console.log(`[depot] Creating per-OS depot zip ${spec.id} (${spec.name}) ->`, zipPath);
        zipWithSevenZipOrTar(zipPath, stagingRoot, entries);

        if (spec.name !== 'windows') {
            const execPaths = collectUnixExecutables(stagingRoot).filter((p) =>
                p.startsWith(spec.folder + '/')
            );
            patchZipUnixModes(zipPath, execPaths);
        }

        const mb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
        console.log(`[depot] ${zipName}: ${mb} MB (HTTP upload for depot ${spec.id})`);
    }

    // Remove obsolete combined multi-OS zip so it is not re-uploaded by mistake
    const obsolete = [
        path.join(STEAM_DIR, 'RonkBonk-Depot-4887921.zip'),
        path.join(MYSTEAM, 'RonkBonk-Depot-4887921.zip')
    ];
    for (const p of obsolete) {
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
                console.log('[depot] Removed obsolete combined zip ->', p);
            } catch (err) {
                console.warn('[depot] Could not remove obsolete zip:', p, err.message);
            }
        }
    }
}

function packRootReady() {
    const packRoot = path.join(ROOT, '_steam_pack');
    return fs.existsSync(path.join(packRoot, 'windows', 'RonkBonk.exe'))
        && fs.existsSync(path.join(packRoot, 'linux', 'RonkBonk'))
        && fs.existsSync(path.join(packRoot, 'mac', 'RonkBonk.app', 'Contents', 'MacOS', 'RonkBonk'));
}

function main() {
    // Prefer zipping _steam_pack in place — a second copy of Windows+Linux+Mac
    // fills the disk (Valve review machines do not need our local staging clone).
    let stagingRoot;
    if (packRootReady()) {
        stagingRoot = path.join(ROOT, '_steam_pack');
        console.log('[depot] Using _steam_pack in place (no extra copy)');
    } else {
        rmDir(STAGING);
        if (fs.existsSync(STAGING)) {
            const alt = path.join(path.dirname(STAGING), `depot-staging-${Date.now()}`);
            console.warn('[depot] Staging locked; writing to', alt);
            global.__ronkDepotStaging = alt;
        }
        stagingRoot = global.__ronkDepotStaging || STAGING;
        ensureDir(stagingRoot);
        stageWindows(stagingRoot);
        stageLinux(stagingRoot);
        stageMac(stagingRoot);
    }

    pruneAppleDouble(stagingRoot);
    writeStamp(stagingRoot);
    copySteamAppIdBesideBinaries(stagingRoot);
    copySteamApiRedist(stagingRoot);
    pruneOtherOsSteamworksNatives(stagingRoot);
    markUnixExecutables(stagingRoot);
    stageWindowsLaunchers(stagingRoot);
    pruneAppleDouble(stagingRoot);
    validateStaging(stagingRoot);
    writeLaunchDocs(stagingRoot);
    writePlatformFixDoc(stagingRoot);
    createZip(stagingRoot);

    const desc = `RonkBonk v${VERSION} ${new Date().toISOString()}`;
    const outputVdfDir = path.join(STEAM_DIR, 'steampipe-config');
    const outputContentRoot = path.relative(outputVdfDir, stagingRoot).replace(/\\/g, '/');
    writeSteampipeConfig(outputVdfDir, outputContentRoot, desc, stagingRoot);
}

main();
