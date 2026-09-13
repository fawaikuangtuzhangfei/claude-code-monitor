# 跨层思维指南

> **用途**：这个项目的绝大多数 bug 都发生在**层与层的缝隙里**，不是发生在某一层内部。写代码前先把数据流走一遍。

---

## 先记住这张图

```
[1] Claude Code 进程
      │ 9 个 hook 事件，JSON 从 stdin 进来
      ▼
[2] hooks/emit-status.mjs   ←── hooks/status-logic.mjs（纯决策）
      │ 原子写
      ▼
[3] ~/.claude/monitor/<session_id>.json      ← 唯一的跨进程契约
      │                  ~/.claude/monitor/usage-limits.json  ← statusline-bridge 写
      ├──────────────┬──────────────────────┐
      ▼              ▼                      ▼
[4] app/src-tauri  tools/phone/server.mjs   （将来的任何读者）
      │ invoke        │ REST + 伪造 __TAURI__
      ▼              ▼
[5] app/ui/src/main.js  →  DOM
```

**关键事实**：[3] 是文件，不是内存对象。它没有类型、没有版本字段、写方和读方是不同进程、甚至是不同发布周期的不同版本。所有跨层问题都源于这一点。

---

## 什么时候必须读这份指南

- [ ] 你要往状态 JSON 加/改/删字段
- [ ] 你要加一个 hook 事件或状态
- [ ] 你要加一个 Tauri 命令
- [ ] 你不确定某段逻辑该放哪一层
- [ ] 同一份数据有多个消费者需要它
- [ ] UI 代码开始直接读一个"我猜它一定有"的字段

---

## 五个必答问题

### 1. 这个字段可能不存在吗？

**永远假设"会不存在"。** 三种不存在：

| 情形 | 例子 |
|---|---|
| 老版本采集端没写这个字段 | `lib.rs:54`：「旧状态文件没有 `win_pid` 时跳过此校验，保持兼容」 |
| 本平台不产生这个字段 | Windows 上没有 `owner_pid`/`tty`；macOS 上没有 `win_hwnd`/`win_pid` |
| 这一刻还没采集到 | `win_hwnd` 要等第一次 `session-start`/`prompt` 才有 |

写法：Rust 一律 `.get(k).and_then(|x| x.as_i64()).unwrap_or(0)`；JS 一律 `s.field || 兜底`。**不要 `as_i64().unwrap()`，不要 `s.field.length`。**

反过来：新增字段时不要让 UI 的核心功能依赖它 —— 老采集端的用户会看到功能消失。

### 2. 同一目录里有不是我的文件吗？

`~/.claude/monitor/` 里混着会话文件和 `usage-limits.json`。判据是**有没有 `status` 字段**：

```rust
// lib.rs:34  跳过目录里的非会话 json（如 statusline 桥接写的 usage-limits.json）。
// 会话文件必有 status 字段；缺了就不是会话，别渲染成一张 "unknown" 空卡。
```
```js
// server.mjs:89  会话文件必有 status；usage-limits.json 这类没有，跳过
```

**新增任何写进这个目录的文件，都要确认所有读者的过滤条件还挡得住它。**

### 3. 逻辑该放哪一层？

| 逻辑类型 | 放哪 | 为什么 |
|---|---|---|
| 状态转移、`since` 打点、文本截取 | `hooks/status-logic.mjs`（纯） | 只有那里能被单测覆盖 |
| 平台探测（窗口/tty/pid/git） | `hooks/emit-status.mjs` | 副作用层 |
| 僵尸会话剔除、实时窗口标题 | `app/src-tauri/src/lib.rs` | 需要实时查系统状态，落盘值会过期 |
| token 用量累加 | Rust（`spawn_blocking`） | 要读大文件，不能占主线程也不能进 hook 关键路径 |
| 格式化、排序、去重、显示决策 | `app/ui/src/main.js` | 纯展示，不该污染契约 |

**一条判据**：**会过期的东西不要落盘，要实时算。** 窗口标题就是范例 —— hook 抓 HWND 落盘（不过期的标识），Rust 每次读取时用 HWND 实时查标题并注入 `term_title`（`lib.rs:65-70`）。

**另一条判据**：**展示用的派生值不要落盘。** `elapsed()`、`fmtReset()`、卡片副标题全在 UI 侧从 `running_since`/`waiting_since`/`resets_at` 算出来，所以手机端把轮询从 1s 拉到 6s 也不会算错（只是刷得粗）。

### 4. 谁还在读这个字段？

改字段前必须 grep 全仓库，因为读者比你想的多：

```bash
grep -rn "win_hwnd" hooks/ app/ tools/ README.md
```

