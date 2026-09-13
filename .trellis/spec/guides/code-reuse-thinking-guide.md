# 代码复用思维指南

> **用途**：写新代码之前停一下 —— 它是不是已经存在了？或者它是不是会和已存在的东西悄悄分叉？

这份指南的所有例子都来自本仓库。

---

## 这个项目的复用难点：刻意的重复实现

大多数项目里"重复"就是错。这个项目不一样 —— 它有**三组刻意的重复**，每组都有不可消除的理由。难点不是消除它们，而是**不让它们分叉**。

### 重复 1：安装逻辑的 Node 版与 Rust 版

| | 位置 | 为什么不能合并 |
|---|---|---|
| 命令行安装 | `install/install-hooks.mjs` | 无 GUI 环境要能装 |
| 看板内一键安装 | `app/src-tauri/src/install.rs` | macOS GUI App 的 PATH 带不到 nvm 的 node，不能 shell out 调 Node 脚本（`install.rs:10-12`） |

**必须同步的 7 项**已列成表：[../hooks-node/settings-and-atomic-io.md](../hooks-node/settings-and-atomic-io.md) 的「两份实现的同步清单」。改任何一项之前先看那张表。

最容易分叉的是事件表：

```bash
# 改 MAP 之前，两边都看一眼
grep -n "SessionStart" install/install-hooks.mjs app/src-tauri/src/install.rs
```

### 重复 2：Win32 前台锁序列的 Rust 版与 PowerShell 版

`app/src-tauri/src/lib.rs:307 focus_hwnd_windows()` 和 `tools/phone/focus.ps1`。

`focus.ps1:3` 用注释把它钉住了：`# 逻辑照搬 ... lib.rs:307 focus_hwnd_windows()`。**改一处必须改另一处，并保持这条交叉引用（含行号）准确。**

### 重复 3：session_id 清洗规则的三份实现

`emit-status.mjs:215`、`lib.rs:465 sanitize_id`、`server.mjs:146`（白名单版）。规则必须逐字等价 —— 因为写文件的和读文件的必须算出同一个文件名。见 [../conventions/security-boundaries.md](../conventions/security-boundaries.md) 规则 1。

---

## 写新代码前：先搜

```bash
# 函数/常量是不是已经有了
grep -rn "sanitize\|atomic\|tmpFile" hooks/ install/ app/src-tauri/src/

# 某个字段在几处被读
grep -rn "win_hwnd" hooks/ app/ tools/
```

| 自问 | 如果是 |
|---|---|
| 有类似函数吗？ | 用它或扩展它 |
| 这个模式在别处出现过吗？ | 跟随既有模式（例：所有原子写都是 `tmp + pid → rename`） |
| 我在从另一个文件抄代码吗？ | **停** —— 要么抽出来，要么建立交叉引用注释 |
| 我在改一个常量吗？ | **先 grep 它出现在几处**（见下面的铁律） |

---

## 铁律：改任何值之前先搜

> 这一条习惯能挡掉绝大多数"忘了改另一处"的 bug。

本项目里典型的"一个值散在多处"：

| 值 | 出现位置 | 不同步的后果 |
|---|---|---|
| 版本号 `0.3.5` | `app/package.json`、`tauri.conf.json`、`Cargo.toml` | 采集端版本握手失效，用户永远收不到更新 |
| hook 事件表 | `install-hooks.mjs:41`、`install.rs:32`、`README.md` 映射表 | 两条安装路径行为不一致 |
| `MARK` / `BRIDGE_MARK` | `install-hooks.mjs:32/53`、`install.rs:27/28` | 清不掉旧钩子 → 重复堆叠 |
| `#cards` 的 `gap: 7px` | `styles.css:213`、`main.js:278` | 窗口高度算错，卡片被裁或留白 |
| 状态名 `waiting/running/done/idle` | `status-logic.mjs:15`、`main.js:4 STATUS_META`、`styles.css:284-290`、`README.md` | 新状态没颜色/没排序/不显示 |
| `localStorage` 键 `cm.settings` | `main.js:77/81/497` | 用户设置丢失 |

---

## 本项目已出现的复用缺口（正面例子与反面例子）

### 正面：`status-logic.mjs` 抽出纯决策

状态转移曾经散在 `emit-status.mjs` 的 if 链里，抽成纯函数后才有了 30 条单测。**这是本仓库最该被模仿的一次重构。** 判据：如果一段逻辑"只是在算该怎么做"，它就该进纯文件。

