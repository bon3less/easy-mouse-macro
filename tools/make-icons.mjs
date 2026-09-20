/*
 * Generates the extension icons (no external assets, no build step needed).
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const SAMPLES = 4;

function coverage(size, fn) {
  let hit = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      if (fn((sx + 0.5) / SAMPLES, (sy + 0.5) / SAMPLES)) hit++;
    }
  }
  return hit / (SAMPLES * SAMPLES);
}

function makeIcon(size) {
  const cx = 0.5;
  const cy = 0.5;
  const rOuter = 0.48;
  const inCircle = (u, v) => {
    const dx = u - cx;
    const dy = v - cy;
    return Math.sqrt(dx * dx + dy * dy) <= rOuter;
  };
  // Play triangle, only worth drawing at >= 32px.
  const inTriangle = (u, v) => {
    if (u < 0.36 || u > 0.7) return false;
    const span = (u - 0.36) / 0.34; // 0..1 left -> right
    const half = 0.26 * (1 - span); // tapering half height
    return Math.abs(v - 0.5) <= half;
  };

  return encodePng(size, (x, y, s) => {
    const u = (x + 0.5) / s;
    const v = (y + 0.5) / s;
    const a = coverage(s, (su, sv) => inCircle((x + su) / s, (y + sv) / s));
    if (a === 0) return [0, 0, 0, 0];

    // vertical gradient disc
    const t = v;
    let r = Math.round(225 + (163 - 225) * t);
    let g = Math.round(74 + (32 - 74) * t);
    let b = Math.round(74 + (32 - 74) * t);

    if (size >= 32) {
      const tri = coverage(s, (su, sv) => inTriangle((x + su) / s, (y + sv) / s));
      r = Math.round(r + (255 - r) * tri);
      g = Math.round(g + (255 - g) * tri);
      b = Math.round(b + (255 - b) * tri);
    }
    return [r, g, b, Math.round(a * 255)];
  });
}

for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, makeIcon(size));
  console.log('wrote', file);
}
