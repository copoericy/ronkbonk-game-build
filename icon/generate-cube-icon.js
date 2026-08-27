const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function createPNG(width, height, pixels) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    function crc32(data) {
        let crc = 0xFFFFFFFF;
        const table = [];
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c;
        }
        for (let i = 0; i < data.length; i++) {
            crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function createChunk(type, data) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const typeBuffer = Buffer.from(type);
        const crcData = Buffer.concat([typeBuffer, data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(crcData));
        return Buffer.concat([length, typeBuffer, data, crc]);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const rawData = [];
    for (let y = 0; y < height; y++) {
        rawData.push(0);
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const pixel = pixels[idx];
            rawData.push(pixel.r, pixel.g, pixel.b, pixel.a);
        }
    }

    const zlib = require('zlib');
    const compressed = zlib.deflateSync(Buffer.from(rawData));

    return Buffer.concat([
        signature,
        createChunk('IHDR', ihdr),
        createChunk('IDAT', compressed),
        createChunk('IEND', Buffer.alloc(0))
    ]);
}

function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi + 0.00001) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function mix(a, b, t) {
    return a + (b - a) * t;
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function lerpColor(c1, c2, t) {
    return {
        r: Math.round(mix(c1.r, c2.r, t)),
        g: Math.round(mix(c1.g, c2.g, t)),
        b: Math.round(mix(c1.b, c2.b, t)),
        a: Math.round(mix(c1.a, c2.a, t))
    };
}

function addGlow(base, glow, amount) {
    return {
        r: clamp(base.r + glow.r * amount, 0, 255),
        g: clamp(base.g + glow.g * amount, 0, 255),
        b: clamp(base.b + glow.b * amount, 0, 255),
        a: clamp(base.a + glow.a * amount, 0, 255)
    };
}

const size = 1024;
const cx = size / 2;
const cy = size / 2 + 20;
const cubeSize = 220;

// Isometric cube faces (clockwise polygons)
const topFace = [
    [cx, cy - cubeSize * 0.55],
    [cx + cubeSize * 0.62, cy - cubeSize * 0.08],
    [cx, cy + cubeSize * 0.18],
    [cx - cubeSize * 0.62, cy - cubeSize * 0.08]
];

const leftFace = [
    [cx - cubeSize * 0.62, cy - cubeSize * 0.08],
    [cx, cy + cubeSize * 0.18],
    [cx, cy + cubeSize * 0.78],
    [cx - cubeSize * 0.62, cy + cubeSize * 0.52]
];

const rightFace = [
    [cx + cubeSize * 0.62, cy - cubeSize * 0.08],
    [cx, cy + cubeSize * 0.18],
    [cx, cy + cubeSize * 0.78],
    [cx + cubeSize * 0.62, cy + cubeSize * 0.52]
];

const topColor = { r: 255, g: 26, b: 26, a: 255 };
const leftColor = { r: 190, g: 12, b: 12, a: 255 };
const rightColor = { r: 120, g: 0, b: 0, a: 255 };
const glowColor = { r: 255, g: 20, b: 20, a: 255 };
const black = { r: 0, g: 0, b: 0, a: 255 };

const pixels = [];

for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
        const nx = (x - cx) / (size * 0.5);
        const ny = (y - cy) / (size * 0.5);
        const squircle = Math.pow(Math.abs(nx), 4) + Math.pow(Math.abs(ny), 4);
        const inSquircle = squircle <= 1.0;

        if (!inSquircle) {
            pixels.push({ r: 0, g: 0, b: 0, a: 0 });
            continue;
        }

        let color = { ...black };

        // Soft red halo behind the cube
        const glowDist = Math.hypot(x - cx, y - (cy + 10));
        const glowStrength = Math.max(0, 1 - glowDist / (cubeSize * 1.35));
        const halo = Math.pow(glowStrength, 2.2);
        color = addGlow(color, glowColor, halo * 0.55);

        // Thin glowing border around squircle edge
        const edgeDist = 1.0 - squircle;
        if (edgeDist < 0.018) {
            const edgeStrength = 1 - (edgeDist / 0.018);
            color = addGlow(color, glowColor, edgeStrength * 0.95);
        }

        // Draw cube faces back-to-front
        if (pointInPolygon(x, y, leftFace)) {
            color = leftColor;
        }
        if (pointInPolygon(x, y, rightFace)) {
            color = rightColor;
        }
        if (pointInPolygon(x, y, topFace)) {
            color = topColor;
        }

        // Edge highlight on cube
        const edgeGlowDist = Math.min(
            Math.abs(x - cx) / (cubeSize * 0.62),
            Math.abs(y - (cy + cubeSize * 0.18)) / (cubeSize * 0.55)
        );
        if (pointInPolygon(x, y, topFace) && edgeGlowDist > 0.82) {
            color = lerpColor(color, { r: 255, g: 120, b: 120, a: 255 }, 0.35);
        }

        pixels.push(color);
    }
}

