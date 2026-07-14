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
import { decide, shouldAbortConcurrentWrite, STATUS_BY_EVENT } from './status-logic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENT = (process.argv[2] || '').toLowerCase();

// —— 捕获“承载本会话的终端窗口”，供看板点击卡片时聚焦 ——
// Windows：沿进程树找到终端窗口 HWND（确定性，不依赖焦点）
// 返回 { hwnd, pid }：pid = 当前拥有该窗口的进程 id，供看板检测 HWND 被系统回收复用
function captureWindowWin() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'win-capture.ps1'), '-StartPid', String(process.pid)],
      { encoding: 'utf8', windowsHide: true, timeout: 6000 }
    );
    const parts = String(out).trim().split(/\s+/);
    const hwnd = parseInt(parts[0], 10);
    const wpid = parseInt(parts[1], 10);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return null;
    return { hwnd, pid: Number.isFinite(wpid) && wpid > 0 ? wpid : null };
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

// macOS：若本会话在 Ghostty 里，读它所在 tab 的名字（如 work1 / merge）当看板卡片标签——
// 比 cwd 目录名更贴合你眼睛看到的分组。复用 captureWindowMac 刚写下的 CLAUDEMON:<sessionId>
// 标题当定位标记，AppleScript 找到这个 split 后反查它属于哪个 tab、取 tab 名（零额外闪烁）。
// 只在确认身处 Ghostty 时才跑，否则 `tell application "Ghostty"` 会误把 Ghostty 拉起来。
function captureGhosttyTabMac(marker) {
  const inGhostty = process.env.TERM === 'xterm-ghostty' || !!process.env.GHOSTTY_RESOURCES_DIR;
  if (!inGhostty) return '';
  // marker 只含 CLAUDEMON: + 已清洗的 sessionId（[A-Za-z0-9_-]），塞进 AppleScript 字符串安全
  const script = `tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in terminals of t
        if name of s contains "${marker}" then return (name of t)
      end repeat
    end repeat
  end repeat
end tell`;
  try {
    // 2s 超时兜底：首次可能弹「控制 Ghostty」授权框，超时即放弃、退回项目名，不卡死 session-start
    const out = execFileSync('osascript', ['-e', script], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // 空 = 没匹配到；含 CLAUDEMON = 该 tab 未固定标题、正映射我们自己写的标记，别用它
    if (!out || out.includes('CLAUDEMON')) return '';
    return out;
  } catch {
    return '';
  }
}

// macOS：记录“承载本会话的进程”PID —— 从本 hook 进程向上找，跳过中间的 shell，
// 取第一个非 shell 祖先（即 Claude Code 会话进程本身）。看板据此判断：这个进程若已
// 不存在，说明终端标签/窗口被直接关掉（未触发 SessionEnd），对应卡片是僵尸，应剔除。
// mac 没有 Windows 那套窗口存活检测，这是等价的兜底，且不会误删真在 waiting/idle 的会话。
function captureOwnerPidMac() {
  const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'login', 'env']);
  try {
    let pid = process.ppid;
    for (let i = 0; i < 10 && pid > 1; i++) {
      const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const m = out.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) break;
      const parentPid = parseInt(m[1], 10);
      // comm 可能是完整路径；取 basename，并去掉登录 shell 的前导 '-'（如 "-zsh"）
      const comm = m[2].trim().split('/').pop().replace(/^-/, '');
      if (!shells.has(comm)) return pid; // 第一个非 shell 祖先 = 会话进程
      pid = parentPid;
    }
  } catch {}
  return null;
}

// macOS：拿到会话所在“伪终端设备”路径（如 /dev/ttys012）。看板无法从外部精确聚焦
// Ghostty 的某个 split，但可以往这个 tty 写一个 BEL，让 Ghostty 在对应 tab/分屏上亮
// 提示、闪一下，帮你定位到具体那一格。ps 的 tty 列给出 ttysNNN；'??' 表示无控制终端。
function captureTtyMac(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out || out === '??' || out === '?') return null;
    const dev = out.startsWith('/dev/') ? out : `/dev/${out}`;
    return dev.startsWith('/dev/tty') ? dev : null; // 只认 /dev/tty*，防呆
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

