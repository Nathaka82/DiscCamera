import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

// Rasterize the code-native ring mark into actual PNGs for iOS Home Screen icons.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function png(size) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  const bg = [11, 11, 11];
  const fg = [255, 255, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const dx = (x + (sx + 0.5) / 4) / size * 512 - 256;
        const dy = (y + (sy + 0.5) / 4) / size * 512 - 256;
        const r = Math.hypot(dx, dy);
        if (r <= 158 && r >= 64.78) coverage += 1 / 16;
      }
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[offset + c] = Math.round(bg[c] + (fg[c] - bg[c]) * coverage);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const icons = new URL('../web/icons/', import.meta.url);
await mkdir(icons, { recursive: true });
for (const [size, name] of [[180, 'apple-touch-icon.png'], [192, 'icon-192.png'], [512, 'icon-512.png']]) {
  await writeFile(new URL(name, icons), png(size));
}
console.log('Generated Home Screen icons (180, 192, 512 px).');
