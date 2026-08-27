/**
 * RonkBonk intro — fall → impact → letter cubes bounce (earth physics) → slow-mo until ENTER.
 * Same story + timing; canvas letter cubes (no neon DOM title).
 * Fixed-timestep motion so Mac / Windows / Linux / browser stay in sync.
 */
(function (global) {
    'use strict';

    const TIMING = Object.freeze({
        LEAD_MS: 700,
        HOLD_SEC: 1.0,
        FALL_SEC: 2.0,
        FADE_MS: 1400,
        BUTTON_DELAY_MS: 1400,
        SFX_INTERVAL_MS: 520,
        /** Slow-mo starts the instant the cube explodes — keep readable, not slideshow */
        HIT_CHAOS_MS: 0,
        SLOWMO_BLEND_MS: 120,
        SLOWMO_SCALE: 0.16
    });

    const MOTION_FPS = 144;
    const PACE = 0.72;
    const TITLE_WORD = 'RONKBONK';

    /** Earth-ish physics (per motion-frame at MOTION_FPS, scaled by PACE) */
    const PHYS = Object.freeze({
        GRAVITY: 2.15 * PACE,
        RESTITUTION: 0.58,
        FRICTION: 0.82,
        AIR_DRAG: 0.998,
        SPIN_DAMP_FLOOR: 0.62
    });

    const WORLD = Object.freeze({
        FLOOR_Y: 560,
        CEILING_Y: -2200,
        CUBE_START_Y: -8000,
        FALL_DISTANCE: 8510,
        CUBE_SIZE: 100,
        GRID_SPAN: 4800,
        GRID_STEP: 320,
        LETTER_SIZE: 200,
        /** Camera above floor after impact — lower third (synced to Steam packs too) */
        CAM_ABOVE_FLOOR: 340,
        /** Mild look-down so the hit sits under screen center */
        LOOK_DOWN: 0.15
    });

    const IS_ELECTRON = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || '');
    const IS_HIDPI = typeof window !== 'undefined' && (window.devicePixelRatio || 1) >= 1.5;
    /** Electron or HiDPI: lighter strokes — same story/timing, less fill-rate */
    const PERF_LITE = IS_ELECTRON || IS_HIDPI;
    const MAX_PARTICLES = PERF_LITE ? 55 : 90;
    const MAX_SPARKS = PERF_LITE ? 36 : 48;
    const GHOST_COUNT = PERF_LITE ? 2 : 3;
    const GRID_HALF = PERF_LITE ? 10 : 12;

    function fallBeginMs() {
        return TIMING.LEAD_MS + Math.round(TIMING.HOLD_SEC * 1000);
    }

    function spinRates() {
        const fallSpin = 0.52 * (2.72 / TIMING.FALL_SEC);
        const perFrame = {
            rx: 0.05 * fallSpin,
            ry: 0.08 * fallSpin,
            rz: 0.03 * fallSpin
        };
        return {
            fallSpin,
            perSec: {
                rx: perFrame.rx * MOTION_FPS,
                ry: perFrame.ry * MOTION_FPS,
                rz: perFrame.rz * MOTION_FPS
            }
        };
    }

    function hexToRgb(hex) {
        const h = (hex && hex.startsWith('#')) ? hex : '#ff0033';
        return {
            r: parseInt(h.slice(1, 3), 16) || 255,
            g: parseInt(h.slice(3, 5), 16) || 0,
            b: parseInt(h.slice(5, 7), 16) || 51
        };
    }

    function start(config) {
        const {
            canvas,
            overlay,
            titleEl,
            startBtn,
            skipHint,
            creditEl,
            creditShowEl,
            sfx
        } = config;

        if (!canvas || !overlay) return null;

        const ctx = canvas.getContext('2d');
        const rates = spinRates();
        let animId = 0;
        let lastFrameTime = 0;
        let startTime = Date.now();
        let stopped = false;
        let collisionTriggered = false;
        let impactFlash = 0;
        let shockPulse = 0;
        let frameShakeX = 0;
        let frameShakeY = 0;
        let impactRealMs = 0;
        let timeScale = 1;
        let viewW = window.innerWidth;
        let viewH = window.innerHeight;
        let pixelRatio = 1;
        let physAcc = 0;

        const cam = { x: 0, y: 0, z: -2500, zoom: 0.2, shake: 0 };
        const cube = {
            x: 0,
            y: WORLD.CUBE_START_Y,
            z: 0,
            color: '#ff0033',
            size: WORLD.CUBE_SIZE,
            rx: 0,
            ry: 0,
            rz: 0
        };
        const particles = [];
        const sparks = [];
        const shards = [];
        const ghostTrail = [];
        const letters = [];

        if (titleEl) {
            titleEl.classList.add('hidden');
            titleEl.classList.remove('show-intro');
            titleEl.setAttribute('aria-hidden', 'true');
            titleEl.style.visibility = 'hidden';
            titleEl.style.opacity = '0';
            titleEl.style.pointerEvents = 'none';
        }

        let introAmbCache = null;
        let introVigCache = null;
        let introLayerKey = '';

        const rebuildIntroLayerCaches = () => {
            const key = `${viewW}|${viewH}|${PERF_LITE ? 1 : 0}`;
            if (introLayerKey === key && introAmbCache && introVigCache) return;
            introLayerKey = key;

            const amb = document.createElement('canvas');
            amb.width = viewW;
            amb.height = viewH;
            const ambCtx = amb.getContext('2d');
            const grad = ambCtx.createRadialGradient(
                viewW * 0.5, viewH * 0.35, 40,
                viewW * 0.5, viewH * 0.5, viewH * 0.9
            );
            grad.addColorStop(0, 'rgba(60, 0, 15, 0.35)');
            grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ambCtx.fillStyle = grad;
            ambCtx.fillRect(0, 0, viewW, viewH);
            introAmbCache = amb;

            const vig = document.createElement('canvas');
            vig.width = viewW;
            vig.height = viewH;
            const vigCtx = vig.getContext('2d');
            const w = viewW;
            const h = viewH;
            const vigY = 0.48 + WORLD.LOOK_DOWN * 0.5;
            const vigGrad = vigCtx.createRadialGradient(
                w * 0.5, h * vigY, h * 0.15,
                w * 0.5, h * (0.5 + WORLD.LOOK_DOWN * 0.35), h * 0.85
            );
            vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
            vigGrad.addColorStop(0.65, 'rgba(0,0,0,0.15)');
            vigGrad.addColorStop(1, 'rgba(0,0,0,0.72)');
            vigCtx.fillStyle = vigGrad;
            vigCtx.fillRect(0, 0, w, h);
            if (!PERF_LITE) {
                vigCtx.fillStyle = 'rgba(80, 10, 20, 0.045)';
                for (let y = 0; y < h; y += 4) {
                    vigCtx.fillRect(0, y, w, 1);
                }
            }
            introVigCache = vig;
        };

        const resize = () => {
            // Cap like in-game — sharp enough, less Retina fill-rate hitch
            const dprCap = PERF_LITE ? 1.5 : 1.75;
            const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), dprCap);
            pixelRatio = dpr;
            viewW = window.innerWidth;
            viewH = window.innerHeight;
            canvas.width = Math.max(1, Math.floor(viewW * dpr));
            canvas.height = Math.max(1, Math.floor(viewH * dpr));
            canvas.style.width = viewW + 'px';
            canvas.style.height = viewH + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'medium';
            rebuildIntroLayerCaches();
        };

        const project = (x, y, z) => {
            const relX = x - cam.x;
            const relY = y - cam.y;
            const relZ = z - cam.z;
            const factor = 1200 / Math.max(1, relZ);
            const lookBias = viewH * WORLD.LOOK_DOWN;
            return {
                x: (viewW / 2) + (relX * factor * cam.zoom) + frameShakeX,
                y: (viewH / 2) + (relY * factor * cam.zoom) + frameShakeY + lookBias,
                z: relZ,
                f: factor
            };
        };

        const depthAlpha = (relZ, near = 0.55, far = 0.04) => {
            const t = Math.min(1, Math.max(0, (relZ - 200) / 4200));
            return near + (far - near) * t;
        };

        /** Perspective Tron floor + ceiling with depth fog (original upgrade look) */
        const drawTunnel = () => {
            const span = WORLD.GRID_SPAN;
            const step = WORLD.GRID_STEP;
            const floorY = WORLD.FLOOR_Y;
            const ceilY = WORLD.CEILING_Y;

            const drawPlane = (y, colorRgb, baseAlpha) => {
                const { r, g, b } = colorRgb;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                for (let i = -GRID_HALF; i <= GRID_HALF; i++) {
                    const x = i * step;
                    const p1 = project(x, y, -span);
                    const p2 = project(x, y, span);
                    if (p1.z < 0 && p2.z < 0) continue;
                    const midZ = (Math.max(1, p1.z) + Math.max(1, p2.z)) / 2;
                    const a = depthAlpha(midZ) * baseAlpha;
                    ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
                    ctx.lineWidth = midZ < 900 ? (PERF_LITE ? 1.6 : 2.2) : 1.0;
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                }
                for (let i = -GRID_HALF; i <= GRID_HALF; i++) {
                    const z = i * step;
                    const p1 = project(-span, y, z);
                    const p2 = project(span, y, z);
                    if (p1.z < 0 && p2.z < 0) continue;
                    const midZ = (Math.max(1, p1.z) + Math.max(1, p2.z)) / 2;
                    const a = depthAlpha(midZ) * baseAlpha * 0.92;
                    ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
                    ctx.lineWidth = midZ < 900 ? (PERF_LITE ? 1.4 : 2.0) : 0.9;
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                }
            };

            const h0 = project(0, (floorY + ceilY) * 0.5, span * 0.85);
            const h1 = project(0, (floorY + ceilY) * 0.5, -span * 0.2);
            if (h0.z > 0 || h1.z > 0) {
                const hy = (h0.y + h1.y) * 0.5;
                const grad = ctx.createLinearGradient(0, hy - 80, 0, hy + 80);
                grad.addColorStop(0, 'rgba(0,0,0,0)');
                grad.addColorStop(0.45, 'rgba(40,0,8,0.35)');
                grad.addColorStop(0.55, 'rgba(40,0,8,0.35)');
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, hy - 90, viewW, 180);
            }

            drawPlane(floorY, { r: 255, g: 70, b: 90 }, 1.0);
            drawPlane(ceilY, { r: 255, g: 50, b: 70 }, 0.72);

            ctx.save();
            for (const side of [-1, 1]) {
                const x = side * span * 0.72;
                const p1 = project(x, floorY, -span);
                const p2 = project(x, floorY, span);
                const p3 = project(x, ceilY, span);
                const p4 = project(x, ceilY, -span);
                ctx.strokeStyle = 'rgba(0, 220, 255, 0.12)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.lineTo(p3.x, p3.y);
                ctx.lineTo(p4.x, p4.y);
                ctx.stroke();
            }
            ctx.restore();

            drawWallCredit();
        };

        let creditWallTex = null;
        const CREDIT_TEX_W = 1400;
        const CREDIT_TEX_H = 520;

        const drawSpacedTitle = (g, text, cx, cy, fontPx, tracking) => {
            g.font = `900 ${fontPx}px "Orbitron", sans-serif`;
            const chars = text.split('');
            const widths = chars.map((ch) => g.measureText(ch).width);
            let total = 0;
            for (let i = 0; i < widths.length; i++) total += widths[i];
            total += tracking * Math.max(0, chars.length - 1);
            let x = cx - total * 0.5;
            g.textAlign = 'left';
            g.textBaseline = 'middle';
            for (let i = 0; i < chars.length; i++) {
                g.fillText(chars[i], x, cy);
                x += widths[i] + tracking;
            }
        };

        const paintCreditWallTex = (g, w, h) => {
            g.clearRect(0, 0, w, h);
            // Ronk menu title — same Orbitron / red glow, sized to this wall
            const title = 'RONKBONK';
            let titlePx = Math.floor(h * 0.28);
            let tracking = titlePx * 0.14;
            g.font = `900 ${titlePx}px "Orbitron", sans-serif`;
            const fitTitle = () => {
                const chars = title.split('');
                let total = 0;
                for (let i = 0; i < chars.length; i++) total += g.measureText(chars[i]).width;
                total += tracking * (chars.length - 1);
                return total;
            };
            while (titlePx > 48 && fitTitle() > w * 0.9) {
                titlePx -= 4;
                tracking = titlePx * 0.14;
                g.font = `900 ${titlePx}px "Orbitron", sans-serif`;
            }
            const titleY = h * 0.38;
            g.fillStyle = '#ff4040';
            g.shadowColor = 'rgba(255, 70, 70, 0.95)';
            g.shadowBlur = 36;
            drawSpacedTitle(g, title, w * 0.5, titleY, titlePx, tracking);
            g.shadowBlur = 18;
            drawSpacedTitle(g, title, w * 0.5, titleY, titlePx, tracking);
            g.shadowBlur = 0;
            // COPOERIC + ENTER sit in DOM below the wall title — wall is RONKBONK only
        };

        const getCreditWallTex = () => {
            if (creditWallTex) return creditWallTex;
            const c = document.createElement('canvas');
            c.width = CREDIT_TEX_W;
            c.height = CREDIT_TEX_H;
            const g = c.getContext('2d');
            paintCreditWallTex(g, c.width, c.height);
            creditWallTex = c;
            if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
                document.fonts.load('900 120px Orbitron').then(() => {
                    if (stopped) return;
                    const ctx2 = c.getContext('2d');
                    paintCreditWallTex(ctx2, c.width, c.height);
                }).catch(() => { /* keep fallback paint */ });
            }
            return c;
        };

        /** Credit painted onto the far wall plane (part of the room, not a UI pop-in) */
        const drawWallCredit = () => {
            const wallZ = WORLD.GRID_SPAN * 0.42;
            // High on the far wall — RONKBONK title only (credit + ENTER are DOM below)
            const midY = WORLD.CEILING_Y * 0.22 + WORLD.FLOOR_Y * 0.04;
            const halfW = 1180;
            const halfH = 280;
            // Y-up toward ceiling (smaller Y)
            const tl = project(-halfW, midY - halfH, wallZ);
            const tr = project(halfW, midY - halfH, wallZ);
            const br = project(halfW, midY + halfH, wallZ);
            const bl = project(-halfW, midY + halfH, wallZ);
            if (tl.z <= 0 && tr.z <= 0 && br.z <= 0 && bl.z <= 0) return;

            const tex = getCreditWallTex();
            const dpr = pixelRatio;
            const w = tex.width;
            const h = tex.height;
            ctx.save();
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.moveTo(tl.x, tl.y);
            ctx.lineTo(tr.x, tr.y);
            ctx.lineTo(br.x, br.y);
            ctx.lineTo(bl.x, bl.y);
            ctx.closePath();
            ctx.clip();
            ctx.setTransform(
                ((tr.x - tl.x) / w) * dpr,
                ((tr.y - tl.y) / w) * dpr,
                ((bl.x - tl.x) / h) * dpr,
                ((bl.y - tl.y) / h) * dpr,
                tl.x * dpr,
                tl.y * dpr
            );
            ctx.drawImage(tex, 0, 0);
            ctx.restore();
        };

        const drawShockRing = () => {
            if (shockPulse <= 0) return;
            const t = 1 - shockPulse;
            const radius = 80 + t * 900;
            const alpha = shockPulse * 0.55;
            const center = project(cube.x, WORLD.FLOOR_Y + 2, cube.z);
            if (center.z <= 0) return;
            const rx = radius * center.f * cam.zoom * 0.35;
            const ry = radius * center.f * cam.zoom * 0.12;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = 'rgba(255, 60, 90, 0.9)';
            ctx.lineWidth = 3 + shockPulse * 4;
            if (!PERF_LITE) {
                ctx.shadowBlur = 10;
                ctx.shadowColor = '#ff2244';
            }
            ctx.beginPath();
            ctx.ellipse(center.x, center.y, Math.max(4, rx), Math.max(2, ry), 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(0, 220, 255, 0.35)';
            ctx.lineWidth = 1.5;
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.ellipse(center.x, center.y, Math.max(4, rx * 0.72), Math.max(2, ry * 0.72), 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        };

        const drawVignetteAndScanlines = () => {
            if (introVigCache) {
                ctx.drawImage(introVigCache, 0, 0);
                return;
            }
            const w = viewW;
            const h = viewH;
            const vigY = 0.48 + WORLD.LOOK_DOWN * 0.5;
            const vig = ctx.createRadialGradient(w * 0.5, h * vigY, h * 0.15, w * 0.5, h * (0.5 + WORLD.LOOK_DOWN * 0.35), h * 0.85);
            vig.addColorStop(0, 'rgba(0,0,0,0)');
            vig.addColorStop(0.65, 'rgba(0,0,0,0.15)');
            vig.addColorStop(1, 'rgba(0,0,0,0.72)');
            ctx.fillStyle = vig;
            ctx.fillRect(0, 0, w, h);

            // Scanlines are cheap on browser, expensive fill spam in Electron
            if (!PERF_LITE) {
                ctx.fillStyle = 'rgba(80, 10, 20, 0.045)';
                for (let y = 0; y < h; y += 4) {
                    ctx.fillRect(0, y, w, 1);
                }
            }
        };

        const letterTexCache = Object.create(null);
        const getLetterTex = (ch) => {
            if (letterTexCache[ch]) return letterTexCache[ch];
            const c = document.createElement('canvas');
            c.width = 192;
            c.height = 192;
            const g = c.getContext('2d');
            g.clearRect(0, 0, 192, 192);
            g.fillStyle = 'rgba(255,255,255,0.94)';
            g.font = '900 136px Arial Black, Impact, Arial, sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(ch, 96, 104);
            letterTexCache[ch] = c;
            return c;
        };

        const smoothstep = (t) => {
            const x = Math.min(1, Math.max(0, t));
            return x * x * (3 - 2 * x);
        };

        const rotatePoint = (p, rx, ry, rz) => {
            const cosX = Math.cos(rx);
            const sinX = Math.sin(rx);
            const cosY = Math.cos(ry);
            const sinY = Math.sin(ry);
            const cosZ = Math.cos(rz);
            const sinZ = Math.sin(rz);
            let x = p.x * cosZ - p.y * sinZ;
            let y = p.x * sinZ + p.y * cosZ;
            let z = p.z;
            const x1 = x * cosY + z * sinY;
            const z1 = -x * sinY + z * cosY;
            const y2 = y * cosX - z1 * sinX;
            const z2 = y * sinX + z1 * cosX;
            return { x: x1, y: y2, z: z2 };
        };

        /** Paint texture onto a screen-space quad (affine map of one cube face) */
        const drawFaceTexture = (p0, p1, p2, p3, tex) => {
            const w = tex.width;
            const h = tex.height;
            const dpr = pixelRatio;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.lineTo(p3.x, p3.y);
            ctx.closePath();
            ctx.clip();
            // Include DPR so letter UVs stay sharp/aligned on retina
            ctx.setTransform(
                ((p1.x - p0.x) / w) * dpr,
                ((p1.y - p0.y) / w) * dpr,
                ((p3.x - p0.x) / h) * dpr,
                ((p3.y - p0.y) / h) * dpr,
                p0.x * dpr,
                p0.y * dpr
            );
            ctx.globalAlpha = 0.92;
            ctx.drawImage(tex, 0, 0);
            ctx.restore();
        };

        /**
         * True 3D cube: letter (if any) is baked onto a fixed local face (+Z)
         * so it rotates with the mesh — no 2D billboard hopping.
         */
        const drawCube = (c, size, opacity, color, rx, ry, rz, opts = {}) => {
            const half = size / 2;
            const local = [
                { x: -half, y: -half, z: -half }, { x: half, y: -half, z: -half },
                { x: half, y: half, z: -half }, { x: -half, y: half, z: -half },
                { x: -half, y: -half, z: half }, { x: half, y: -half, z: half },
                { x: half, y: half, z: half }, { x: -half, y: half, z: half }
            ];

            const world = local.map((p) => {
                const r = rotatePoint(p, rx, ry, rz);
                return { x: r.x + c.x, y: r.y + c.y, z: r.z + c.z };
            });
            const pts = world.map((p) => project(p.x, p.y, p.z));

            if (pts.every((p) => p.z < 0)) return;

            // Fixed letter face in local space: +Z  (4,5,6,7) with UV p4→(0,0) p5→(1,0) p6→(1,1) p7→(0,1)
            const LETTER_FACE = 1; // index in faces array below (+Z)
            const faces = [
                { idx: [0, 1, 2, 3], shade: 1.05, id: 0 }, // -Z
                { idx: [4, 5, 6, 7], shade: 0.92, id: 1 }, // +Z  ← letter lives here
                { idx: [0, 1, 5, 4], shade: 0.88, id: 2 }, // -Y
                { idx: [2, 3, 7, 6], shade: 0.48, id: 3 }, // +Y
                { idx: [1, 2, 6, 5], shade: 0.95, id: 4 }, // +X
                { idx: [0, 3, 7, 4], shade: 0.68, id: 5 }  // -X
            ];

            faces.forEach((f) => {
                f.z = (pts[f.idx[0]].z + pts[f.idx[1]].z + pts[f.idx[2]].z + pts[f.idx[3]].z) / 4;
            });
            faces.sort((a, b) => b.z - a.z);

            const { r, g, b } = hexToRgb(color);
            const glowBoost = opts.glow != null ? opts.glow : 1;
            const letterChar = opts.letterChar || null;
            const letterTex = letterChar ? getLetterTex(letterChar) : null;

            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';

            faces.forEach((f) => {
                const i0 = f.idx[0];
                const i1 = f.idx[1];
                const i2 = f.idx[2];
                const i3 = f.idx[3];
                const p0 = pts[i0];
                const p1 = pts[i1];
                const p2 = pts[i2];
                const p3 = pts[i3];

                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.lineTo(p3.x, p3.y);
                ctx.closePath();

                const gradient = ctx.createLinearGradient(p0.x, p0.y, p2.x, p2.y);
                const hi = Math.min(1.35, f.shade * 1.22);
                const mid = f.shade;
                const lo = f.shade * 0.48;
                gradient.addColorStop(0, `rgb(${Math.min(255, Math.floor(r * hi + 55))},${Math.min(255, Math.floor(g * hi + 16))},${Math.min(255, Math.floor(b * hi + 24))})`);
                gradient.addColorStop(0.35, `rgb(${Math.floor(r * mid * 1.05)},${Math.floor(g * mid)},${Math.floor(b * mid)})`);
                gradient.addColorStop(0.7, `rgb(${Math.floor(r * mid * 0.85)},${Math.floor(g * mid * 0.7)},${Math.floor(b * mid * 0.75)})`);
                gradient.addColorStop(1, `rgb(${Math.floor(r * lo)},${Math.floor(g * lo * 0.4)},${Math.floor(b * lo * 0.5)})`);
                ctx.fillStyle = gradient;
                ctx.fill();

                if (f.shade > 0.9) {
                    const scx = (p0.x + p1.x + p2.x + p3.x) / 4;
                    const scy = (p0.y + p1.y + p2.y + p3.y) / 4;
                    const core = ctx.createRadialGradient(scx, scy, 2, scx, scy, size * 0.55);
                    core.addColorStop(0, `rgba(255,180,200,${0.28 * glowBoost})`);
                    core.addColorStop(0.5, `rgba(${r},${g},${b},${0.12 * glowBoost})`);
                    core.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.fillStyle = core;
                    ctx.fill();
                }

                // Letter stays on fixed +Z face; only paint when that face faces the camera
                if (letterTex && f.id === LETTER_FACE) {
                    const w0 = world[i0];
                    const w1 = world[i1];
                    const w2 = world[i2];
                    const ax = w1.x - w0.x;
                    const ay = w1.y - w0.y;
                    const az = w1.z - w0.z;
                    const bx = w2.x - w0.x;
                    const by = w2.y - w0.y;
                    const bz = w2.z - w0.z;
                    const nx = ay * bz - az * by;
                    const ny = az * bx - ax * bz;
                    const nz = ax * by - ay * bx;
                    const fcx3 = (world[i0].x + world[i1].x + world[i2].x + world[i3].x) * 0.25;
                    const fcy3 = (world[i0].y + world[i1].y + world[i2].y + world[i3].y) * 0.25;
                    const fcz3 = (world[i0].z + world[i1].z + world[i2].z + world[i3].z) * 0.25;
                    const viewDot = nx * (cam.x - fcx3) + ny * (cam.y - fcy3) + nz * (cam.z - fcz3);
                    if (viewDot > 0) {
                        const fcx = (p0.x + p1.x + p2.x + p3.x) * 0.25;
                        const fcy = (p0.y + p1.y + p2.y + p3.y) * 0.25;
                        const pad = (p, t) => ({ x: p.x + (fcx - p.x) * t, y: p.y + (fcy - p.y) * t });
                        drawFaceTexture(pad(p0, 0.18), pad(p1, 0.18), pad(p2, 0.18), pad(p3, 0.18), letterTex);
                    }
                }

                ctx.strokeStyle = `rgba(255, 255, 255, ${0.55 * glowBoost})`;
                ctx.lineWidth = PERF_LITE ? 2 : 2.5;
                ctx.shadowBlur = PERF_LITE ? 0 : 10 * glowBoost;
                ctx.shadowColor = color;
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.lineTo(p3.x, p3.y);
                ctx.closePath();
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.strokeStyle = `rgba(0, 220, 255, ${0.22 * glowBoost})`;
                ctx.lineWidth = 1;
                ctx.stroke();
            });
            ctx.restore();
        };

        const pushGhost = () => {
            ghostTrail.unshift({
                x: cube.x,
                y: cube.y,
                z: cube.z,
                rx: cube.rx,
                ry: cube.ry,
                rz: cube.rz,
                size: cube.size
            });
            while (ghostTrail.length > GHOST_COUNT) ghostTrail.pop();
        };

        const drawGhosts = () => {
            for (let i = ghostTrail.length - 1; i >= 0; i--) {
                const g = ghostTrail[i];
                const opacity = 0.28 * (1 - i / (GHOST_COUNT + 1));
                drawCube(g, g.size * (1 - i * 0.06), opacity, cube.color, g.rx, g.ry, g.rz, {
                    glow: 0.55
                });
            }
        };

        const spawnShards = () => {
            const shardCount = PERF_LITE ? 8 : 14;
            for (let i = 0; i < shardCount; i++) {
                shards.push({
                    x: cube.x,
                    y: cube.y,
                    z: cube.z,
                    // Prefer side scatter over flying into the camera (Z)
                    vx: (Math.random() - 0.5) * 70 * PACE,
                    vy: (-48 - Math.random() * 58) * PACE,
                    vz: (Math.random() - 0.5) * 28 * PACE,
                    rx: Math.random() * Math.PI * 2,
                    ry: Math.random() * Math.PI * 2,
                    rz: Math.random() * Math.PI * 2,
                    vrx: (Math.random() - 0.5) * 0.28 * PACE,
                    vry: (Math.random() - 0.5) * 0.28 * PACE,
                    vrz: (Math.random() - 0.5) * 0.28 * PACE,
                    size: 28 + Math.random() * 38,
                    color: i % 3 === 0 ? '#0099ff' : '#ff0033',
                    life: 1
                });
            }
        };

        /** Blast letter cubes UP + sideways — not toward the player camera */
        const spawnTitleLetters = () => {
            letters.length = 0;
            const n = TITLE_WORD.length;
            for (let i = 0; i < n; i++) {
                const ang = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
                const lateral = (24 + Math.random() * 30) * PACE;
                letters.push({
                    char: TITLE_WORD[i],
                    x: cube.x + (Math.random() - 0.5) * 20,
                    y: cube.y,
                    z: cube.z + (Math.random() - 0.5) * 20,
                    vx: Math.cos(ang) * lateral,
                    // Strong upward pop so they read as jumping up, not flying into view
                    vy: (-72 - Math.random() * 52) * PACE,
                    // Keep depth motion small so cubes don't rush the camera
                    vz: Math.sin(ang) * lateral * 0.3,
                    rx: Math.random() * Math.PI * 2,
                    ry: Math.random() * Math.PI * 2,
                    rz: Math.random() * Math.PI * 2,
                    vrx: (Math.random() - 0.5) * 0.32 * PACE,
                    vry: (Math.random() - 0.5) * 0.32 * PACE,
                    vrz: (Math.random() - 0.5) * 0.32 * PACE,
                    size: WORLD.LETTER_SIZE * (0.9 + Math.random() * 0.15),
                    color: '#ff0033',
                    isLetter: true
                });
            }
        };

        const spawnImpactSparks = () => {
            for (let i = 0; i < MAX_SPARKS; i++) {
                const ang = (i / MAX_SPARKS) * Math.PI * 2 + Math.random() * 0.2;
                const speed = (14 + Math.random() * 36) * PACE;
                sparks.push({
                    x: cube.x,
                    y: WORLD.FLOOR_Y - 10,
                    z: cube.z,
                    vx: Math.cos(ang) * speed,
                    vy: (-28 - Math.random() * 48) * PACE,
                    vz: Math.sin(ang) * speed * 0.35,
                    life: 1,
                    decay: 0.012 + Math.random() * 0.02,
                    color: Math.random() > 0.35 ? '#ff4466' : '#00ddff',
                    size: 3 + Math.random() * 5
                });
            }
        };

        const onImpact = () => {
            collisionTriggered = true;
            cube.y = WORLD.FLOOR_Y - cube.size / 2;
            impactRealMs = 0;
            // Drop into slow-mo immediately on explode (tiny blend only)
            timeScale = TIMING.SLOWMO_SCALE;
            try {
                sfx.play('hit', 1.4);
                sfx.play('shatter', 0.9);
            } catch (_) { /* ignore */ }
            cam.shake = 220;
            // Sit high above the floor so impact reads in the lower third of the screen
            cam.y = WORLD.FLOOR_Y - WORLD.CAM_ABOVE_FLOOR;
            impactFlash = 1;
            shockPulse = 1;
            ghostTrail.length = 0;
            spawnShards();
            spawnTitleLetters();
            spawnImpactSparks();
            setTimeout(() => {
                if (stopped) return;
                if (startBtn) {
                    startBtn.classList.remove('hidden');
                    startBtn.style.display = 'inline-block';
                }
                if (creditShowEl) {
                    creditShowEl.classList.remove('hidden');
                    creditShowEl.style.display = 'block';
                }
                if (skipHint) skipHint.style.display = 'none';
            }, TIMING.BUTTON_DELAY_MS);
        };

        /** Gravity + floor bounce + friction — no magnets / no word packing */
        const updateRigidBody = (b, ms) => {
            b.vy += PHYS.GRAVITY * ms;
            b.vx *= Math.pow(PHYS.AIR_DRAG, ms);
            b.vz *= Math.pow(PHYS.AIR_DRAG, ms);

            b.x += b.vx * ms;
            b.y += b.vy * ms;
            b.z += b.vz * ms;
            b.rx += b.vrx * ms;
            b.ry += b.vry * ms;
            b.rz += b.vrz * ms;

            const floor = WORLD.FLOOR_Y - b.size / 2;
            if (b.y > floor) {
                b.y = floor;
                if (b.vy > 0) {
                    b.vy *= -PHYS.RESTITUTION;
                    if (Math.abs(b.vy) < 1.2 * PACE) b.vy = 0;
                }
                b.vx *= PHYS.FRICTION;
                b.vz *= PHYS.FRICTION;
                b.vrx *= PHYS.SPIN_DAMP_FLOOR;
                b.vry *= PHYS.SPIN_DAMP_FLOOR;
                b.vrz *= PHYS.SPIN_DAMP_FLOOR;
            }
        };

        const drawLetters = () => {
            const ordered = letters.slice().sort((a, b) => {
                const za = project(a.x, a.y, a.z).z;
                const zb = project(b.x, b.y, b.z).z;
                return zb - za;
            });
            for (let i = 0; i < ordered.length; i++) {
                const L = ordered[i];
                drawCube(L, L.size, 1, L.color, L.rx, L.ry, L.rz, {
                    glow: 0.85,
                    letterChar: L.char
                });
            }
        };

        const drawParticles = (ms) => {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.y += p.vy * ms;
                p.life -= (p.decay || 0.008) * ms;
                const pt = project(p.x, p.y, p.z);
                if (pt.z > 0 && p.life > 0) {
                    const s = Math.max(1, p.size * pt.f * 0.22);
                    ctx.globalAlpha = Math.min(0.85, p.life * 0.7);
                    ctx.fillStyle = p.color;
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, s, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = p.color;
                    ctx.globalAlpha = Math.min(0.45, p.life * 0.4);
                    ctx.lineWidth = Math.max(1, s * 0.35);
                    ctx.beginPath();
                    ctx.moveTo(pt.x, pt.y);
                    ctx.lineTo(pt.x, pt.y - s * 4);
                    ctx.stroke();
                }
                if (p.life <= 0 || p.y < cube.y - 2500) particles.splice(i, 1);
            }
            ctx.restore();
        };

        const updateSparks = (step) => {
            for (let i = sparks.length - 1; i >= 0; i--) {
                const s = sparks[i];
                s.vy += 1.2 * PACE * step;
                s.x += s.vx * step;
                s.y += s.vy * step;
                s.z += s.vz * step;
                s.life -= s.decay * step;
                if (s.life <= 0) sparks.splice(i, 1);
            }
        };

        const drawSparks = () => {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            for (let i = 0; i < sparks.length; i++) {
                const s = sparks[i];
                const pt = project(s.x, s.y, s.z);
                if (pt.z > 0 && s.life > 0) {
                    const r = Math.max(1, s.size * pt.f * 0.2 * s.life);
                    ctx.globalAlpha = Math.min(1, s.life);
                    ctx.fillStyle = s.color;
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            ctx.restore();
        };

        const tick = (frameTime) => {
            if (stopped) return;

            if (document.hidden) {
                lastFrameTime = 0;
                animId = 0;
                return;
            }

            if (!lastFrameTime) lastFrameTime = frameTime;
            // Tighter dt cap = smoother motion, less hitching
            const dt = Math.min((frameTime - lastFrameTime) / 1000, 0.033);
            lastFrameTime = frameTime;
            const frameScale = dt * MOTION_FPS;
            const elapsed = Date.now() - startTime;

            // Slow-mo starts the moment the cube explodes — stays until ENTER
            if (collisionTriggered) {
                impactRealMs += dt * 1000;
                timeScale = TIMING.SLOWMO_SCALE;
            }

            const ms = frameScale * timeScale;

            // Smooth shake sample (less harsh than raw random)
            const shakeEase = cam.shake * cam.shake / Math.max(1, cam.shake + 40);
            frameShakeX = (Math.random() - 0.5) * shakeEase;
            frameShakeY = (Math.random() - 0.5) * shakeEase;

            ctx.fillStyle = '#030008';
            ctx.fillRect(0, 0, viewW, viewH);

            if (introAmbCache) {
                ctx.drawImage(introAmbCache, 0, 0);
            } else {
                const amb = ctx.createRadialGradient(
                    viewW * 0.5, viewH * 0.35, 40,
                    viewW * 0.5, viewH * 0.5, viewH * 0.9
                );
                amb.addColorStop(0, 'rgba(60, 0, 15, 0.35)');
                amb.addColorStop(1, 'rgba(0, 0, 0, 0)');
                ctx.fillStyle = amb;
                ctx.fillRect(0, 0, viewW, viewH);
            }

            if (elapsed < TIMING.LEAD_MS) {
                const leadT = smoothstep(elapsed / TIMING.LEAD_MS);
                cam.y = WORLD.CUBE_START_Y + 250;
                cam.z = -1200;
                cam.zoom = 0.55;
                ctx.globalAlpha = leadT * 0.55;
                drawTunnel();
                ctx.globalAlpha = 1;
                drawVignetteAndScanlines();
                animId = requestAnimationFrame(tick);
                return;
            }

            const fallBegin = fallBeginMs();
            const inHold = elapsed < fallBegin;
            const animSec = (elapsed - TIMING.LEAD_MS) / 1000;
            const fallSec = Math.max(0, (elapsed - fallBegin) / 1000);

            cube.rx = rates.perSec.rx * animSec;
            cube.ry = rates.perSec.ry * animSec;
            cube.rz = rates.perSec.rz * animSec;

            if (!collisionTriggered) {
                if (!inHold) {
                    // Physical fall (quadratic) — camera lerps separately for smoothness
                    const rawT = Math.min(fallSec / TIMING.FALL_SEC, 1);
                    cube.y = WORLD.CUBE_START_Y + WORLD.FALL_DISTANCE * rawT * rawT;
                }

                if (elapsed > TIMING.LEAD_MS && (elapsed - TIMING.LEAD_MS) % TIMING.SFX_INTERVAL_MS < 20) {
                    try {
                        sfx.init();
                        sfx.play('fall', 1.05);
                    } catch (_) { /* ignore */ }
                }

                const holdBlend = inHold ? 0 : smoothstep(Math.min(fallSec / 0.35, 1));
                const followY = cube.y + 250;
                cam.y += (followY - cam.y) * (0.18 + 0.22 * holdBlend);
                cam.z += (-1200 - cam.z) * 0.12;
                cam.zoom += ((0.55 + 0.05 * holdBlend) - cam.zoom) * 0.1;

                if (!inHold && particles.length < MAX_PARTICLES) {
                    particles.push({
                        x: (Math.random() - 0.5) * 1400,
                        y: cube.y + 800 + Math.random() * 600,
                        z: (Math.random() - 0.5) * 1400,
                        vy: (-22 - Math.random() * 28) * rates.fallSpin,
                        color: Math.random() > 0.45 ? '#ff3355' : '#00ccff',
                        size: 4 + Math.random() * 9,
                        life: 1,
                        decay: 0.006 + Math.random() * 0.01
                    });
                }

                if (!inHold && (Math.random() < 0.55 || ghostTrail.length < GHOST_COUNT)) {
                    pushGhost();
                }

                drawTunnel();
                drawGhosts();
                drawParticles(frameScale);
                drawCube(cube, cube.size, 1, cube.color, cube.rx, cube.ry, cube.rz, { glow: 1.15 });

                if (!inHold && cube.y + cube.size / 2 >= WORLD.FLOOR_Y) {
                    onImpact();
                }
            } else {
                // Substep physics so shatter stays smooth under slow-mo
                physAcc += ms;
                const step = 0.45;
                let guard = 0;
                while (physAcc >= step && guard < 24) {
                    for (let i = 0; i < letters.length; i++) {
                        updateRigidBody(letters[i], step);
                    }
                    for (let i = 0; i < shards.length; i++) {
                        const s = shards[i];
                        updateRigidBody(s, step);
                        s.life = Math.max(0.35, s.life - 0.0015 * step);
                    }
                    updateSparks(step);
                    physAcc -= step;
                    guard += 1;
                }

                // Flush leftover motion so nothing stalls
                if (physAcc > 0.001 && guard < 24) {
                    const rem = physAcc;
                    for (let i = 0; i < letters.length; i++) updateRigidBody(letters[i], rem);
                    for (let i = 0; i < shards.length; i++) {
                        updateRigidBody(shards[i], rem);
                        shards[i].life = Math.max(0.35, shards[i].life - 0.0015 * rem);
                    }
                    updateSparks(rem);
                    physAcc = 0;
                }

                // Camera / FX on wall-clock for buttery transitions
                cam.shake *= Math.pow(0.88, frameScale);
                if (cam.shake < 0.35) cam.shake = 0;
                impactFlash = Math.max(0, impactFlash - 0.55 * dt);
                shockPulse = Math.max(0, shockPulse - 0.35 * dt);

                const camLerp = 1 - Math.pow(0.9, frameScale);
                cam.y += (WORLD.FLOOR_Y - WORLD.CAM_ABOVE_FLOOR - cam.y) * camLerp * 0.55;
                // Hold depth — don't pull the camera into the bouncing cubes
                cam.z += (-1280 - cam.z) * camLerp * 0.28;
                cam.zoom += (0.5 - cam.zoom) * camLerp * 0.35;

                drawTunnel();
                drawShockRing();
                drawSparks();

                shards.forEach((s) => {
                    drawCube(s, s.size, s.life, s.color, s.rx, s.ry, s.rz, { glow: 0.85 });
                });

                drawLetters();

                if (impactFlash > 0) {
                    ctx.save();
                    const flashA = impactFlash * impactFlash * 0.8;
                    ctx.globalAlpha = flashA;
                    const flashCy = viewH * (0.5 + WORLD.LOOK_DOWN + 0.08);
                    const flash = ctx.createRadialGradient(
                        viewW * 0.5, flashCy, 20,
                        viewW * 0.5, flashCy, viewH * 0.7
                    );
                    flash.addColorStop(0, 'rgba(255,255,255,0.95)');
                    flash.addColorStop(0.25, 'rgba(255,80,120,0.55)');
                    flash.addColorStop(1, 'rgba(255,0,40,0)');
                    ctx.fillStyle = flash;
                    ctx.fillRect(0, 0, viewW, viewH);
                    ctx.restore();
                }
            }

            drawVignetteAndScanlines();
            animId = requestAnimationFrame(tick);
        };

        const onIntroVisibility = () => {
            if (!document.hidden && !stopped && !animId) {
                lastFrameTime = 0;
                animId = requestAnimationFrame(tick);
            }
        };

        const stop = () => {
            stopped = true;
            cancelAnimationFrame(animId);
            window.removeEventListener('resize', resize);
            document.removeEventListener('visibilitychange', onIntroVisibility);
        };

        window.addEventListener('resize', resize);
        document.addEventListener('visibilitychange', onIntroVisibility);
        resize();
        animId = requestAnimationFrame(tick);

        return {
            getStartTime: () => startTime,
            stop
        };
    }

    global.RonkIntroAnimation = {
        TIMING,
        MOTION_FPS,
        fallBeginMs,
        start
    };
})(typeof window !== 'undefined' ? window : globalThis);
