#!/usr/bin/env node
// statusline-bridge.mjs — 包在用户原有 statusline 命令外面的一层「透传 + 截获」。
//
// Claude Code 只把 rate_limits（限额百分比）喂给 statusline 命令的 stdin，hook 拿不到、
// 本地也无缓存文件。所以想在看板显示「5h/7d 占限额 %」，唯一办法是接管 statusline。
// 但用户可能已经配了自己的 statusline（如 ccline），直接顶掉会弄坏它——于是这里「包一层」：
//   ① 读入 Claude Code 传来的完整 JSON（含 rate_limits / context_window / cost）
//   ② 把 rate_limits 等抽出来原子写到 ~/.claude/monitor/usage-limits.json（供看板读）
//   ③ 把**原样的 stdin** 转调用户原来的 statusline 命令，并把它的 stdout 原样输出、
//      退出码原样透传 —— 用户终端里的 statusline 视觉与行为完全不变。
//
// 「原来的命令」存在 monitor-hooks/wrapped-statusline.json 里（安装时写入，卸载时据此还原）。
// 全程 try/catch 兜底：任何一步失败都不让 statusline 崩/空太久。

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

// 读 stdin（statusline 载荷）——同步读整段，载荷很小
function readStdinSync() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

const raw = readStdinSync();

// —— ① 抽取并落盘 rate_limits 等（截获部分，绝不影响透传）——
try {
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const monitorDir = join(HOME, '.claude', 'monitor');
  mkdirSync(monitorDir, { recursive: true });

  const out = {
    captured_at: Date.now(),
    keys: Object.keys(payload),                      // 探针用：一眼看清载荷里到底有哪些顶层字段
    rate_limits: payload.rate_limits ?? null,       // { five_hour:{used_percentage,resets_at}, seven_day:{...} }
    context_window: payload.context_window ?? null, // { used_percentage, ... } —— 上下文占用（区别于限额）
    cost: payload.cost ?? null,                      // { total_cost_usd, ... }
    session_id: payload.session_id ?? null,
  };
  const file = join(monitorDir, 'usage-limits.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  renameSync(tmp, file);

  // 探针模式：若设了 CCMON_CAPTURE，额外把**完整载荷**存一份，方便排查字段（生产可不设）
  if (process.env.CCMON_CAPTURE) {
    writeFileSync(join(monitorDir, 'statusline-capture.json'), raw, 'utf8');
  }
} catch {
  // 截获失败不影响用户 statusline —— 继续走透传
}

// —— ② 透传：转调用户原来的 statusline 命令，stdout / 退出码原样返回 ——
try {
  const wrapPath = join(HERE, 'wrapped-statusline.json');
  if (!existsSync(wrapPath)) process.exit(0); // 没有被包裹的原命令：什么都不输出（不该发生）
  const wrapped = JSON.parse(readFileSync(wrapPath, 'utf8'));
  let cmd = String(wrapped.command || '').trim();
  if (!cmd) process.exit(0);

  // 展开开头的 ~/ 到 home
  if (cmd.startsWith('~/') || cmd.startsWith('~\\')) cmd = join(HOME, cmd.slice(2));

  // 单 token 命令（无空格）→ 当可执行文件直接 spawn，避开 shell 引号/斜杠坑；
  // Windows 下补 .exe。含空格的复杂命令 → 回退 shell:true。
  let res;
  if (!/\s/.test(cmd)) {
    let exe = cmd;
    if (process.platform === 'win32' && !/\.[a-z]{2,4}$/i.test(exe) && existsSync(`${exe}.exe`)) {
      exe = `${exe}.exe`;
    }
    res = spawnSync(exe, [], { input: raw, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  } else {
    res = spawnSync(cmd, { input: raw, encoding: 'utf8', shell: true, windowsHide: true, timeout: 5000 });
  }

  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.status ?? 0);
} catch {
  process.exit(0); // 兜底：宁可这一帧 statusline 空，也不报错
}
