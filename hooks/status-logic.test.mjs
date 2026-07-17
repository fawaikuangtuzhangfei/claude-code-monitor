// status-logic.test.mjs — emit-status 决策核心的单测（node:test，零依赖）
// 跑： node --test hooks/   或   npm test
//
// 覆盖那些反复回归过的坑：卡 RUN / 假 WAIT / done 被冲回 / 空闲提醒误翻。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, shouldAbortConcurrentWrite, STATUS_BY_EVENT, KEEPALIVE } from './status-logic.mjs';

const NOW = 1_000_000;
// 便捷调用：decide({event, prev, input})，now 固定为 NOW
const d = (event, prev = {}, input = {}) => decide({ event, prev, input, now: NOW });

// ---- 基础状态映射 ----
test('基础事件 -> 状态映射', () => {
  assert.equal(d('prompt').status, 'running');
  assert.equal(d('permission').status, 'waiting');
  assert.equal(d('stop').status, 'done');
  assert.equal(d('session-start').status, 'idle');
});

test('未知事件退回 idle', () => {
  assert.equal(d('bogus').status, 'idle');
});

test('session-end -> delete（删文件）', () => {
  assert.deepEqual(d('session-end'), { action: 'delete' });
});

// ---- 保活事件：只在 waiting 时才清成 running，其余一律 skip ----
test('保活事件在 waiting 时提升为 running（清权限 WAIT）', () => {
  for (const ev of KEEPALIVE) {
    const r = d(ev, { status: 'waiting', waiting_since: 500 });
    assert.equal(r.action, 'write', `${ev} 应写盘`);
    assert.equal(r.status, 'running');
    assert.equal(r.waitingSince, null, '离开 waiting 应清掉 waiting_since');
  }
});

test('保活事件在 running/done/idle 时一律 skip，不写盘（不与 Stop 抢写）', () => {
  for (const ev of KEEPALIVE) {
    for (const st of ['running', 'done', 'idle', undefined]) {
      assert.equal(d(ev, { status: st }).action, 'skip', `${ev} @ ${st} 应 skip`);
    }
  }
});

test('done 之后来的保活事件不会把 done 冲回 running', () => {
  // 一轮结束 Stop->done 后，紧随的 posttool/subagent-stop 必须被忽略
  assert.equal(d('posttool', { status: 'done' }).action, 'skip');
  assert.equal(d('subagent-stop', { status: 'done' }).action, 'skip');
});

// ---- Stop 时仍有后台 agent 未完成：不算真 done ----
test('stop + 有未完成后台 agent -> running（不是 done）', () => {
  const r = decide({ event: 'stop', prev: { status: 'running', running_since: 42 }, input: {}, now: NOW, bgPending: true });
  assert.equal(r.status, 'running', '在等后台结果，应记 running');
  assert.equal(r.runningSince, 42, '连续 running，耗时起点不刷新');
});

test('stop + 后台 agent 都已完成 -> done（照常）', () => {
  assert.equal(decide({ event: 'stop', prev: { status: 'running' }, input: {}, now: NOW, bgPending: false }).status, 'done');
});

test('bgPending 只影响 stop：其它事件不受它左右', () => {
  assert.equal(decide({ event: 'prompt', prev: {}, input: {}, now: NOW, bgPending: true }).status, 'running');
  assert.equal(decide({ event: 'permission', prev: { status: 'running' }, input: {}, now: NOW, bgPending: true }).status, 'waiting');
});

// ---- Notification 二义 ----
test('notification 在 running 时 = 真 WAIT', () => {
  const r = d('notification', { status: 'running' }, { message: '需要授权' });
  assert.equal(r.status, 'waiting');
  assert.equal(r.message, '需要授权');
});

test('notification 在 waiting 时保持 WAIT', () => {
  assert.equal(d('notification', { status: 'waiting' }).status, 'waiting');
});

test('一轮结束后的空闲 notification 不把 done/idle 翻成 waiting', () => {
  assert.equal(d('notification', { status: 'done' }).action, 'skip');
  assert.equal(d('notification', { status: 'idle' }).action, 'skip');
  assert.equal(d('notification', {}).action, 'skip'); // 无 prev 也当空闲忽略
});

// ---- SessionStart compact ----
test('session-start 的 compact 不重置进行中状态（skip）', () => {
  assert.equal(d('session-start', { status: 'running' }, { source: 'compact' }).action, 'skip');
});

test('session-start 的 startup/resume/clear 照常走 idle', () => {
  for (const source of ['startup', 'resume', 'clear', undefined]) {
    const r = d('session-start', { status: 'running' }, { source });
    assert.equal(r.action, 'write', `source=${source} 应写盘`);
    assert.equal(r.status, 'idle');
  }
});

// ---- running_since 打点 / 清除 ----
test('running_since：首次进入 running 打点', () => {
  assert.equal(d('prompt', { status: 'idle' }).runningSince, NOW);
});

