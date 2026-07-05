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
const WINCAP_SRC = join(__dirname, '..', 'hooks', 'win-capture.ps1');
const WINCAP_DST = join(HOOKS_DIR, 'win-capture.ps1');
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
const UNINSTALL = process.argv.includes('--uninstall');

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

function loadSettings() {
  if (!existsSync(SETTINGS)) return {};
  try { return JSON.parse(readFileSync(SETTINGS, 'utf8')); }
  catch (e) { console.error('无法解析 settings.json:', e.message); process.exit(1); }
}

function groupHasOurHook(group) {
  return (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARK));
}

function install() {
  // 1) 复制发射器 + Windows 窗口捕获脚本
  mkdirSync(HOOKS_DIR, { recursive: true });
  copyFileSync(EMITTER_SRC, EMITTER_DST);
  if (existsSync(WINCAP_SRC)) copyFileSync(WINCAP_SRC, WINCAP_DST);
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

  let added = 0;
  for (const { event, arg } of MAP) {
    const groups = (settings.hooks[event] = settings.hooks[event] || []);
    // 幂等：该事件里已经有我们的钩子就跳过
    if (groups.some(groupHasOurHook)) continue;
    groups.push({ hooks: [{ type: 'command', command: cmd(arg) }] });
    added++;
  }

  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
  console.log(`✓ 已写入 ${added} 个新 hook 事件（已存在的跳过），保留了你原有的钩子`);
  console.log('\n完成！重启正在运行的 Claude Code 会话后，新会话即会上报状态。');
}

function uninstall() {
  const settings = loadSettings();
  if (!settings.hooks) { console.log('没有 hooks 可清理'); return; }
  let removed = 0;
  for (const { event } of MAP) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !groupHasOurHook(g));
    removed += groups.length - kept.length;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
  console.log(`✓ 已移除 ${removed} 个监控钩子（其它钩子保留）`);

  // 清掉复制进去的脚本目录 + 各会话状态文件，做到干净卸载
  const MONITOR_DIR = join(CLAUDE_DIR, 'monitor');
  try { rmSync(HOOKS_DIR, { recursive: true, force: true }); console.log('✓ 已删除', HOOKS_DIR); } catch {}
  try { rmSync(MONITOR_DIR, { recursive: true, force: true }); console.log('✓ 已删除', MONITOR_DIR); } catch {}
}

if (UNINSTALL) uninstall();
else install();
