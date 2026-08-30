// Generates the Hadamard GUI app icon (assets/hadamard-icon.png) with no external
// dependencies. The geometry and colours mirror guiIcon('logo') and the
// --avatar-gradient used by the in-app brand mark. Re-run with
// `node scripts/generate-gui-icon.mjs` after changing the design.
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512; // macOS DMG requires ≥512; Windows/Linux accept this too.
const px = Buffer.alloc(SIZE * SIZE * 4); // transparent RGBA

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// src-over composite of an opaque colour (r,g,b) at coverage `cov` onto pixel (x,y).
function blend(x, y, r, g, b, cov) {
  if (cov <= 0) return;
  cov = clamp(cov, 0, 1);
  const i = (y * SIZE + x) * 4;
  const da = px[i + 3] / 255;
  const outA = cov + da * (1 - cov);
  if (outA <= 0) return;
  px[i] = Math.round((r * cov + px[i] * da * (1 - cov)) / outA);
  px[i + 1] = Math.round((g * cov + px[i + 1] * da * (1 - cov)) / outA);
  px[i + 2] = Math.round((b * cov + px[i + 2] * da * (1 - cov)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

function roundedRectCoverage(x, y, cx, cy, hw, hh, radius) {
  const qx = Math.abs(x + 0.5 - cx) - (hw - radius);
  const qy = Math.abs(y + 0.5 - cy) - (hh - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const dist = outside + inside - radius;
  return clamp(0.5 - dist, 0, 1);
}

function circleCoverage(x, y, cx, cy, radius) {
  const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return clamp(radius + 0.5 - dist, 0, 1);
}

function circleStrokeCoverage(x, y, cx, cy, radius, halfWidth) {
  const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return clamp(halfWidth + 0.5 - Math.abs(dist - radius), 0, 1);
}

function segmentCoverage(x, y, ax, ay, bx, by, halfWidth) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x + 0.5 - ax;
  const wy = y + 0.5 - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp((wx * vx + wy * vy) / len2, 0, 1);
  const dist = Math.hypot(x + 0.5 - (ax + t * vx), y + 0.5 - (ay + t * vy));
  return clamp(halfWidth + 0.5 - dist, 0, 1);
}

const C = SIZE / 2;
const TILE_MARGIN = 16;
const TILE_RADIUS = 154;
const TILE_START = [0x52, 0x52, 0x5b];
const TILE_END = [0x71, 0x71, 0x7a];
const LOGO_SCALE = 14;
const LOGO_STROKE_WIDTH = 1.8;
const logoPoint = ([x, y]) => [C + (x - 12) * LOGO_SCALE, C + (y - 12) * LOGO_SCALE];
const center = logoPoint([12, 12]);
const nodes = [
  { center: logoPoint([5, 12]), radius: 1.5 * LOGO_SCALE },
  { center: logoPoint([19, 12]), radius: 1.5 * LOGO_SCALE },
  { center: logoPoint([12, 5]), radius: 1.5 * LOGO_SCALE },
  { center: logoPoint([12, 19]), radius: 1.5 * LOGO_SCALE },
];
const connectors = [
  [[7.1, 12], [9.6, 12]],
  [[14.4, 12], [16.9, 12]],
  [[12, 7.1], [12, 9.6]],
  [[12, 14.4], [12, 16.9]],
];
const sparkPoints = [
  [18.3, 4.2],
  [18.9, 5.7],
  [20.4, 6.3],
  [18.9, 6.9],
  [18.3, 8.4],
  [17.7, 6.9],
  [16.2, 6.3],
  [17.7, 5.7],
].map(logoPoint);
const strokeHalfWidth = LOGO_STROKE_WIDTH * LOGO_SCALE / 2;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // Background: the same zinc diagonal gradient and rounded proportions as
    // the 28px in-app .brand-mark tile.
    const tileHalfSize = C - TILE_MARGIN;
    const tileCov = roundedRectCoverage(x, y, C, C, tileHalfSize, tileHalfSize, TILE_RADIUS);
    if (tileCov > 0) {
      const gradientSpan = (SIZE - TILE_MARGIN * 2) * 2;
      const t = clamp((x + y - TILE_MARGIN * 2) / gradientSpan, 0, 1);
      const r = Math.round(TILE_START[0] + (TILE_END[0] - TILE_START[0]) * t);
      const g = Math.round(TILE_START[1] + (TILE_END[1] - TILE_START[1]) * t);
      const b = Math.round(TILE_START[2] + (TILE_END[2] - TILE_START[2]) * t);
      blend(x, y, r, g, b, tileCov);
    }

    // White 1.8-unit round strokes, matching the SVG's circles and paths.
    let mark = circleStrokeCoverage(
      x,
      y,
      center[0],
      center[1],
      2.4 * LOGO_SCALE,
      strokeHalfWidth,
    );
    for (const node of nodes) {
      mark = Math.max(
        mark,
        circleStrokeCoverage(x, y, node.center[0], node.center[1], node.radius, strokeHalfWidth),
      );
    }
    for (const [from, to] of connectors) {
      const [ax, ay] = logoPoint(from);
      const [bx, by] = logoPoint(to);
      mark = Math.max(mark, segmentCoverage(x, y, ax, ay, bx, by, strokeHalfWidth));
    }
    for (let i = 0; i < sparkPoints.length; i++) {
      const from = sparkPoints[i];
      const to = sparkPoints[(i + 1) % sparkPoints.length];
      mark = Math.max(mark, segmentCoverage(x, y, from[0], from[1], to[0], to[1], strokeHalfWidth));
      mark = Math.max(mark, circleCoverage(x, y, from[0], from[1], strokeHalfWidth));
    }
    if (mark > 0) blend(x, y, 250, 250, 250, mark);
  }
}

// ── Minimal PNG encoder (RGBA, 8-bit, no interlace) ──────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'hadamard-icon.png');
writeFileSync(outPath, encodePng(SIZE, SIZE, px));
process.stdout.write(`wrote ${outPath} (${SIZE}x${SIZE})\n`);
