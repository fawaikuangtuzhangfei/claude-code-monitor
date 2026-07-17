// status-logic.mjs — emit-status 的“纯决策”核心（无副作用、无 I/O）
//
// 把 hook 事件 + 上一份状态 -> “这次该怎么写盘”的判定抽出来，方便单测覆盖：
//   - 保活事件只在 waiting 时才提升为 running（不与 Stop→done 抢写）
//   - 一轮结束后的空闲 notification 不该把 done 翻回 waiting
//   - SessionStart 的 compact 不重置进行中状态
//   - running_since / waiting_since 打点与清除
//   - 落盘前的并发兜底（已被 Stop 写成 done/closed 就放弃本次写）
//
// emit-status.mjs 负责其余的副作用（读 stdin、抓窗口/tty、git 分支、原子写盘）。

// event -> 状态。running/waiting/done/idle/closed
// pretool/posttool/subagent-stop 是“保活/清 WAIT”事件：映射成 running，但 KEEPALIVE
// 逻辑会限制它们只在当前 waiting 时才真正写盘，避免与紧随的 Stop→done 抢写。
export const STATUS_BY_EVENT = {
  'session-start': 'idle',
  prompt: 'running',
  pretool: 'running',         // 工具将执行（保活/清 WAIT）
  posttool: 'running',        // 工具已执行完（保活/清 WAIT）
  notification: 'waiting',     // 运行中才算真 WAIT；结束后的空闲提醒会被忽略
  permission: 'waiting',
  stop: 'done',
  'subagent-stop': 'running', // 子任务停了，主会话通常还在跑（保活）
  'session-end': 'closed',
};

// 这三类事件只负责“把 waiting 清成 running”，别的情况一律不写盘
export const KEEPALIVE = new Set(['pretool', 'posttool', 'subagent-stop']);

function clip(s) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 120);
}

// 决定这次 hook 该做什么。返回下列之一：
//   { action: 'delete' }                                    — 删状态文件（session-end）
//   { action: 'skip' }                                      — 状态无需变化，直接退出、不写盘
//   { action: 'write', status, runningSince, waitingSince,  — 计算好的落盘字段
//                       lastPrompt, message }
//
// 入参：
//   event     — 归一化后的事件名（小写）
//   input     — hook 从 stdin 传入的对象（可能缺字段）
//   prev      — 上一份状态记录（无则传 {}）
//   now       — 当前时间戳（毫秒），由调用方注入以便测试
//   bgPending — Stop 时是否仍有已启动、未回报完成的后台 agent（由 I/O 层扫描 transcript 得出）
export function decide({ event, input = {}, prev = {}, now, bgPending = false }) {
  let status = STATUS_BY_EVENT[event] ?? 'idle';

  // Stop 但还有后台 agent 在跑：主会话并非真 done——它在等后台结果，稍后会被自动唤醒续跑。
  // 记为 running（绿：机器在干活），而不是 done（蓝：可以去看了）。等后台清空后的 Stop 才算真 done。
  if (event === 'stop' && bgPending) status = 'running';

  // session 结束：删文件，看板自然消失
  if (status === 'closed') return { action: 'delete' };

  // 保活类事件：仅当当前在 waiting 时才提升为 running（清掉权限 WAIT）；
  // 其余情况直接退出、绝不写盘——从根上避免与 Stop→done 并发抢写把 DONE 冲回 RUN。
  if (KEEPALIVE.has(event) && prev.status !== 'waiting') return { action: 'skip' };

  // Notification 二义：运行中的“需授权/输入”=真 WAIT；一轮结束后的空闲提醒其实是 DONE。
  // 只有当前在 running/waiting 才认作真 WAIT；已 done/idle 的忽略这条空闲提醒。
  if (event === 'notification' && prev.status !== 'running' && prev.status !== 'waiting') {
    return { action: 'skip' };
  }

  // SessionStart 的 compact 只是上下文压缩、不是新会话，别把进行中状态重置成 idle。
  if (event === 'session-start' && input.source === 'compact') return { action: 'skip' };

  // running_since：进入 running 时打点，用于前端算耗时；离开 running 清掉
  let runningSince = prev.running_since || null;
  if (status === 'running') {
    if (prev.status !== 'running') runningSince = now;
  } else {
    runningSince = null;
  }

  // waiting_since：进入 waiting 时打点，用于前端显示“已等待时长”；离开 waiting 清掉
  let waitingSince = prev.waiting_since || null;
  if (status === 'waiting') {
    if (prev.status !== 'waiting') waitingSince = now;
  } else {
    waitingSince = null;
  }

  // 从 hook 输入里尽量捞一句“正在做什么”作为提示
  let lastPrompt = prev.last_prompt || '';
  if (event === 'prompt' && typeof input.prompt === 'string') lastPrompt = clip(input.prompt);

  let message = prev.message || '';
  if (event === 'notification' && typeof input.message === 'string') message = clip(input.message);
  // 离开 waiting 就清掉提示语，避免下一次 WAIT（尤其权限 WAIT）沿用上一条旧文案
  if (status !== 'waiting') message = '';

  return { action: 'write', status, runningSince, waitingSince, lastPrompt, message };
}

// 落盘前的并发兜底：写 running/waiting 期间，若文件已被并发的 Stop 写成 done/closed
// 且不比本次旧，就放弃写入，别把“已结束”盖回去。cur = 落盘前重新读到的当前文件内容。
export function shouldAbortConcurrentWrite(status, cur = {}, now) {
  if (status !== 'running' && status !== 'waiting') return false;
  return (cur.status === 'done' || cur.status === 'closed') && (cur.updated_at || 0) >= now;
}
