# 纯/脏分层与单测

`hooks/status-logic.mjs` + `hooks/status-logic.test.mjs` 是这个仓库唯一被测试覆盖的部分，也是本项目最该被复制的模式：**把"该怎么做"从"怎么做"里抽出来，前者纯函数、全量单测；后者只管副作用、不含判断。**

---

## 边界划在哪

| 放进 `status-logic.mjs`（纯） | 留在 `emit-status.mjs`（脏） |
|---|---|
| 状态转移（event + prev → status） | 读 stdin |
| `skip` / `delete` / `write` 的判定 | 读写状态文件、原子 rename |
| `running_since` / `waiting_since` 打点 | 扫 transcript（`hasPendingBackgroundAgent`） |
| `last_prompt` / `message` 的截取与清空 | 抓窗口 HWND / tty / owner_pid |
| 并发兜底判定（`shouldAbortConcurrentWrite`） | `git rev-parse` |
| | 读环境变量 `CC_TAG` |

**判据**：纯文件里不能出现 `node:fs`、`node:child_process`、`Date.now()`、`process.*`。时间由调用方注入（`decide({ ..., now })`），I/O 结果由调用方以布尔/对象传入（`bgPending`）。

`decide()` 返回三种 action，`emit-status.mjs` 只负责执行：

```js
// hooks/emit-status.mjs:241
const decision = decide({ event: EVENT, input, prev, now, bgPending });
if (decision.action === 'delete') { rmSync(outFile, { force: true }); process.exit(0); }
if (decision.action === 'skip')   process.exit(0);   // 绝不写盘
const { status, runningSince, waitingSince, lastPrompt, message } = decision;
```

**新增任何判断逻辑，先问它能不能进 `status-logic.mjs`。** 能进就必须进 —— 因为只有那里能被测到。

---

## 单测规范

```bash
node --test hooks/        # 或 npm test（根 package.json 的 test script）
```

CI 里用显式 glob `node --test hooks/*.test.mjs`（`.github/workflows/ci.yml`），跑在 `ubuntu-latest` 上，排在编译作业前面。

### 写法

- `node:test` + `node:assert/strict`，零依赖。
- 固定时间戳常量 + 简写辅助函数，让每条用例只剩"输入 → 期望"：

  ```js
  // hooks/status-logic.test.mjs:9
  const NOW = 1_000_000;
  const d = (event, prev = {}, input = {}) => decide({ event, prev, input, now: NOW });
  ```
- **测试名用中文写清它防的是哪个现象**，不写"test decide returns running"：
  - `'done 之后来的保活事件不会把 done 冲回 running'`
  - `'一轮结束后的空闲 notification 不把 done/idle 翻成 waiting'`
  - `'running_since：连续 running 不刷新（保留原耗时起点）'`
  - `'stop + 有未完成后台 agent -> running（不是 done）'`
- 断言带说明字符串，失败时一眼看出是哪个组合：`assert.equal(d(ev, { status: st }).action, 'skip', \`${ev} @ ${st} 应 skip\`)`。
- 用 `for` 循环覆盖组合（`status-logic.test.mjs:31` 遍历 `KEEPALIVE`、`:41` 遍历 4 种 prev 状态、`:92` 遍历 4 种 `source`）。
- 用 `// ---- 分组名 ----` 注释分组，与被测文件的逻辑顺序一致。

### 必须有的三类用例

1. **每条反直觉规则一条**（见 [status-contract.md](./status-contract.md) 的四条）。
2. **导出面守卫**：`'STATUS_BY_EVENT 覆盖全部事件'`（`status-logic.test.mjs:193`）—— 防止 `emit-status.mjs` 里的引用漂移。加新事件必须在这个列表里补名字。
3. **一条端到端生命周期串起来**（`status-logic.test.mjs:168`）：`start → prompt → permission → posttool → stop`，手动把上一步的输出喂给下一步的 `prev`。加了新状态就在这里串一遍。

### 回归约定（硬规）

> 修了一个状态相关的 bug → 在 `status-logic.test.mjs` 留一条用例，测试名是那个 bug 的现象。

文件头就是这么写的：「覆盖那些反复回归过的坑：卡 RUN / 假 WAIT / done 被冲回 / 空闲提醒误翻」。当前 30 条用例基本都是这么攒出来的。

---

## 探测节流（性能约定）

`UserPromptSubmit` 会**阻塞用户发送**，所以这条路径上的每一次 fork 都直接体现为"回车后卡一下"。现有节流规则，新增探测时照此设计：

| 探测 | 频率 | 为什么 |
|---|---|---|
| `win-capture.ps1`（起 PowerShell ~0.5s） | `session-start` 必抓；`prompt` 仅在还没抓到时补一次 | `emit-status.mjs:260`：会话固定在一个终端里，抓一次即可；换终端会由新的 session-start 重新抓 |
| `git rev-parse` | 仅 `prompt` / `session-start`，其余复用 `prev.git_branch` | `emit-status.mjs:253`：避免每个工具调用都 fork git |
| `ps`（mac owner_pid / tty） | `prompt` 时若已有 `ownerPid` 就不再 fork | `emit-status.mjs:275` |
| 扫 transcript 找后台 agent | **仅 `stop`** | `emit-status.mjs:237`：其余事件不需要，避免每步都读盘 |
| 读 `CC_TAG` 环境变量 | 每次都读 | 纯 env 读取无 fork，改了立即生效 |

`needCapture` 的条件表达式（`emit-status.mjs:277`）是这套节流的集中体现，它还带一条升级兼容分支：Windows 下已有 `hwnd` 但缺 `win_pid`（升级前捕获的老会话）时补抓一次。

### 大文件只读尾部

```js
// hooks/emit-status.mjs:137
// 只读文件尾部 maxBytes 字节（从中间截断时丢掉开头的半行）。用于扫 transcript：
//   - 降延迟：大 transcript 不必整读（28MB 全读 ~70ms，只读尾部 ~2ms）
//   - 收窄误判窗口：后台 agent 几乎都是近期启动的...
const TAIL_BYTES = 1024 * 1024;
```

注意第二条理由：截断窗口本身也是功能的一部分（让"永远没回报完成"的僵尸 agent 自然滑出，不把会话永久钉在 RUN）。别为了"更准"改成全量扫描。

### 扫描用字符串匹配，不整行 JSON.parse

`hasPendingBackgroundAgent` 先 `line.includes('Async agent launched successfully')` 再上正则（`emit-status.mjs:169-187`）。id 格式锁死 `[0-9a-f]{16,}`，注释说明了为什么（`emit-status.mjs:156`）：避免把粘贴进会话正文里的类似字样、或旧版本的短 task-id 误当成真 agent。
