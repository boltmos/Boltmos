const fs = require('fs');
const path = require('path');

// Valid 16x16 PNG: solid green circle on transparent background
const iconBuffer = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0, 31, 243, 255,
  97, 0, 0, 0, 48, 73, 68, 65, 84, 120, 218, 99, 96, 24, 188, 224,
  4, 195, 127, 20, 76, 182, 70, 146, 12, 34, 164, 153, 160, 33, 20, 25,
  64, 172, 102, 156, 134, 12, 3, 3, 6, 62, 22, 168, 146, 144, 168, 146,
  148, 7, 59, 0, 0, 77, 255, 199, 17, 39, 103, 34, 231, 0, 0, 0,
  0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

fs.writeFileSync(path.join(assetsDir, 'tray.png'), iconBuffer);
console.log('Icon created!');