### 正面：CSS 表面色阶

`styles.css:25` 的注释写明了动机：「表面色阶：收拢散落的 rgba(白)，成一套可复用刻度」。散落的 `rgba(255,255,255,0.05)` 被收成 `--surf-1/2/3`，换肤才变成只改一层的事。

### 反面：`focusable` 判定重复三处

```js
// main.js:149、main.js:204、main.js:513 —— 同一个表达式抄了三遍
const focusable = !!(s.win_hwnd || s.window_title);
```

按"同样代码出现 3 次就抽"的规则，这里该有个 `function isFocusable(s)`。已记在 [../code-smells.md](../code-smells.md)。

---

## 什么时候该抽，什么时候不该

**该抽**：同样的代码出现 3 次以上；逻辑复杂到会有 bug；跨层共享的契约（字段名、事件表、清洗规则）。

**不该抽**：只用一次；平凡单行；抽象比重复更难懂。

**特别地 —— 不要抽的情况**：两份实现跑在不同的运行时（Node / Rust / PowerShell / ES5 垫片）。这时正确做法不是抽象，而是**写交叉引用注释 + 在 spec 里维护一张同步清单**。

---

## 状态派生逻辑要集中成一张转移表

当状态由 `event` / `kind` / `action` 这类值派生时，用一张表 + 一个函数，而不是散落的 if：

```js
// 好 —— hooks/status-logic.mjs:15 一张表说清全部映射
export const STATUS_BY_EVENT = { 'session-start': 'idle', prompt: 'running', ... };
export const KEEPALIVE = new Set(['pretool', 'posttool', 'subagent-stop']);
// 例外规则集中在 decide() 里，每条带注释说明它防的是什么现象
```

```js
// 好 —— app/ui/src/main.js:4 UI 侧同样用一张表同时提供标签与排序权重
const STATUS_META = { waiting: { tag: "WAIT", order: 0 }, ... };
```

UI 的 `subOf` / `sideOf` 用 `switch (s.status)`（`main.js:50`、`main.js:66`），也是集中的转移表形状。**加新状态时，这四张表要一起改。**

---

## 提交前自查

- [ ] 搜过有没有已存在的同类代码
- [ ] 没有该共享却被复制的逻辑；若是跨运行时的刻意重复，已加交叉引用注释并更新同步清单
- [ ] 改过的每个常量都 grep 过它的全部出现位置
- [ ] 状态/事件的派生逻辑集中在一张表里，没有散落的 if
- [ ] 新增字段已走完 [../hooks-node/status-contract.md](../hooks-node/status-contract.md) 的 4+2 处联动清单

---

## 坑：非对称机制产出同一份结果

**问题**：两套不同机制要产出同一份东西时（这里是"复制文件"vs"编译期内嵌"），结构性改动只会顺着其中一条路传播，另一条悄悄漂移。

**本项目实例**：hook 脚本清单有两份。

```js
// install/install-hooks.mjs:19-28 —— 运行时 copyFileSync，加文件就要加一行 SRC/DST
```
```rust
// app/src-tauri/src/install.rs:22-25 —— 编译期 include_str!，加文件要加常量 + fs::write
```

**症状**：命令行装出来的采集端有新文件，看板一键装出来的没有（或反过来）。用户看不出差别，只会说"更新了但还是不行"。

**防护**：
- 新增/改名 `hooks/` 下的文件 → **两处都改**，并跑一次 `node install/install-hooks.mjs` + 编译看板，比对 `~/.claude/monitor-hooks/` 的文件清单。
- 改名/移动 `hooks/` 目录会让 `include_str!` 编译失败 —— 这是好事，比运行时静默缺文件好。

## 坑：Rust 的 `match` 有穷尽检查，JS 的 `switch` 没有

给状态机加新状态时：

- Rust 侧 `match` 会编译报错提醒你（好）。
- JS 侧 `switch (s.status)` 会静默走 `default`（`main.js:62` 的 `default:` 返回 cwd 尾部两段，看起来像 IDLE）。
- CSS 侧 `.row.<新状态>` 不存在时，`--accent` 保持 `var(--idle)` 灰色 —— 也是静默。

**所以**：加状态时不要依赖报错，照 [code-reuse 检查清单](#提交前自查) 手动过一遍四张表。