test('running_since：连续 running 不刷新（保留原耗时起点）', () => {
  assert.equal(d('prompt', { status: 'running', running_since: 42 }).runningSince, 42);
});

test('running_since：离开 running 清掉', () => {
  assert.equal(d('stop', { status: 'running', running_since: 42 }).runningSince, null);
  assert.equal(d('permission', { status: 'running', running_since: 42 }).runningSince, null);
});

// ---- waiting_since 打点 / 清除 ----
test('waiting_since：首次进入 waiting 打点', () => {
  assert.equal(d('permission', { status: 'running' }).waitingSince, NOW);
});

test('waiting_since：连续 waiting 不刷新（已等待时长连续）', () => {
  assert.equal(d('notification', { status: 'waiting', waiting_since: 7 }).waitingSince, 7);
});

test('waiting_since：离开 waiting 清掉', () => {
  assert.equal(d('stop', { status: 'waiting', waiting_since: 7 }).waitingSince, null);
});

// ---- last_prompt / message ----
test('prompt 事件截取并清洗 last_prompt（压空白、限 120 字）', () => {
  const r = d('prompt', {}, { prompt: '  帮我   重构\n\t分层  ' });
  assert.equal(r.lastPrompt, '帮我 重构 分层');
  const long = d('prompt', {}, { prompt: 'x'.repeat(200) });
  assert.equal(long.lastPrompt.length, 120);
});

test('非 prompt 事件复用旧 last_prompt', () => {
  assert.equal(d('permission', { last_prompt: '上一条' }).lastPrompt, '上一条');
});

test('离开 waiting 清掉 message（避免旧文案串到下次 WAIT）', () => {
  assert.equal(d('prompt', { status: 'waiting', message: '旧提示' }).message, '');
  assert.equal(d('stop', { status: 'waiting', message: '旧提示' }).message, '');
});

test('waiting 状态保留/更新 message', () => {
  assert.equal(d('permission', { status: 'running', message: '保留' }).message, '保留');
  assert.equal(d('notification', { status: 'running' }, { message: '新的' }).message, '新的');
});

// ---- 落盘前并发兜底 ----
test('shouldAbortConcurrentWrite：running/waiting 遇到更新的 done 就放弃', () => {
  assert.equal(shouldAbortConcurrentWrite('running', { status: 'done', updated_at: NOW }, NOW), true);
  assert.equal(shouldAbortConcurrentWrite('waiting', { status: 'closed', updated_at: NOW + 1 }, NOW), true);
});

test('shouldAbortConcurrentWrite：当前文件更旧则照写', () => {
  assert.equal(shouldAbortConcurrentWrite('running', { status: 'done', updated_at: NOW - 1 }, NOW), false);
});

test('shouldAbortConcurrentWrite：写 done/idle 不受此保护约束', () => {
  assert.equal(shouldAbortConcurrentWrite('done', { status: 'done', updated_at: NOW + 1 }, NOW), false);
  assert.equal(shouldAbortConcurrentWrite('idle', { status: 'done', updated_at: NOW + 1 }, NOW), false);
});

test('shouldAbortConcurrentWrite：当前是 running/waiting（非结束态）则照写', () => {
  assert.equal(shouldAbortConcurrentWrite('running', { status: 'running', updated_at: NOW + 1 }, NOW), false);
});

// ---- 一个典型完整生命周期串起来 ----
test('典型生命周期：start -> prompt -> permission -> posttool -> stop', () => {
  let prev = {};
  const start = d('session-start', prev); assert.equal(start.status, 'idle'); prev = { status: start.status };

  const prompt = d('prompt', prev, { prompt: '干活' });
  assert.equal(prompt.status, 'running');
  assert.equal(prompt.runningSince, NOW);
  prev = { status: prompt.status, running_since: prompt.runningSince };

  const perm = d('permission', prev);
  assert.equal(perm.status, 'waiting');
  assert.equal(perm.waitingSince, NOW);
  assert.equal(perm.runningSince, null);
  prev = { status: perm.status, waiting_since: perm.waitingSince };

  const post = d('posttool', prev); // 授权后工具跑起来，清回 running
  assert.equal(post.status, 'running');
  assert.equal(post.waitingSince, null);
  prev = { status: post.status };

  const stop = d('stop', prev);
  assert.equal(stop.status, 'done');
});

// STATUS_BY_EVENT 导出可用性（防止 emit-status 里引用漂移）
test('STATUS_BY_EVENT 覆盖全部事件', () => {
  for (const ev of ['session-start', 'prompt', 'pretool', 'posttool', 'notification', 'permission', 'stop', 'subagent-stop', 'session-end']) {
    assert.ok(STATUS_BY_EVENT[ev], `缺 ${ev}`);
  }
});
