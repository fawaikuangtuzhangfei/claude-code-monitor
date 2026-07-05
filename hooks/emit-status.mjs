#!/usr/bin/env node
// emit-status.mjs — Claude Code hook -> 每个会话写一份状态到 ~/.claude/monitor/<session_id>.json
//
// 用法（在 settings.json 的 hooks 里）:
//   node <此文件绝对路径> <event>
// 其中 <event> 是: session-start | prompt | pretool | posttool | notification | permission | stop | subagent-stop | session-end
//
// Claude Code 会把一段 JSON 从 stdin 传进来，至少包含:
//   { session_id, cwd, transcript_path, hook_event_name, ... }
// 这个脚本纯 Node、无第三方依赖，Windows / macOS 通用。

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, openSync, writeSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENT = (process.argv[2] || '').toLowerCase();

// —— 捕获“承载本会话的终端窗口”，供看板点击卡片时聚焦 ——
// Windows：沿进程树找到终端窗口 HWND（确定性，不依赖焦点）
function captureWindowWin() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'win-capture.ps1'), '-StartPid', String(process.pid)],
      { encoding: 'utf8', windowsHide: true, timeout: 6000 }
    );
    const hwnd = parseInt(String(out).trim(), 10);
    return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
  } catch {
    return null;
  }
}

// macOS：给终端标签设一个可识别标题（写到 /dev/tty），点击时用 AppleScript 按标题聚焦
function captureWindowMac(title) {
  try {
    const fd = openSync('/dev/tty', 'w');
    writeSync(fd, `\x1b]2;${title}\x07`); // OSC 2 = set window title
    closeSync(fd);
    return title;
  } catch {
    return null;
  }
}

// 读取 cwd 所在的 git 分支（1.5s 超时；非 git 目录 / 无 git / 分离头静默返回空）
function gitBranch(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const b = String(out).trim();
    return b && b !== 'HEAD' ? b : '';
  } catch {
    return '';
  }
}

// 读取 stdin（hook 输入）。异步累积，Windows 管道下也可靠。
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = '';
    let done = false;
    // 单次收口：正常靠 'end'，兜底靠定时器；收口后清掉定时器，避免进程空转 3 秒
    const finish = (raw) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { resolve(raw.trim() ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => finish(data));
    process.stdin.on('error', () => finish(''));
    const timer = setTimeout(() => finish(data), 3000);
  });
}

const input = await readStdin();
// session_id 会用作文件名 + 删除路径，必须清洗：只留 [A-Za-z0-9_-]，杜绝 ../ 路径穿越。
// 清洗后的值同时作为 record.session_id（身份唯一，聚焦时按它回查文件，两边必须一致）。
const rawId = input.session_id || input.sessionId || 'unknown';
const sessionId = (String(rawId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)) || 'unknown';
const cwd = input.cwd || input.workspace?.current_dir || process.cwd();
const transcriptPath = input.transcript_path || '';

const monitorDir = join(homedir(), '.claude', 'monitor');
mkdirSync(monitorDir, { recursive: true });
const outFile = join(monitorDir, `${sessionId}.json`);

// event -> 状态。running/waiting/done/idle/closed
const STATUS_BY_EVENT = {
  'session-start': 'idle',
  prompt: 'running',
  pretool: 'running',         // 工具将执行 = 恢复运行
  posttool: 'running',        // 工具已执行完（= 已授权）→ 兜底清掉 WAIT
  notification: 'waiting',
  permission: 'waiting',
  stop: 'done',
  'subagent-stop': 'running', // 子任务停了但主会话通常还在跑
  'session-end': 'closed',
};

const status = STATUS_BY_EVENT[EVENT] ?? 'idle';

// session 结束就删掉状态文件，看板自然消失
if (status === 'closed') {
  try { rmSync(outFile, { force: true }); } catch {}
  process.exit(0);
}

// 读旧状态，保留 running_since 之类的字段
let prev = {};
if (existsSync(outFile)) {
  try { prev = JSON.parse(readFileSync(outFile, 'utf8')); } catch {}
}

const now = Date.now();

// running_since: 进入 running 时打点，用于前端算耗时；离开 running 清掉
let runningSince = prev.running_since || null;
if (status === 'running') {
  if (prev.status !== 'running') runningSince = now;
} else {
  runningSince = null;
}

// waiting_since: 进入 waiting 时打点，用于前端显示“已等待时长”；离开 waiting 清掉
let waitingSince = prev.waiting_since || null;
if (status === 'waiting') {
  if (prev.status !== 'waiting') waitingSince = now;
} else {
  waitingSince = null;
}

// 从 hook 输入里尽量捞一句“正在做什么”作为提示
let lastPrompt = prev.last_prompt || '';
if (EVENT === 'prompt' && typeof input.prompt === 'string') {
  lastPrompt = input.prompt.replace(/\s+/g, ' ').trim().slice(0, 120);
}
let message = prev.message || '';
if (EVENT === 'notification' && typeof input.message === 'string') {
  message = input.message.replace(/\s+/g, ' ').trim().slice(0, 120);
}

const project = cwd ? basename(cwd) : 'unknown';

// git 分支：仅在 prompt / session-start 时探一次（避免每个工具调用都 fork git），其余复用旧值
let gitBranchName = prev.git_branch || '';
if (EVENT === 'prompt' || EVENT === 'session-start') {
  const b = gitBranch(cwd);
  if (b) gitBranchName = b;
}

// 捕获终端窗口信息。
// prompt: 每次都重抓前台窗口（你在哪个窗口按回车就锁哪个，WT 多窗口也能区分）。
// session-start: 尚未捕获时抓一次。
let winHwnd = prev.win_hwnd || null;
let windowTitle = prev.window_title || '';
if (EVENT === 'prompt' || (EVENT === 'session-start' && !winHwnd)) {
  if (process.platform === 'win32') {
    const h = captureWindowWin();
    if (h) winHwnd = h;
  } else if (process.platform === 'darwin') {
    // 标题只用已清洗的 sessionId，避免把目录名里的 ESC/引号写进终端转义或 osascript
    windowTitle = windowTitle || `CLAUDEMON:${sessionId}`;
    captureWindowMac(windowTitle);
  }
}

const record = {
  session_id: sessionId,
  project,
  cwd,
  status,
  updated_at: now,
  running_since: runningSince,
  waiting_since: waitingSince,
  git_branch: gitBranchName,
  last_prompt: lastPrompt,
  message,
  transcript_path: transcriptPath,
  win_hwnd: winHwnd,
  window_title: windowTitle,
};

// 原子写：先写临时文件再 rename，避免看板读到写一半的 JSON
const tmpFile = `${outFile}.${process.pid}.tmp`;
writeFileSync(tmpFile, JSON.stringify(record, null, 2), 'utf8');
renameSync(tmpFile, outFile);
