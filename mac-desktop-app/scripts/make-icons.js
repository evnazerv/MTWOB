/**
 * Generates the app icon and menu-bar tray icons as PNGs with no dependencies:
 *   build/icon.png                      1024×1024 app icon (electron-builder converts it to .icns)
 *   assets/trayTemplate.png (+@2x)      monochrome template image → system RUNNING
 *   assets/trayHalted.png (+@2x)        red stop badge → Kill Switch engaged
 * Run: npm run icons
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function png(size, pixel) {
  const SS = 3; // supersampling for anti-aliased edges
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const p = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const NONE = [0, 0, 0, 0];
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);
const plus = (x, y, cx, cy, arm, thick) =>
  inRoundRect(x, y, cx - arm, cy - thick, cx + arm, cy + thick, thick * 0.55) || inRoundRect(x, y, cx - thick, cy - arm, cx + thick, cy + arm, thick * 0.55);

/** App icon: navy→teal rounded square, white ring, medical plus, three "network node" dots. */
function appIcon(x, y) {
  if (!inRoundRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.2)) return NONE;
  const t = (x + y) / 2;
  const bg = [Math.round(14 + (15 - 14) * t), Math.round(58 + (118 - 58) * t), Math.round(83 + (110 - 83) * t), 1];
  const d = dist(x, y, 0.5, 0.5);
  if (plus(x, y, 0.5, 0.5, 0.17, 0.055)) return [255, 255, 255, 1];
  if (d > 0.285 && d < 0.325) return [255, 255, 255, 1];
  for (const ang of [-0.55, 1.55, 3.65]) {
    if (dist(x, y, 0.5 + Math.cos(ang) * 0.305, 0.5 + Math.sin(ang) * 0.305) < 0.058) return [94, 234, 212, 1];
  }
  return bg;
}

/** Tray (template): black ring + plus on transparent; macOS recolors it for light/dark menu bars. */
function trayRunning(x, y) {
  const d = dist(x, y, 0.5, 0.5);
  if ((d > 0.36 && d < 0.46) || plus(x, y, 0.5, 0.5, 0.2, 0.065)) return [0, 0, 0, 1];
  return NONE;
}

/** Tray (halted): solid red disc with a white stop bar. */
function trayHalted(x, y) {
  if (dist(x, y, 0.5, 0.5) > 0.46) return NONE;
  if (inRoundRect(x, y, 0.24, 0.41, 0.76, 0.59, 0.05)) return [255, 255, 255, 1];
  return [215, 0, 21, 1];
}

const root = path.join(__dirname, '..');
const out = [
  ['build/icon.png', 1024, appIcon],
  ['assets/icon.png', 256, appIcon],
  ['assets/trayTemplate.png', 18, trayRunning], ['assets/trayTemplate@2x.png', 36, trayRunning],
  ['assets/trayHalted.png', 18, trayHalted], ['assets/trayHalted@2x.png', 36, trayHalted]
];
out.forEach(([file, size, fn]) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), png(size, fn));
  console.log('wrote', file, size + 'px');
});
