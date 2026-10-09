/**
 * Genereert de systeemvak-icoon (assets/tray-icon.png) zonder externe
 * dependencies. Een sage-groen afgerond vierkant met drie witte tekstbalken —
 * hetzelfde palet als de app (#8A9482). 32×32 met 4× supersampling zodat de
 * randen op een hoge-DPI taakbalk toch glad zijn.
 *
 * Draaien: node scripts/make-tray-icon.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 32;
const SS = 4; // subsamples per as

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = clamp(x, x0 + r, x1 - r);
  const cy = clamp(y, y0 + r, y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const SAGE = [138, 148, 130];

// Icon glyph, in final-pixel coördinaten.
const square = { x0: 2, y0: 2, x1: 30, y1: 30, r: 6 };
const bars = [
  { x0: 8, y0: 9, x1: 24, y1: 11.5, r: 1.25 },
  { x0: 8, y0: 14.5, x1: 24, y1: 17, r: 1.25 },
  { x0: 8, y0: 20, x1: 18, y1: 22.5, r: 1.25 },
];

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let insideSquare = 0;
    let insideBar = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        if (inRoundedRect(fx, fy, square.x0, square.y0, square.x1, square.y1, square.r)) {
          insideSquare++;
          if (bars.some((b) => inRoundedRect(fx, fy, b.x0, b.y0, b.x1, b.y1, b.r))) insideBar++;
        }
      }
    }
    const total = SS * SS;
    const alpha = insideSquare / total;
    const white = insideBar / total;
    // Kleur mengen: sage → wit naar rato van de balk-dekking.
    raw[p++] = Math.round(SAGE[0] + (255 - SAGE[0]) * (white / (alpha || 1)));
    raw[p++] = Math.round(SAGE[1] + (255 - SAGE[1]) * (white / (alpha || 1)));
    raw[p++] = Math.round(SAGE[2] + (255 - SAGE[2]) * (white / (alpha || 1)));
    raw[p++] = Math.round(alpha * 255);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'tray-icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes)`);
