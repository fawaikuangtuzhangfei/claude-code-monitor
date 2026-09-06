// build.mjs — 生成 main.legacy.js
//
// 两件事：
//   1) 打补丁（在源码副本上，绝不改仓库里的 main.js）
//   2) esbuild 降级到 ES2015 + IIFE，喂给旧安卓浏览器
//
// 用法：node build.mjs
//
// 补丁若匹配不上会直接报错退出——仓库 UI 改动后宁可构建失败，
// 也不要悄悄产出一个「看起来正常但补丁没生效」的版本。

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// 本脚本住在 <repo>/tools/phone/，UI 源码在 ../../app/ui/src/
const SRC = join(import.meta.dirname, '..', '..', 'app', 'ui', 'src', 'main.js');
const TMP = join(import.meta.dirname, '_patched.js');
const OUT = join(import.meta.dirname, 'main.legacy.js');

// 轮询间隔。默认 6s：老手机上每次 XHR 都要把 WiFi 芯片从省电态唤醒一轮，
// 频率直接决定射频的占空比。看板只是「回家瞄一眼」，6s 完全够用。
// 代价是卡片上的秒表变成 6 秒一跳（读数本身是前端按 running_since 算的，不会错，只是刷得粗）。
const POLL_MS = Number(process.env.POLL_MS || 6000);

// 每条补丁必须命中，否则构建失败
const PATCHES = [
  {
    why: `轮询 1s → ${POLL_MS}ms，并加可见性门控：切后台/熄屏时彻底停表。` +
         '浏览器自己那套后台节流只是把定时器拉长，不会停；而看板在息屏时拉数没有任何意义，' +
         '纯粹是在唤醒 WiFi 和 CPU。回到前台立刻补一次，不用等下一个周期。',
    from: 'setInterval(tick, 1000);',
    to:
      `setInterval(function () { if (document.hidden !== true) tick(); }, ${POLL_MS});\n` +
      'document.addEventListener("visibilitychange", function () {\n' +
      '  if (document.hidden !== true) { tick(); tickUsage(); }\n' +
      '});',
  },
  {
    why: '用量条同样加可见性门控。30s 的周期本来就不密，但息屏时它也没必要醒。',
    from: 'setInterval(tickUsage, 30000);',
    to: 'setInterval(function () { if (document.hidden !== true) tickUsage(); }, 30000);',
  },
];

let src = readFileSync(SRC, 'utf8');
for (const p of PATCHES) {
  if (!src.includes(p.from)) {
    console.error(`✗ 补丁失配，仓库 UI 可能改了：\n  找不到: ${p.from}\n  用途: ${p.why}`);
    process.exit(1);
  }
  src = src.replace(p.from, p.to);
  // 补丁可能是多行的，日志里压成一行，别把终端刷满
  console.log(`✓ ${p.from}  →  ${p.to.replace(/\s*\n\s*/g, ' ')}`);
}

writeFileSync(TMP, src, 'utf8');

// ES2015 + IIFE：连 <script type="module">（Chrome 61+）都不需要
// Windows 上 npx 是 .cmd，Node 20 起 spawnSync 不再隐式用 shell 跑它，必须显式 shell:true
const r = spawnSync(
  'npx',
  ['--yes', 'esbuild', `"${TMP}"`, '--target=es2015', '--format=iife', `--outfile="${OUT}"`],
  { stdio: 'inherit', shell: true }
);

try { unlinkSync(TMP); } catch {}

if (r.error || r.status !== 0) {
  console.error('✗ esbuild 失败:', r.error?.message || `exit ${r.status}`);
  process.exit(1);
}
console.log(`✓ 已生成 ${OUT}`);
