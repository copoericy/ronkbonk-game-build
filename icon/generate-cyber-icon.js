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
        let r = 5, g = 5, b = 10, a = 255;

        const cx = size / 2;
        const cy = size / 2;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

        // Neon glow effect
        const glowStrength = Math.max(0, 1 - dist / (size * 0.7));
        
        // Draw the big "R"
        const isR = (
            // Left vertical bar
            (x >= 80 && x <= 140 && y >= 60 && y <= 450) ||
            // Top horizontal bar
            (x >= 80 && x <= 400 && y >= 60 && y <= 130) ||
            // Middle diagonal bar
            (x >= 140 && x <= 360 && y >= 130 && y <= 260) ||
            (x >= 140 && x <= 320 && y >= 260 && y <= 380) ||
            // Bottom leg
            (x >= 260 && x <= 320 && y >= 260 && y <= 450)
        );

        // Draw robots at bottom
        const robot1X = 140, robot1Y = 380;
        const robot2X = 372, robot2Y = 380;
        
        const isRobot1 = (
            // Head
            (x >= robot1X && x <= robot1X + 60 && y >= robot1Y && y <= robot1Y + 60) ||
            // Body
            (x >= robot1X + 10 && x <= robot1X + 50 && y >= robot1Y + 60 && y <= robot1Y + 100) ||
            // Arm left
            (x >= robot1X - 30 && x <= robot1X && y >= robot1Y + 20 && y <= robot1Y + 40) ||
            // Arm right (punching)
            (x >= robot1X + 60 && x <= robot1X + 100 && y >= robot1Y + 25 && y <= robot1Y + 45) ||
            // Legs
            (x >= robot1X + 10 && x <= robot1X + 25 && y >= robot1Y + 100 && y <= robot1Y + 130) ||
            (x >= robot1X + 35 && x <= robot1X + 50 && y >= robot1Y + 100 && y <= robot1Y + 130)
        );

        const isRobot2 = (
            // Head
            (x >= robot2X && x <= robot2X + 60 && y >= robot2Y && y <= robot2Y + 60) ||
            // Body
            (x >= robot2X + 10 && x <= robot2X + 50 && y >= robot2Y + 60 && y <= robot2Y + 100) ||
            // Arm left (punching)
            (x >= robot2X - 40 && x <= robot2X && y >= robot2Y + 25 && y <= robot2Y + 45) ||
            // Arm right
            (x >= robot2X + 60 && x <= robot2X + 90 && y >= robot2Y + 20 && y <= robot2Y + 40) ||
            // Legs
            (x >= robot2X + 10 && x <= robot2X + 25 && y >= robot2Y + 100 && y <= robot2Y + 130) ||
            (x >= robot2X + 35 && x <= robot2X + 50 && y >= robot2Y + 100 && y <= robot2Y + 130)
        );

        // Sparks between robots
        const sparksX = robot1X + 100;
        const sparksY = robot1Y + 35;
        const isSparks = (
            (x >= sparksX - 5 && x <= sparksX + 5 && y >= sparksY - 20 && y <= sparksY + 20) ||
            (x >= sparksX - 10 && x <= sparksX + 10 && y >= sparksY - 10 && y <= sparksY + 10) ||
            Math.random() > 0.95 && Math.abs(x - sparksX) < 20 && Math.abs(y - sparksY) < 20
        );

        if (isR) {
            r = 255; g = 50; b = 150;
            if (glowStrength > 0.3) {
                r += Math.floor(50 * glowStrength);
                g += Math.floor(30 * glowStrength);
            }
        } else if (isRobot1) {
            r = 255; g = 50; b = 100;
        } else if (isRobot2) {
            r = 50; g = 150; b = 255;
        } else if (isSparks) {
            r = 255; g = 200 + Math.floor(Math.random() * 55); b = 50;
            a = 200 + Math.floor(Math.random() * 55);
        } else if (isR || isRobot1 || isRobot2) {
            // Glow effect
            r = Math.floor(50 + 100 * glowStrength);
            g = Math.floor(20 + 30 * glowStrength);
            b = Math.floor(50 + 50 * glowStrength);
        }

        pixels.push({ r, g, b, a });
    }
}

const png = createPNG(size, size, pixels);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);

console.log('Cyberpunk icon with robots generated: icon.png (512x512)');
