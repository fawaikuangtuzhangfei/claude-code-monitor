// 程序化生成 Claude 风格图标：暖陶土橙圆角方块 + 中心放射星芒(spark)。
// 纯 Node，2x 超采样抗锯齿，输出 app-icon.png，再交给 `tauri icon` 切各平台。
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const OUT = 1024;      // 最终尺寸
const SS = 2;          // 超采样倍数
const S = OUT * SS;    // 渲染尺寸
const c = S / 2;

// —— 调色（Claude 暖陶土橙 + 奶白星芒）——
const bgTop = [222, 139, 106];   // #DE8B6A
const bgBot = [193, 90, 56];     // #C15A38
const spark = [253, 246, 238];   // #FDF6EE 奶白

// 星芒几何
const N = 12;                    // 芒数
const R_LONG = 0.37 * S;
const R_SHORT = 0.285 * S;
const W = 0.05 * S;              // 花瓣最大半宽
const CENTER_R = 0.052 * S;      // 中心实心圆
const START = -Math.PI / 2;      // 一芒朝正上

// 圆角方块
const MARGIN = 0.055 * S;
const RAD = 0.225 * S;

function insideRoundRect(x, y) {
  const x0 = MARGIN, y0 = MARGIN, x1 = S - MARGIN, y1 = S - MARGIN;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const rx = Math.min(x - x0, x1 - x), ry = Math.min(y - y0, y1 - y);
  if (rx < RAD && ry < RAD) {
    const ddx = RAD - rx, ddy = RAD - ry;
    return ddx * ddx + ddy * ddy <= RAD * RAD;
  }
  return true;
}

function insideSpark(dx, dy) {
  if (dx * dx + dy * dy <= CENTER_R * CENTER_R) return true;
  for (let i = 0; i < N; i++) {
    const ang = START + (i * 2 * Math.PI) / N;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const u = dx * ca + dy * sa;          // 沿芒方向
    if (u < 0) continue;
    const len = i % 2 === 0 ? R_LONG : R_SHORT;
    if (u > len) continue;
    const v = -dx * sa + dy * ca;         // 垂直方向
    const hw = W * Math.sin((Math.PI * u) / len); // 叶形：两端尖、中间宽
    if (Math.abs(v) <= hw) return true;
  }
  return false;
}

// 取某个渲染点的 RGBA
function sample(x, y) {
  const dx = x - c, dy = y - c;
  if (insideSpark(dx, dy)) return [spark[0], spark[1], spark[2], 255];
  if (insideRoundRect(x, y)) {
    const t = y / S; // 竖向渐变
    return [
      Math.round(bgTop[0] + (bgBot[0] - bgTop[0]) * t),
      Math.round(bgTop[1] + (bgBot[1] - bgTop[1]) * t),
      Math.round(bgTop[2] + (bgBot[2] - bgTop[2]) * t),
      255,
    ];
  }
  return [0, 0, 0, 0];
}

// —— 渲染 + 2x2 超采样降采样 ——
const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let oy = 0; oy < OUT; oy++) {
  const rowStart = oy * (OUT * 4 + 1);
  raw[rowStart] = 0; // filter byte
  for (let ox = 0; ox < OUT; ox++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const p = sample(ox * SS + sx + 0.5, oy * SS + sy + 0.5);
        // 预乘 alpha 累加，得到更干净的边缘
        const af = p[3] / 255;
        r += p[0] * af; g += p[1] * af; b += p[2] * af; a += p[3];
      }
    }
    const n = SS * SS;
    const aAvg = a / n;
    const i = rowStart + 1 + ox * 4;
    if (aAvg <= 0) { raw[i] = raw[i + 1] = raw[i + 2] = raw[i + 3] = 0; }
    else {
      const af = a / 255; // 预乘还原
      raw[i] = Math.round(r / af);
      raw[i + 1] = Math.round(g / af);
      raw[i + 2] = Math.round(b / af);
      raw[i + 3] = Math.round(aAvg);
    }
  }
}

// —— PNG 编码 ——
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let k = n;
    for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
    t[n] = k >>> 0;
  }
  return (buf) => {
    let k = 0xffffffff;
    for (let i = 0; i < buf.length; i++) k = t[(k ^ buf[i]) & 0xff] ^ (k >>> 8);
    return (k ^ 0xffffffff) >>> 0;
  };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0); ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync('app-icon.png', png);
console.log('wrote app-icon.png', png.length, 'bytes,', OUT + 'x' + OUT);
