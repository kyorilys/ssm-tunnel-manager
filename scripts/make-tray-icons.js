// Rasterizes the tunnel glyph into the tray PNGs in assets/. Dependency-free: zlib plus a CRC32 PNG encoder.
// Usage: node scripts/make-tray-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const STROKE = 1.6;
const SAMPLES = 4; // supersampling grid per pixel axis

// Glyph geometry in the 16x16 viewBox: line segments and circular arcs (cx, cy, r, from, to in radians).
const SEGMENTS = [
  [[2, 13.5], [2, 8]], [[14, 8], [14, 13.5]],
  [[5.5, 13.5], [5.5, 8.5]], [[10.5, 8.5], [10.5, 13.5]],
  [[1, 13.5], [15, 13.5]],
];
const ARCS = [
  { cx: 8, cy: 8, r: 6 },
  { cx: 8, cy: 8.5, r: 2.5 },
];
const DOT = { cx: 13, cy: 3, r: 2.2 };

function distToSegment(px, py, [[ax, ay], [bx, by]]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Both arcs are upper semicircles (the SVG "a" commands sweep left to right over the top).
function distToArc(px, py, { cx, cy, r }) {
  const dx = px - cx;
  const dy = py - cy;
  if (dy <= 0) return Math.abs(Math.hypot(dx, dy) - r);
  return Math.min(Math.hypot(px - (cx - r), py - cy), Math.hypot(px - (cx + r), py - cy));
}

const inGlyph = (x, y) => SEGMENTS.some((s) => distToSegment(x, y, s) <= STROKE / 2)
  || ARCS.some((a) => distToArc(x, y, a) <= STROKE / 2);
const inDot = (x, y) => Math.hypot(x - DOT.cx, y - DOT.cy) <= DOT.r;

// Returns RGBA bytes for a size x size icon.
function rasterize(size, { dot, rgb }) {
  const scale = 16 / size;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          if (dot && Math.hypot(x - DOT.cx, y - DOT.cy) <= DOT.r + STROKE / 2 + 0.4 && !inDot(x, y)) continue; // clear a ring around the dot
          if (inGlyph(x, y) || (dot && inDot(x, y))) hits++;
        }
      }
      const i = (py * size + px) * 4;
      out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2];
      out[i + 3] = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const VARIANTS = [
  { name: 'trayTemplate', dot: false, rgb: [0, 0, 0] },
  { name: 'trayAlertTemplate', dot: true, rgb: [0, 0, 0] },
  { name: 'trayProd', dot: false, rgb: [0xff, 0x95, 0x00] },
];

function main() {
  const dir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(dir, { recursive: true });
  for (const v of VARIANTS) {
    for (const [size, suffix] of [[16, ''], [32, '@2x']]) {
      fs.writeFileSync(path.join(dir, `${v.name}${suffix}.png`), encodePng(size, rasterize(size, v)));
    }
  }
}

if (require.main === module) main();

module.exports = { rasterize, encodePng };
