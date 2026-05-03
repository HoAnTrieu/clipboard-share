#!/usr/bin/env node
// Generates PWA icon PNGs using only Node.js built-ins (no dependencies).

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// Primary color from style.css
const BG = { r: 0x63, g: 0x66, b: 0xf1 };
const FG = { r: 0xff, g: 0xff, b: 0xff };

function setPixel(buf, size, x, y, r, g, b, a = 255) {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 4;
  if (a === 255) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  } else {
    // Alpha blend over existing pixel
    const aa = a / 255;
    const ia = 1 - aa;
    buf[i]     = Math.round(r * aa + buf[i]     * ia);
    buf[i + 1] = Math.round(g * aa + buf[i + 1] * ia);
    buf[i + 2] = Math.round(b * aa + buf[i + 2] * ia);
    buf[i + 3] = 255;
  }
}

function fillRect(buf, size, x1, y1, x2, y2, r, g, b, a = 255) {
  for (let y = y1; y < y2; y++)
    for (let x = x1; x < x2; x++)
      setPixel(buf, size, x, y, r, g, b, a);
}

function fillRoundedRect(buf, size, x1, y1, x2, y2, radius, r, g, b, a = 255) {
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      // Check if pixel is inside rounded corners
      let inside = true;
      const corners = [
        [x1 + radius, y1 + radius], // top-left
        [x2 - radius, y1 + radius], // top-right
        [x1 + radius, y2 - radius], // bottom-left
        [x2 - radius, y2 - radius], // bottom-right
      ];
      for (const [cx, cy] of corners) {
        const inCornerRegion =
          (x < x1 + radius && y < y1 + radius && cx === corners[0][0] && cy === corners[0][1]) ||
          (x >= x2 - radius && y < y1 + radius && cx === corners[1][0] && cy === corners[1][1]) ||
          (x < x1 + radius && y >= y2 - radius && cx === corners[2][0] && cy === corners[2][1]) ||
          (x >= x2 - radius && y >= y2 - radius && cx === corners[3][0] && cy === corners[3][1]);
        if (inCornerRegion) {
          const dx = x - cx;
          const dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > radius + 0.5) { inside = false; break; }
          if (dist > radius - 0.5) {
            // Anti-alias edge
            const coverage = Math.max(0, Math.min(1, radius + 0.5 - dist));
            setPixel(buf, size, x, y, r, g, b, Math.round(a * coverage));
            inside = false;
            break;
          }
        }
      }
      if (inside) setPixel(buf, size, x, y, r, g, b, a);
    }
  }
}

function createIcon(size) {
  const buf = Buffer.alloc(size * size * 4);

  // Fill background
  fillRect(buf, size, 0, 0, size, size, BG.r, BG.g, BG.b);

  const s = (pct) => Math.round(size * pct);

  // Clipboard body (white rounded rect)
  fillRoundedRect(buf, size, s(0.24), s(0.22), s(0.76), s(0.88), s(0.06),
    FG.r, FG.g, FG.b);

  // Clipboard clip (top tab)
  fillRoundedRect(buf, size, s(0.36), s(0.13), s(0.64), s(0.28), s(0.04),
    FG.r, FG.g, FG.b);

  // Content lines (indigo on white)
  const lineH = Math.max(2, s(0.03));
  const lineGap = s(0.12);
  const lineY0 = s(0.40);
  const lines = [
    [s(0.32), s(0.68)],  // long line
    [s(0.32), s(0.68)],  // long line
    [s(0.32), s(0.55)],  // short line
  ];
  for (let i = 0; i < lines.length; i++) {
    const [lx1, lx2] = lines[i];
    const ly = lineY0 + i * lineGap;
    fillRoundedRect(buf, size, lx1, ly, lx2, ly + lineH, Math.floor(lineH / 2),
      BG.r, BG.g, BG.b, 120);
  }

  return encodePNG(buf, size);
}

function encodePNG(pixels, size) {
  // Build raw image data: each row starts with filter byte 0 (None)
  const rawLen = size * (size * 4 + 1);
  const raw = Buffer.alloc(rawLen);
  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0; // filter: None
    pixels.copy(raw, rowOffset + 1, y * size * 4, (y + 1) * size * 4);
  }

  const deflated = zlib.deflateSync(raw, { level: 9 });

  // PNG file
  const chunks = [];

  // Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);  // width
  ihdr.writeUInt32BE(size, 4);  // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(makeChunk('IHDR', ihdr));

  // IDAT
  chunks.push(makeChunk('IDAT', deflated));

  // IEND
  chunks.push(makeChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData) >>> 0, 0);
  return Buffer.concat([len, typeB, data, crc]);
}

// CRC-32 (PNG spec)
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// Generate icons
fs.mkdirSync(OUT_DIR, { recursive: true });

const sizes = [
  [180, 'apple-touch-icon.png'],
  [192, 'icon-192.png'],
  [512, 'icon-512.png'],
];

for (const [size, name] of sizes) {
  const png = createIcon(size);
  const out = path.join(OUT_DIR, name);
  fs.writeFileSync(out, png);
  console.log(`${name} (${size}x${size}) -> ${out}`);
}

console.log('Done!');