const outputDir = __dirname;
const pngPath = path.join(outputDir, 'icon.png');
const cubePath = path.join(outputDir, 'cube-icon.png');
const pngBuffer = createPNG(size, size, pixels);
fs.writeFileSync(pngPath, pngBuffer);
fs.writeFileSync(cubePath, pngBuffer);
console.log('Created icon.png and cube-icon.png (1024x1024)');

// Generate macOS ICNS via iconutil
const iconsetDir = path.join(outputDir, 'icon.iconset');
if (fs.existsSync(iconsetDir)) {
    fs.rmSync(iconsetDir, { recursive: true, force: true });
}
fs.mkdirSync(iconsetDir, { recursive: true });

const iconSizes = [16, 32, 64, 128, 256, 512];
for (const iconSize of iconSizes) {
    const resized = resizeNearest(pixels, size, size, iconSize, iconSize);
    fs.writeFileSync(
        path.join(iconsetDir, `icon_${iconSize}x${iconSize}.png`),
        createPNG(iconSize, iconSize, resized)
    );
    const size2x = iconSize * 2;
    const resized2x = resizeNearest(pixels, size, size, size2x, size2x);
    fs.writeFileSync(
        path.join(iconsetDir, `icon_${iconSize}x${iconSize}@2x.png`),
        createPNG(size2x, size2x, resized2x)
    );
}

try {
    execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(outputDir, 'icon.icns')}"`);
    fs.rmSync(iconsetDir, { recursive: true, force: true });
    console.log('Created icon.icns for Mac');
} catch (err) {
    console.warn('iconutil failed (Mac only):', err.message);
}

// Generate Windows ICO with multiple sizes
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoImages = icoSizes.map(s => ({
    width: s,
    height: s,
    buffer: createPNG(s, s, resizeNearest(pixels, size, size, s, s))
}));
fs.writeFileSync(path.join(outputDir, 'icon.ico'), createMultiSizeIco(icoImages));
console.log('Created icon.ico for Windows');

function resizeNearest(srcPixels, srcW, srcH, dstW, dstH) {
    const out = [];
    for (let y = 0; y < dstH; y++) {
        for (let x = 0; x < dstW; x++) {
            const sx = Math.floor(x * srcW / dstW);
            const sy = Math.floor(y * srcH / dstH);
            out.push(srcPixels[sy * srcW + sx]);
        }
    }
    return out;
}

function createMultiSizeIco(images) {
    const count = images.length;
    const headerSize = 6;
    const dirEntrySize = 16;
    let offset = headerSize + dirEntrySize * count;
    const entries = [];
    const dataChunks = [];

    for (const image of images) {
        entries.push({
            width: image.width === 256 ? 0 : image.width,
            height: image.height === 256 ? 0 : image.height,
            size: image.buffer.length,
            offset
        });
        dataChunks.push(image.buffer);
        offset += image.buffer.length;
    }

    const out = Buffer.alloc(offset);
    out.writeUInt16LE(0, 0);
    out.writeUInt16LE(1, 2);
    out.writeUInt16LE(count, 4);

    let cursor = headerSize;
    for (const entry of entries) {
        out[cursor++] = entry.width;
        out[cursor++] = entry.height;
        out[cursor++] = 0;
        out[cursor++] = 0;
        out.writeUInt16LE(1, cursor); cursor += 2;
        out.writeUInt16LE(32, cursor); cursor += 2;
        out.writeUInt32LE(entry.size, cursor); cursor += 4;
        out.writeUInt32LE(entry.offset, cursor); cursor += 4;
    }

    for (const chunk of dataChunks) {
        chunk.copy(out, cursor);
        cursor += chunk.length;
    }

    return out;
}
