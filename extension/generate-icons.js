#!/usr/bin/env node
// Generates simple placeholder icon PNGs for the Dask extension.
// Each icon is a GitHub-green square with "SS" centered text.
// Replace these with proper designed icons before publishing.

const fs = require('fs');
const path = require('path');

// Minimal PNG encoder — writes an uncompressed RGBA PNG.
// (No external dependencies required.)

function createPng(width, height, fillR, fillG, fillB) {
  // We build a raw RGBA image, then wrap it in the PNG container.

  // ── Raw image data (each row starts with a filter byte of 0) ──
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = [0]; // filter: None
    for (let x = 0; x < width; x++) {
      // Draw "SS" text using a simple 5x7 bitmap font for S
      const pixel = getPixel(x, y, width, height, fillR, fillG, fillB);
      row.push(pixel.r, pixel.g, pixel.b, pixel.a);
    }
    rawRows.push(Buffer.from(row));
  }
  const rawData = Buffer.concat(rawRows);

  // Deflate with zlib (store — no compression for simplicity)
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  // ── PNG signature ──
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // ── IHDR chunk ──
  const ihdr = createChunk('IHDR', (() => {
    const buf = Buffer.alloc(13);
    buf.writeUInt32BE(width, 0);
    buf.writeUInt32BE(height, 4);
    buf[8] = 8;  // bit depth
    buf[9] = 6;  // colour type: RGBA
    buf[10] = 0; // compression
    buf[11] = 0; // filter
    buf[12] = 0; // interlace
    return buf;
  })());

  // ── IDAT chunk ──
  const idat = createChunk('IDAT', compressed);

  // ── IEND chunk ──
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

// CRC-32 implementation for PNG
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Simple bitmap for "S" character (5×7)
const S_BITMAP = [
  ' ### ',
  '#    ',
  '#    ',
  ' ### ',
  '    #',
  '    #',
  ' ### ',
];

function getPixel(x, y, w, h, bgR, bgG, bgB) {
  // Margin: 15% on each side
  const margin = Math.floor(w * 0.15);
  const innerW = w - margin * 2;
  const innerH = h - margin * 2;

  // Two "S" letters side by side with 1px gap
  const charW = 5;
  const charH = 7;
  const gap = 1;
  const totalTextW = charW * 2 + gap;
  const totalTextH = charH;

  // Scale factor
  const scaleX = Math.max(1, Math.floor(innerW / totalTextW));
  const scaleY = Math.max(1, Math.floor(innerH / totalTextH));
  const scale = Math.min(scaleX, scaleY);

  const textPixelW = totalTextW * scale;
  const textPixelH = totalTextH * scale;
  const offsetX = margin + Math.floor((innerW - textPixelW) / 2);
  const offsetY = margin + Math.floor((innerH - textPixelH) / 2);

  const lx = x - offsetX;
  const ly = y - offsetY;

  if (lx >= 0 && lx < textPixelW && ly >= 0 && ly < textPixelH) {
    const charCol = Math.floor(lx / scale);
    const charRow = Math.floor(ly / scale);

    let bitmapChar = -1;
    if (charCol < charW) bitmapChar = 0;
    else if (charCol >= charW + gap && charCol < charW * 2 + gap) bitmapChar = 1;

    if (bitmapChar >= 0) {
      const bc = bitmapChar === 0 ? charCol : charCol - charW - gap;
      if (S_BITMAP[charRow] && S_BITMAP[charRow][bc] === '#') {
        return { r: 255, g: 255, b: 255, a: 255 };
      }
    }
  }

  // Background
  return { r: bgR, g: bgG, b: bgB, a: 255 };
}

// ── Generate icons ──

const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

for (const size of sizes) {
  const png = createPng(size, size, 45, 164, 78); // #2da44e GitHub green
  const filepath = path.join(iconsDir, `icon-${size}.png`);
  fs.writeFileSync(filepath, png);
  console.log(`Created ${filepath} (${png.length} bytes)`);
}

console.log('\nDone! Replace these placeholder icons with properly designed ones before publishing.');