// session 结束就删掉状态文件，看板自然消失（decide 会对 session-end 返回 delete）
if (STATUS_BY_EVENT[EVENT] === 'closed') {
  try { rmSync(outFile, { force: true }); } catch {}
  process.exit(0);
}

// 读旧状态，保留 running_since 之类的字段
let prev = {};
if (existsSync(outFile)) {
  try { prev = JSON.parse(readFileSync(outFile, 'utf8')); } catch {}
}

const now = Date.now();

// 纯决策：状态转移 / 跳过条件 / since 打点 / 提示语，全在 status-logic.mjs 里，便于单测。
const decision = decide({ event: EVENT, input, prev, now });
if (decision.action === 'delete') {
  try { rmSync(outFile, { force: true }); } catch {}
  process.exit(0);
}
// 状态无需变化（保活非 waiting / 空闲提醒 / compact）——直接退出、绝不写盘。
if (decision.action === 'skip') process.exit(0);

const { status, runningSince, waitingSince, lastPrompt, message } = decision;

const project = cwd ? basename(cwd) : 'unknown';

// git 分支：仅在 prompt / session-start 时探一次（避免每个工具调用都 fork git），其余复用旧值
let gitBranchName = prev.git_branch || '';
if (EVENT === 'prompt' || EVENT === 'session-start') {
  const b = gitBranch(cwd);
  if (b) gitBranchName = b;
}

// 捕获终端窗口信息。win-capture.ps1 要起 PowerShell（~0.5s），而 UserPromptSubmit 会阻塞发送，
// 所以别每个 prompt 都抓：session-start 时抓（含 resume/clear，能跟上换窗口）；prompt 仅在还没抓到时补一次。
// 会话固定在一个终端里，抓一次即可；换终端会由新的 session-start 重新抓。
let winHwnd = prev.win_hwnd || null;
let winPid = prev.win_pid || null;
let windowTitle = prev.window_title || '';
let ownerPid = prev.owner_pid || null;
let tty = prev.tty || '';
let termTitle = prev.term_title || ''; // mac: Ghostty tab 名（如 work1）；Windows 侧由看板实时读窗口标题
// session-start 必抓；prompt 时若还没抓到窗口/会话进程则补抓一次（darwin 靠 ownerPid 收口，
// 别每个 prompt 都 fork ps）；win32 下若已有 hwnd 但缺 win_pid（升级前捕获的老会话），
// 也补抓一次，让 HWND 复用校验尽快生效。
const needCapture =
  EVENT === 'session-start' ||
  (EVENT === 'prompt' && !winHwnd && !ownerPid) ||
  (EVENT === 'prompt' && process.platform === 'win32' && winHwnd && !winPid);
if (needCapture) {
  if (process.platform === 'win32') {
    const cap = captureWindowWin();
    if (cap) { winHwnd = cap.hwnd; winPid = cap.pid; }
  } else if (process.platform === 'darwin') {
    // 标题只用已清洗的 sessionId，避免把目录名里的 ESC/引号写进终端转义或 osascript
    windowTitle = windowTitle || `CLAUDEMON:${sessionId}`;
    captureWindowMac(windowTitle);
    const tab = captureGhosttyTabMac(windowTitle); // 紧接着读 tab 名，复用刚写下的标题
    if (tab) termTitle = tab;
    const p = captureOwnerPidMac();
    if (p) ownerPid = p;
    const t = captureTtyMac(ownerPid || process.pid);
    if (t) tty = t;
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
  win_pid: winPid,
  window_title: windowTitle,
  owner_pid: ownerPid,
  tty,
  term_title: termTitle,
};

// 落盘前再确认一次：写 running/waiting 期间，若文件已被并发的 Stop 写成 done/closed
// 且不比我们旧，就放弃本次写入，别把已经“结束”的状态盖回去（兜住极窄的并发窗口）。
try {
  const cur = JSON.parse(readFileSync(outFile, 'utf8'));
  if (shouldAbortConcurrentWrite(status, cur, now)) process.exit(0);
} catch {}

// 原子写：先写临时文件再 rename，避免看板读到写一半的 JSON
const tmpFile = `${outFile}.${process.pid}.tmp`;
writeFileSync(tmpFile, JSON.stringify(record, null, 2), 'utf8');
renameSync(tmpFile, outFile);
