/**
 * 生成应用图标：橙色圆角方块 + 扫描框 + 文本行。
 *
 *   node scripts/make-icon.mjs
 *
 * 纯 Node 画像素、自己编码 PNG/ICO，避免为了一个图标引入 sharp/canvas。
 * 产出 assets/icon.ico（16–256 多尺寸）与 assets/icon.png（512）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets');
const SIZE = 512;

const COLORS = {
  bg: [255, 105, 0, 255], // #ff6900
  ink: [255, 255, 255, 255],
  soft: [255, 255, 255, 235],
};

function roundedRect(px, w, h, x, y, rw, rh, radius) {
  // 4x4 超采样边缘，缩到 16px 也不会糊成方块
  const SS = 4;
  for (let j = 0; j < rh; j += 1) {
    for (let i = 0; i < rw; i += 1) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px0 = x + i + (sx + 0.5) / SS;
          const py0 = y + j + (sy + 0.5) / SS;
          const cx = Math.max(x + radius, Math.min(px0, x + rw - radius));
          const cy = Math.max(y + radius, Math.min(py0, y + rh - radius));
          const dx = px0 - cx;
          const dy = py0 - cy;
          if (dx * dx + dy * dy <= radius * radius) hit += 1;
        }
      }
      if (hit === 0) continue;
      const a = hit / (SS * SS);
      blend(px, w, h, x + i, y + j, a);
    }
  }
}

let current = COLORS.ink;
function blend(px, w, h, x, y, alpha) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  const [r, g, b, a] = current;
  const srcA = (a / 255) * alpha;
  const dstA = px[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  px[i] = Math.round((r * srcA + px[i] * dstA * (1 - srcA)) / outA);
  px[i + 1] = Math.round((g * srcA + px[i + 1] * dstA * (1 - srcA)) / outA);
  px[i + 2] = Math.round((b * srcA + px[i + 2] * dstA * (1 - srcA)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

function draw(size) {
  const px = new Uint8Array(size * size * 4);
  if (size !== SIZE) {
    // 从 512 盒式降采样，避免小尺寸锯齿
    const src = draw(SIZE);
    const out = new Uint8Array(size * size * 4);
    const k = SIZE / size;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let sy = Math.floor(y * k); sy < Math.floor((y + 1) * k); sy += 1) {
          for (let sx = Math.floor(x * k); sx < Math.floor((x + 1) * k); sx += 1) {
            const i = (sy * SIZE + sx) * 4;
            const al = src[i + 3] / 255;
            r += src[i] * al;
            g += src[i + 1] * al;
            b += src[i + 2] * al;
            a += al;
            n += 1;
          }
        }
        const o = (y * size + x) * 4;
        if (a > 0) {
          out[o] = Math.round(r / a);
          out[o + 1] = Math.round(g / a);
          out[o + 2] = Math.round(b / a);
        }
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
    return out;
  }

  const s = size / 512;
  const u = (v) => Math.round(v * s);

  // 底：圆角方块（留 4% 边距给系统阴影）
  current = COLORS.bg;
  roundedRect(px, size, size, u(16), u(16), u(480), u(480), u(112));

  // 扫描框：四角 L 形
  current = COLORS.soft;
  const inset = u(96);
  const arm = u(96);
  const thick = u(34);
  const r = u(24);
  const corners = [
    [inset, inset, 1, 1],
    [size - inset, inset, -1, 1],
    [inset, size - inset, 1, -1],
    [size - inset, size - inset, -1, -1],
  ];
  for (const [x, y, dx, dy] of corners) {
    const hx = dx > 0 ? x : x - arm;
    const hy = dy > 0 ? y : y - thick;
    roundedRect(px, size, size, hx, hy, arm, thick, r);
    const vx = dx > 0 ? x : x - thick;
    const vy = dy > 0 ? y : y - arm;
    roundedRect(px, size, size, vx, vy, thick, arm, r);
  }

  // 文本行
  current = COLORS.ink;
  const lines = [
    [u(168), u(232), u(176)],
    [u(168), u(272), u(128)],
    [u(168), u(312), u(152)],
  ];
  for (const [x, y, w] of lines) {
    roundedRect(px, size, size, x, y, w, u(18), u(9));
  }

  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, px.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const entries = [];
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const png512 = encodePng(draw(512), 512);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);

const sizes = [256, 128, 64, 48, 32, 16];
const images = sizes.map((size) => ({ size, data: encodePng(draw(size), size) }));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(images));

console.log(`assets/icon.png  ${(png512.length / 1024).toFixed(1)} KB`);
console.log(`assets/icon.ico  ${sizes.join('/')}  ${(fs.statSync(path.join(OUT_DIR, 'icon.ico')).size / 1024).toFixed(1)} KB`);
