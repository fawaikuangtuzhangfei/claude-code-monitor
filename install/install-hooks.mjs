#!/usr/bin/env node
// install-hooks.mjs — 把状态发射器安装进 Claude Code
//   1) 复制 emit-status.mjs 到 ~/.claude/monitor-hooks/
//   2) 幂等地把 5 个 hook 合并进 ~/.claude/settings.json（保留你已有的钩子/通知）
// 跨平台（Windows / macOS），纯 Node，无依赖。
//
// 用法:  node install/install-hooks.mjs
//        node install/install-hooks.mjs --uninstall

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const HOOKS_DIR = join(CLAUDE_DIR, 'monitor-hooks');
const EMITTER_SRC = join(__dirname, '..', 'hooks', 'emit-status.mjs');
const EMITTER_DST = join(HOOKS_DIR, 'emit-status.mjs');
// emit-status.mjs 依赖同目录的 status-logic.mjs（纯决策核心），必须一并复制
const LOGIC_SRC = join(__dirname, '..', 'hooks', 'status-logic.mjs');
const LOGIC_DST = join(HOOKS_DIR, 'status-logic.mjs');
const WINCAP_SRC = join(__dirname, '..', 'hooks', 'win-capture.ps1');
const WINCAP_DST = join(HOOKS_DIR, 'win-capture.ps1');
// statusline 桥接：拿「占限额百分比」的唯一途径（Claude Code 只把 rate_limits 喂给 statusline）
const BRIDGE_SRC = join(__dirname, '..', 'hooks', 'statusline-bridge.mjs');
const BRIDGE_DST = join(HOOKS_DIR, 'statusline-bridge.mjs');
const WRAPPED_STATUSLINE = join(HOOKS_DIR, 'wrapped-statusline.json'); // 存被包裹的原 statusLine，卸载据此还原
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
const UNINSTALL = process.argv.includes('--uninstall');
const BRIDGE_MARK = 'statusline-bridge.mjs'; // 识别「statusLine 已被我们包住」

// hook 命令用正斜杠，Node 在 Windows 上也认，避免 JSON 里反斜杠转义
const emitterPathForCmd = EMITTER_DST.replace(/\\/g, '/');
function cmd(event) {
  return `node "${emitterPathForCmd}" ${event}`;
}

// 事件 -> settings.json 里的 hook 事件名 + 传给发射器的参数
const MAP = [
  { event: 'SessionStart', arg: 'session-start' },
  { event: 'UserPromptSubmit', arg: 'prompt' },
  { event: 'PreToolUse', arg: 'pretool' },          // 工具将执行 = 恢复运行
  { event: 'PostToolUse', arg: 'posttool' },        // 工具已执行完（= 已授权）→ 兜底清掉 WAIT，不依赖 Pre/Permission 的先后
  { event: 'Notification', arg: 'notification' },
  { event: 'PermissionRequest', arg: 'permission' }, // 权限确认也算“等你”
  { event: 'Stop', arg: 'stop' },
  { event: 'SubagentStop', arg: 'subagent-stop' },  // 子任务结束但主会话通常仍在跑
  { event: 'SessionEnd', arg: 'session-end' },
];

const MARK = 'emit-status.mjs'; // 用来识别“是我们装的钩子”

// parse-guard：settings.json 是用户自己的文件，解析失败绝不覆盖——先把坏文件另存一份留证，
// 再中止，让用户自己修。绝不在解析失败时写回，避免把用户手写的注释/结构冲没。
function loadSettings() {
  if (!existsSync(SETTINGS)) return {};
  const raw = readFileSync(SETTINGS, 'utf8');
  try { return JSON.parse(raw); }
  catch (e) {
    const bad = SETTINGS + '.unparsable-' + Date.now();
    try { writeFileSync(bad, raw, 'utf8'); } catch {}
    console.error('无法解析 settings.json（未做任何改动）:', e.message);
    console.error('已把当前内容原样另存到:', bad, '\n请修正 settings.json 后重试。');
    process.exit(1);
  }
}

function groupHasOurHook(group) {
  return (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARK));
}

const NO_STATUSLINE = process.argv.includes('--no-statusline'); // 装监控但不碰 statusline（不要限额%）
const bridgeCmd = `node "${BRIDGE_DST.replace(/\\/g, '/')}"`;