`win_hwnd` 的实际读者有 5 处：`lib.rs:45`（存活检测）、`lib.rs:285`（聚焦）、`main.js:149`（自动切窗判定）、`main.js:204`（`focusable` class）、`main.js:513`（右键菜单项显隐）、`server.mjs:149`（手机端聚焦）。

完整的联动清单在 [../hooks-node/status-contract.md](../hooks-node/status-contract.md)（4 处代码 + 2 处文档），照着走。

### 5. 两个进程会同时写吗？

会。`Stop` 和 `PostToolUse` 可以在几毫秒内先后触发，各是一个独立的 node 进程。

三道防护，缺一条就会出现"卡在 RUN"或"DONE 被冲回"：

1. **不需要写就别写**：保活事件在非 waiting 时直接 `skip`（`status-logic.mjs:58`）—— 从根上减少并发写。
2. **落盘前再读一次**：`shouldAbortConcurrentWrite`（`status-logic.mjs:99`），发现文件已被写成更新的 `done`/`closed` 就放弃。
3. **原子写**：`tmp.<pid>` + `rename`，读方永远读不到半份 JSON。

**新增任何写盘路径时，这三条都要想过。**

---

## 三条跨层反模式（本项目已踩过）

### 反模式 1：在读方做本该在写方做的清洗

session_id 落盘时就已清洗（`emit-status.mjs:213` 注释：清洗后的值**同时**作为 `record.session_id`，聚焦时按它回查文件，两边必须一致）。

如果落盘用原值、路径用清洗值，`focus_session` 就永远找不到文件。**契约字段的值必须和它派生出的文件名一致。**

### 反模式 2：把"没数据"和"连不上"渲染成同一个样子

```js
// tools/phone/server.mjs:254
// main.js 的 tick() 拉数失败时会走 render([])，页面显示「无运行中的会话」——
// 于是「服务挂了 / WiFi 断了 / 电脑休眠了」和「一切正常、没会话在跑」长得一模一样。
```

桌面版能接受（进程死了看板也就没了），但只要数据源变远（HTTP、将来的任何远程读取），失败态就必须视觉可区分。

### 反模式 3：让下游去修上游的语义歧义

`Notification` 事件本身是二义的（真 WAIT vs 一轮结束后的空闲提醒）。正确做法是**在最上游（`status-logic.mjs:62`）就消解歧义**，只把明确的状态写进契约。

如果让 UI 去猜"这条 waiting 是不是假的"，那手机端、Rust 端都得各猜一遍，且必然猜得不一样。

---

## 新增一条跨层数据的完整流程

1. 先写 **契约**：字段名、类型、可能缺失、谁负责产生。补进 [../hooks-node/status-contract.md](../hooks-node/status-contract.md) 的字段表。
2. 写方（`emit-status.mjs`）：决定探测频率（见 [../hooks-node/pure-logic-and-tests.md](../hooks-node/pure-logic-and-tests.md) 的探测节流表）。
3. 纯逻辑部分放 `status-logic.mjs` + 补单测。
4. 读方逐个过：`lib.rs` → `main.js` → `server.mjs`，每处都按"可能不存在"写。
5. 文档：README 的映射表 / 隐私说明。
6. **bump 版本号**（否则用户的采集端不会被刷新）。

---

## 验证 AI 交叉评审结果时

AI 评审的假阳性率不低（经验值约 1/3），每条 CRITICAL/WARNING 都要对着代码核一遍。本项目最常见的三类假阳性：

1. **信任边界混淆**：把本机数据当外部不可信输入。判据 —— 数据来自 Claude Code 自己落的本地日志 / 用户自己的 `settings.json`，还是来自网络（`tools/phone` 的 HTTP 请求）？后者才需要严格校验。
2. **忽略设计注释**：这个仓库里"看起来多余"的代码几乎都有注释说明为什么必需（`window_pid_windows` 校验、300ms 浮窗守卫、`keybd_event` 假装按键）。**改之前先读注释**；注释说了理由还认为它是 bug，要能指出注释哪里错了。
3. **把跨运行时的刻意重复报成"应该抽取"**：`install.rs` vs `install-hooks.mjs`、`focus.ps1` vs `focus_hwnd_windows`。理由都写在文件头。

判据：**先在代码里找到它的理由，再判断它是不是缺陷。**

---

## 提交前自查

- [ ] 新字段在每个读方都按"可能不存在"处理
- [ ] 契约变更已 bump 版本号
- [ ] 会过期的值没有被落盘
- [ ] 新增写盘路径过了并发三道防护
- [ ] `README.md` 的映射表 / 隐私说明已同步
- [ ] 加新状态时四张表（`STATUS_BY_EVENT` / `STATUS_META` / CSS / README）都改了
