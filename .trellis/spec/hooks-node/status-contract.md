# 状态契约（跨层，改动前必读）

`~/.claude/monitor/<session_id>.json` 是本项目**唯一的跨进程契约**，有 4 个实现同时读/写它。改这个契约的成本最高，所以这份文档单独列出来。

---

## 状态机

五个状态（`hooks/status-logic.mjs:15 STATUS_BY_EVENT`）：

| 状态 | 含义 | UI 颜色 | 排序权重（`main.js:4`） |
|---|---|---|---|
| `waiting` | 等你输入/授权 | 琥珀 `--wait` | 0（最前，最需注意） |
| `running` | 正在干活 | 绿 `--run` | 1 |
| `done` | 本轮完成 | 蓝 `--done` | 2 |
| `idle` | 空闲 | 灰 `--idle` | 3 |
| `closed` | 会话结束 → **删文件**，不落盘 | —— | —— |

事件映射：

| Claude Code hook | 传给发射器的参数 | 映射状态 | 特殊规则 |
|---|---|---|---|
| `SessionStart` | `session-start` | `idle` | `source === 'compact'` 时 **skip**（上下文压缩不是新会话） |
| `UserPromptSubmit` | `prompt` | `running` | 顺便截取 `last_prompt` |
| `PreToolUse` | `pretool` | `running` | **保活**：仅当 `prev.status === 'waiting'` 才写盘 |
| `PostToolUse` | `posttool` | `running` | 同上 |
| `SubagentStop` | `subagent-stop` | `running` | 同上 |
| `Notification` | `notification` | `waiting` | 仅当 `prev.status` 是 `running`/`waiting` 才算真 WAIT |
| `PermissionRequest` | `permission` | `waiting` | |
| `Stop` | `stop` | `done` | 若仍有未回报的后台 agent → 改记 `running` |
| `SessionEnd` | `session-end` | `closed` | 删文件 |

### 四条反直觉规则（都是回归过的 bug，别"简化"掉）

1. **保活事件只在 waiting 时才写盘**（`status-logic.mjs:58`）。`pretool`/`posttool`/`subagent-stop` 的唯一职责是"把权限 WAIT 清成 RUN"。如果它们无条件写 `running`，就会和紧随的 `Stop → done` 抢写，把 DONE 冲回 RUN（卡在绿色）。
2. **一轮结束后的空闲 notification 不能把 done 翻回 waiting**（`status-logic.mjs:62`）。`Notification` 是二义的：运行中的"需授权"是真 WAIT，一轮结束后 Claude Code 还会发一条空闲提醒。
3. **`Stop` 时若有后台 agent 未完成，不算真 done**（`status-logic.mjs:51`）。主会话在等后台结果、稍后会被自动唤醒续跑，记 `running`（绿：机器在干活）而不是 `done`（蓝：可以去看了）。判据在 `emit-status.mjs:169 hasPendingBackgroundAgent()`：扫 transcript 尾部，配对 `Async agent launched successfully` + `agentId: <id>` 与 `<task-id><id></task-id>`。
4. **落盘前再读一次做并发兜底**（`status-logic.mjs:99 shouldAbortConcurrentWrite`）。写 `running`/`waiting` 期间若文件已被并发的 Stop 写成 `done`/`closed` 且不比本次旧，放弃写入。

### `since` 打点规则

- `running_since`：**首次**进入 running 时打点；连续 running 不刷新（保留原耗时起点）；离开 running 置 `null`。
- `waiting_since`：同构，用于显示"已等待时长"。
- `message`：离开 waiting 时必须清空（`status-logic.mjs:92`），否则下一次 WAIT（尤其权限 WAIT）会沿用上一条旧文案。

---

## 状态文件字段表

`emit-status.mjs:303 record`：

