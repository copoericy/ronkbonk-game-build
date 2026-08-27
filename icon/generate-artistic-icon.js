const fs = require('fs');
const path = require('path');

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

    const ihdrChunk = createChunk('IHDR', ihdr);
    const idatChunk = createChunk('IDAT', compressed);
    const iendChunk = createChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const size = 512;
const pixels = [];

for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
        const cx = size / 2;
        const cy = size / 2;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        const maxDist = size / 2;

        const isR = (
            (x >= 80 && x <= 180 && y >= 60 && y <= 452) ||
            (x >= 80 && x <= 420 && y >= 60 && y <= 150) ||
            (x >= 80 && x <= 360 && y >= 190 && y <= 280) ||
            (y >= 270 && y <= 340 && x >= 240 && x <= 340) ||
            (x >= 240 && x <= 340 && y >= 320 && y <= 452)
        );

        const isGlow = (
            (x >= 60 && x <= 200 && y >= 40 && y <= 472) ||
            (x >= 60 && x <= 440 && y >= 40 && y <= 170) ||
            (x >= 60 && x <= 380 && y >= 170 && y <= 300) ||
            (y >= 250 && y <= 360 && x >= 220 && x <= 360) ||
            (x >= 220 && x <= 360 && y >= 340 && y <= 472)
        );

        const isBorder = dist > maxDist - 40;

        if (isBorder) {
            pixels.push({ r: 20, g: 20, b: 30, a: 255 });
        } else if (isGlow && !isR) {
            const gradientPos = (x + y) / (size * 2);
            const r = Math.floor(255 * (0.6 + 0.4 * Math.sin(gradientPos * Math.PI)));
            const g = Math.floor(100 * (0.8 + 0.2 * Math.cos(gradientPos * Math.PI)));
            const b = Math.floor(50 * (0.9 + 0.1 * Math.sin(gradientPos * Math.PI)));
            pixels.push({ r, g, b, a: 180 });
        } else if (isR) {
            const gradientPos = y / size;
            const r = Math.floor(255 * (0.9 + 0.1 * gradientPos));
            const g = Math.floor(220 * (0.85 + 0.15 * (1 - gradientPos)));
            const b = Math.floor(0);
            pixels.push({ r, g, b, a: 255 });
        } else {
            const gradientPos = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist;
            const r = Math.floor(25 + 10 * gradientPos);
            const g = Math.floor(15 + 5 * gradientPos);
            const b = Math.floor(40 + 15 * gradientPos);
            pixels.push({ r, g, b, a: 255 });
        }
    }
}

const png = createPNG(size, size, pixels);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);

console.log('Artistic icon generated: icon.png (512x512)');
