const fs = require('fs');
const path = require('path');
const png2icons = require('png2icons');

const inputPath = path.join(__dirname, 'icon.png');
const outputDir = __dirname;

const pngBuffer = fs.readFileSync(inputPath);

// Generate ICNS (Mac)
const icnsBuffer = png2icons.createICNS(pngBuffer, png2icons.BILINEAR, 0);
fs.writeFileSync(path.join(outputDir, 'icon.icns'), icnsBuffer);
console.log('Created icon.icns for Mac');

// Generate ICO (Windows)
const icoBuffer = png2icons.createICO(pngBuffer, png2icons.BILINEAR, 0);
fs.writeFileSync(path.join(outputDir, 'icon.ico'), icoBuffer);
console.log('Created icon.ico for Windows');

console.log('All icons generated!');
