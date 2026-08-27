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

// Create larger pixel R icon (256x256)
const size = 256;
const pixels = [];

for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
        const isR = (
            // Left vertical bar
            (x >= 32 && x <= 80 && y >= 32 && y <= 224) ||
            // Top horizontal bar
            (x >= 32 && x <= 192 && y >= 32 && y <= 80) ||
            // Middle horizontal bar
            (x >= 32 && x <= 160 && y >= 96 && y <= 144) ||
            // Diagonal
            (y >= 144 && y <= 160 && x >= (y - 144) * 3 && x <= (y - 144) * 3 + 64) ||
            (y >= 160 && y <= 176 && x >= 48 && x <= 192) ||
            // Bottom leg
            (x >= 128 && x <= 176 && y >= 160 && y <= 224)
        );

        if (isR) {
            pixels.push({ r: 255, g: 200, b: 0, a: 255 }); // Yellow R
        } else if (y < size / 2) {
            pixels.push({ r: 0, g: 0, b: 0, a: 255 }); // Black background top
        } else {
            pixels.push({ r: 255, g: 0, b: 64, a: 255 }); // Red background bottom
        }
    }
}

const png = createPNG(size, size, pixels);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);

console.log('Large icon generated: icon.png (256x256)');
