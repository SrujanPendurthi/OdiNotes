// Generates a simple placeholder app icon (1024x1024 PNG) with zero
// dependencies: an indigo rounded square with a white "O" ring.
// Run `npx tauri icon app-icon.png` afterwards to produce all platform sizes.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const BG = [79, 70, 229]; // indigo-600
const FG = [255, 255, 255];

const cx = SIZE / 2;
const cy = SIZE / 2;
const outer = SIZE * 0.34;
const inner = SIZE * 0.2;
const radius = SIZE * 0.2; // corner radius for the rounded square

// Raw RGBA scanlines, each prefixed with a 0 filter byte.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));

function rounded(x, y) {
  // distance outside the rounded-rect, used as an alpha mask
  const dx = Math.max(radius - x, x - (SIZE - radius), 0);
  const dy = Math.max(radius - y, y - (SIZE - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}

for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // PNG filter type: none
  for (let x = 0; x < SIZE; x++) {
    const off = rowStart + 1 + x * 4;
    let r = 0, g = 0, b = 0, a = 0;
    if (rounded(x + 0.5, y + 0.5)) {
      const d = Math.hypot(x - cx, y - cy);
      const ring = d >= inner && d <= outer;
      [r, g, b] = ring ? FG : BG;
      a = 255;
    }
    raw[off] = r;
    raw[off + 1] = g;
    raw[off + 2] = b;
    raw[off + 3] = a;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// 10,11,12 = 0 (compression, filter, interlace)

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log("Wrote app-icon.png");
