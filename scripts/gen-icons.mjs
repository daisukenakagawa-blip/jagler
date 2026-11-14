import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2, cy = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy) / (size / 2);
      const ang = Math.atan2(y - cy, x - cx);
      let [r, g, b] = [11, 15, 20];
      const ring = [0.25, 0.45, 0.65].some((q) => Math.abs(d - q) < 0.012);
      const sweep = d < 0.66 && ang > -1.2 && ang < -0.2;
      if (sweep) { const k = (ang + 1.2); r = 11 + 20 * k; g = 15 + 150 * k; b = 20 + 100 * k; }
      if (ring) [r, g, b] = [52, 211, 153];
      if (Math.hypot(x - cx - size * 0.18, y - cy + size * 0.2) < size * 0.035) [r, g, b] = [250, 204, 21];
      if (d < 0.03) [r, g, b] = [52, 211, 153];
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [180, 192, 512]) writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), png(s));
