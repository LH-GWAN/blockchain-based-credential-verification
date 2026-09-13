// PWA 아이콘 생성 (외부 의존성 없음): 파란 둥근 사각형 + 흰 체크 표시.
// 실행: pnpm --filter @dbp/wallet icons  → public/icons/icon-192.png, icon-512.png, apple-touch-icon.png
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x1d, 0x4e, 0xd8]; // theme color
const FG = [0xff, 0xff, 0xff];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 선분까지의 거리 (체크 표시를 두꺼운 선으로 그린다)
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

function render(size, { rounded = true, padding = 0 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // 모서리 반지름
  const inset = padding * size;
  const a = [size * 0.28, size * 0.52];
  const b = [size * 0.44, size * 0.68];
  const c = [size * 0.73, size * 0.34];
  const stroke = size * 0.075;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // 둥근 사각형 내부 판정
      let inside = cx >= inset && cy >= inset && cx <= size - inset && cy <= size - inset;
      if (inside && rounded) {
        const qx = Math.max(inset + r - cx, cx - (size - inset - r), 0);
        const qy = Math.max(inset + r - cy, cy - (size - inset - r), 0);
        inside = Math.hypot(qx, qy) <= r;
      }
      const i = (y * size + x) * 4;
      if (!inside) {
        px[i + 3] = 0; // 투명
        continue;
      }
      const d = Math.min(segDist(cx, cy, a[0], a[1], b[0], b[1]), segDist(cx, cy, b[0], b[1], c[0], c[1]));
      const t = Math.max(0, Math.min(1, stroke - d + 0.5)); // 1px 안티에일리어싱
      px[i] = Math.round(BG[0] + (FG[0] - BG[0]) * t);
      px[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * t);
      px[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * t);
      px[i + 3] = 255;
    }
  }
  // PNG 인코딩 (필터 0, RGBA 8bit)
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { rounded: false }],
  ['apple-touch-icon.png', 180, { rounded: false }],
];
for (const [name, size, opts] of targets) {
  writeFileSync(resolve(outDir, name), render(size, opts));
  console.log(`[gen-icons] ${name} (${size}px)`);
}
