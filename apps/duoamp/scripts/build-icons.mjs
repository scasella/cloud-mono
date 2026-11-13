#!/usr/bin/env node
/**
 * Draws the home-screen icons from the deck's "_D_" logo tile (classic skin
 * colours, the DuoPixel "D" glyph from fonts/duopixel-glyphs.mjs) and writes
 * PNGs to public/. Pure Node (zlib), no image libraries. Original art only.
 *
 *   node scripts/build-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLYPHS } from '../fonts/duopixel-glyphs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public');
mkdirSync(out, { recursive: true });

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
// Classic skin: logo tile background, bevel edges and the amber logo colour (src/skins.ts / skins.css).
const TILE = hex('#1d1d36');
const EDGE_DARK = hex('#15152a');
const EDGE_LIGHT = hex('#6c6c96');
const LOGO = hex('#e8a23a');

/** The "_D_" mark on a cell grid: underscore (2 cells), gap, D (5x6), gap, underscore. */
function markCells() {
  const cells = [];
  const D = GLYPHS.D;
  // x layout: 0-1 underscore, 2 gap, 3-7 D, 8 gap, 9-10 underscore. Height 6, underscores on the baseline row.
  D.forEach((row, y) => [...row].forEach((c, x) => c === '#' && cells.push([3 + x, y])));
  for (const x of [0, 1, 9, 10]) cells.push([x, 5]);
  return { cells, w: 11, h: 6 };
}

function crc32(buf) {
  let c;
  const table = crc32.t ?? (crc32.t = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, pixels) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB, no alpha (iOS fills transparency with black anyway)
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    pixels.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * grid: cells across the icon. The mark is 11x6 cells, centred; `bevel` draws
 * the tile's 1-cell inset bevel (omitted for maskable icons, whose edges get cut).
 */
function draw(size, grid, bevel) {
  const px = Buffer.alloc(size * size * 3);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  };
  const cell = Math.floor(size / grid);
  const off = Math.floor((size - cell * grid) / 2);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, TILE);
  if (bevel) {
    const b = Math.max(2, Math.round(cell / 2));
    for (let i = 0; i < size; i++) {
      for (let k = 0; k < b; k++) {
        set(i, k, EDGE_DARK);
        set(k, i, EDGE_DARK);
        set(i, size - 1 - k, EDGE_LIGHT);
        set(size - 1 - k, i, EDGE_LIGHT);
      }
    }
  }
  const { cells, w, h } = markCells();
  const ox = off + Math.floor((grid - w) / 2) * cell + (((grid - w) % 2) * cell) / 2;
  const oy = off + Math.floor((grid - h) / 2) * cell + (((grid - h) % 2) * cell) / 2;
  for (const [cx, cy] of cells) {
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) set(Math.round(ox + cx * cell + x), Math.round(oy + cy * cell + y), LOGO);
  }
  return png(size, px);
}

const files = [
  // iOS home screen; iOS rounds the corners itself, so no bevel.
  ['apple-touch-icon.png', 180, 15, false],
  ['icon-192.png', 192, 16, true],
  ['icon-512.png', 512, 16, true],
  // Maskable: the mark stays inside the 80% safe circle (radius 0.39 of the size).
  ['icon-maskable-512.png', 512, 18, false],
  ['favicon-32.png', 32, 13, false],
];
for (const [name, size, grid, bevel] of files) {
  writeFileSync(join(out, name), draw(size, grid, bevel));
  console.log(`public/${name} ${size}x${size}`);
}