// 把用户现有的 statusLine「包一层」：改指向桥接，原命令另存 WRAPPED_STATUSLINE 以便还原。
// 幂等：已经被包过就不动、也不覆盖已存的原命令。返回一句人类可读的结果说明。
function wrapStatusline(settings) {
  const cur = settings.statusLine;
  const alreadyWrapped = cur && typeof cur.command === 'string' && cur.command.includes(BRIDGE_MARK);
  if (alreadyWrapped) {
    settings.statusLine = { ...cur, type: 'command', command: bridgeCmd }; // 刷新路径即可
    return 'statusLine 已是桥接，已刷新';
  }
  // 首次包裹：把原 statusLine 原样存起来（没有就存空对象，卸载时按“无 command”处理成删除）
  writeFileSync(WRAPPED_STATUSLINE, JSON.stringify(cur || {}, null, 2), 'utf8');
  settings.statusLine = { ...(cur || {}), type: 'command', command: bridgeCmd };
  return cur && cur.command
    ? `已包住你原有的 statusLine（原命令已存，卸载可还原）：${cur.command}`
    : '已设置 statusLine 桥接（你原先没有 statusLine）';
}

// 还原 statusLine：若当前指向桥接，就用 WRAPPED_STATUSLINE 里的原命令替回；原来没有则删除。
function unwrapStatusline(settings) {
  const cur = settings.statusLine;
  if (!cur || typeof cur.command !== 'string' || !cur.command.includes(BRIDGE_MARK)) return '未包裹 statusLine，跳过';
  let orig = {};
  if (existsSync(WRAPPED_STATUSLINE)) {
    try { orig = JSON.parse(readFileSync(WRAPPED_STATUSLINE, 'utf8')); } catch {}
  }
  if (orig && orig.command) settings.statusLine = orig;
  else delete settings.statusLine;
  try { rmSync(WRAPPED_STATUSLINE, { force: true }); } catch {}
  return orig && orig.command ? `已还原你原来的 statusLine：${orig.command}` : '已移除 statusLine 桥接';
}

function install() {
  // 1) 复制发射器 + Windows 窗口捕获脚本
  mkdirSync(HOOKS_DIR, { recursive: true });
  copyFileSync(EMITTER_SRC, EMITTER_DST);
  copyFileSync(LOGIC_SRC, LOGIC_DST); // 决策核心，emit-status 运行时 import 它
  if (existsSync(WINCAP_SRC)) copyFileSync(WINCAP_SRC, WINCAP_DST);
  if (existsSync(BRIDGE_SRC)) copyFileSync(BRIDGE_SRC, BRIDGE_DST); // statusline 桥接
  console.log('✓ 已复制发射器 ->', EMITTER_DST);

  // 2) 合并 settings.json
  const settings = loadSettings();
  settings.hooks = settings.hooks || {};

  // 备份
  if (existsSync(SETTINGS)) {
    const bak = SETTINGS + '.bak-monitor';
    copyFileSync(SETTINGS, bak);
    console.log('✓ 已备份 settings.json ->', bak);
  }

  // 「先删后加」：把该事件里我们之前装的钩子（按 MARK 识别）全部删掉，再补一条最新的。
  // 这样重装即幂等升级——命令格式变了也能把旧条目刷成最新，绝不重复堆叠；用户自己的其它
  // 钩子（不含 MARK）原样保留。
  let added = 0, refreshed = 0;
  for (const { event, arg } of MAP) {
    const groups = settings.hooks[event] || [];
    const kept = groups.filter((g) => !groupHasOurHook(g));
    if (kept.length !== groups.length) refreshed++; else added++;
    kept.push({ hooks: [{ type: 'command', command: cmd(arg) }] });
    settings.hooks[event] = kept;
  }

  // 3) statusline 桥接（拿限额百分比）——除非 --no-statusline
  let statuslineMsg = '已跳过 statusline 桥接（--no-statusline）';
  if (!NO_STATUSLINE) statuslineMsg = wrapStatusline(settings);

  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
  console.log(`✓ 新增 ${added} 个、刷新 ${refreshed} 个 hook 事件（先删后加=幂等升级），保留了你原有的其它钩子`);
  console.log('✓', statuslineMsg);
  console.log('\n完成！重启正在运行的 Claude Code 会话后，新会话即会上报状态。');
}

function uninstall() {
  const settings = loadSettings();
  settings.hooks = settings.hooks || {}; // 即使没 hooks，也要往下走还原 statusLine
  let removed = 0;
  for (const { event } of MAP) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !groupHasOurHook(g));
    removed += groups.length - kept.length;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  // 还原 statusLine（把桥接换回用户原来的命令）
  const statuslineMsg = unwrapStatusline(settings);

  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
  console.log(`✓ 已移除 ${removed} 个监控钩子（其它钩子保留）`);
  console.log('✓', statuslineMsg);

  // 清掉复制进去的脚本目录 + 各会话状态文件，做到干净卸载
  const MONITOR_DIR = join(CLAUDE_DIR, 'monitor');
  try { rmSync(HOOKS_DIR, { recursive: true, force: true }); console.log('✓ 已删除', HOOKS_DIR); } catch {}
  try { rmSync(MONITOR_DIR, { recursive: true, force: true }); console.log('✓ 已删除', MONITOR_DIR); } catch {}
}

if (UNINSTALL) uninstall();
else install();