| 字段 | 类型 | 来源 / 说明 | 谁在读 |
|---|---|---|---|
| `session_id` | string | **已清洗**（`[A-Za-z0-9_-]`，≤128）。聚焦/删除时按它回查文件 | 全部 |
| `project` | string | `basename(cwd)` | UI（`nameOf` 兜底） |
| `cwd` | string | | UI（title、打开目录、IDLE 副标题） |
| `status` | string | **会话文件的判据字段**：缺 `status` 就不是会话文件 | 全部 |
| `updated_at` | number | 毫秒；并发兜底与时效闸门都靠它 | 全部 |
| `running_since` | number\|null | | UI 计时 |
| `waiting_since` | number\|null | | UI 计时 |
| `git_branch` | string | 仅在 `prompt`/`session-start` 探一次 | UI 分支芯片 |
| `last_prompt` | string | 压空白后前 120 字（隐私相关，README 有交代） | UI 副标题 |
| `message` | string | Notification 文案，前 120 字 | UI 副标题 / 通知正文 |
| `transcript_path` | string | | 发射器自己（扫后台 agent） |
| `win_hwnd` | number\|null | Windows 终端窗口句柄 | Rust 存活检测/聚焦；phone 原型 |
| `win_pid` | number\|null | 捕获时拥有该 HWND 的进程 —— 检测 HWND 被回收复用 | Rust；phone 原型 |
| `window_title` | string | macOS 写进终端标题的 `CLAUDEMON:<sessionId>` 标记 | Rust 聚焦兜底 |
| `owner_pid` | number\|null | macOS 承载会话的进程（第一个非 shell 祖先） | Rust 僵尸检测；phone 原型 |
| `tty` | string | macOS `/dev/ttysNNN` | Rust 精确聚焦 Ghostty split |
| `term_title` | string | 卡片标签：`CC_TAG` 环境变量 > mac Ghostty tab 名 | UI 卡片标题（优先级最高） |

Rust 侧在 Windows 上会**运行时注入** `term_title`（用实时窗口标题覆盖，`lib.rs:65-70`）—— 所以 UI 看到的 `term_title` 可能不是落盘那个值。

同目录下 `usage-limits.json` 不是会话文件（由 statusline 桥接写），靠"没有 `status` 字段"被跳过（`lib.rs:36`、`server.mjs:90`）。

---

## 加/改字段的 4 处联动清单（照着做，别漏）

改 `record` 的任何字段，按顺序检查：

1. **`hooks/emit-status.mjs`** —— 采集并写入 `record`。若需要新探测，先读 [pure-logic-and-tests.md](./pure-logic-and-tests.md) 的探测节流规则。
2. **`hooks/status-logic.mjs`** —— 如果该字段参与状态判定或 `since` 打点，逻辑放这里（纯函数），**并在 `status-logic.test.mjs` 补用例**。
3. **`app/src-tauri/src/lib.rs`** —— `list_sessions` 是否需要过滤/加工它；`focus_session` / `remove_session` 是否用到它。字段可能不存在，一律 `.and_then(...).unwrap_or(...)`。
4. **`app/ui/src/main.js`** —— `nameOf` / `subOf` / `sideOf` / `updateRow` 是否要展示它；是否影响 `focusable` 判定（当前是 `!!(s.win_hwnd || s.window_title)`，出现在 `main.js:204`、`main.js:149`、`main.js:513` **三处**，改判定要一起改）。

再加两处容易忘的：

5. **`tools/phone/server.mjs`** —— `listSessions()` 的过滤逻辑（`rec.win_pid ?? rec.owner_pid`）是否受影响。
6. **`README.md`** —— `## 工作原理` 的映射表、`## 隐私说明` 的字段列举。

并且：**新增字段必须 bump 版本号**，否则用户机器上的采集端不会被刷新。见 [../conventions/versioning-release.md](../conventions/versioning-release.md)。

## 加新 hook 事件的清单

1. `hooks/status-logic.mjs` 的 `STATUS_BY_EVENT` 加映射（若是保活类，同时加进 `KEEPALIVE`）。
2. `status-logic.test.mjs` 的「STATUS_BY_EVENT 覆盖全部事件」用例里补上事件名（`status-logic.test.mjs:194`），并为新规则单独写用例。
3. `install/install-hooks.mjs:41` 的 `MAP` 加一行。
4. `app/src-tauri/src/install.rs:32` 的 `MAP` 加**同样**一行（两份表必须逐字对齐）。
5. `README.md` 的 hook → 状态映射表。
6. bump 版本号（否则老用户的 `settings.json` 不会被刷新，新事件永远不会触发）。
