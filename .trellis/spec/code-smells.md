# 现存坏味道清单

> 生成时间：2026-09-13 · 基准 commit `d5756d3`
>
> **这是待办清单，不是规范。** 每条都核对过源码，给出了具体位置。**本次只列不改** —— 改哪条、改不改由你决定。
> 修掉一条就从这里删掉；如果决定"就这样不改"，把它移到文末的「刻意保留」并写上理由。

排序：文档失真 → 一致性缺口 → 潜在缺陷 → 死代码 → 结构性。

---

## A. 文档失真（对外承诺与代码不符）

### A1. README 承诺了不存在的「迷你模式」 🔴

- `README.md:23` —— 「🪟 **迷你模式**：折叠成一条，只留 `WAIT/RUN/DONE` 计数 + 呼吸信号灯，占地极小。」
- `README.md:134` —— 设置菜单清单里也列了「迷你模式」。

**事实**：全仓库搜不到任何 mini/折叠实现。`index.html:38-45` 的设置菜单只有 5 项（notify / sound / autofocus / light / autostart），`main.js:74` 的 `DEFAULTS` 也只有 4 个键。

**为什么算缺陷**：README 是这个项目对外唯一的说明书，用户会照着找这个功能。违反 [conventions/comment-and-doc.md](./conventions/comment-and-doc.md) 的「禁止在 README 里写还没实现的功能」。

**两条出路**：删掉这两处，或者把功能实现出来（`styles.css` 已有 `.readout`/`.sig` 的全部素材，做起来不大）。

### A2. README 目录结构树缺 3 个实际存在的部分 🟡

`README.md:145-160` 的树里没有：

| 缺失 | 实际位置 | 重要性 |
|---|---|---|
| `hooks/statusline-bridge.mjs` | 存在，~87 行 | 高 —— 它是拿限额 % 的唯一途径 |
| `app/src-tauri/src/install.rs` | 存在，~222 行 | 高 —— 看板自带安装能力的全部实现 |
| `tools/phone/` 整个目录 | 存在，~1300 行 | 中 —— 实验性，但已进仓库 |

树里写的 `app/src-tauri/ # Rust：置顶透明窗口 + ...` 也已过时（窗口现在是 `transparent: false`，见 `tauri.conf.json` 和 `styles.css:107` 的注释）。

---

## B. 一致性缺口（同一个值/规则的多份实现已分叉）

### B1. `focus_session` 没清洗 session_id，`remove_session` 清洗了 🟡

```rust
// app/src-tauri/src/lib.rs:277 —— 直接拼原值
.join(format!("{session_id}.json"));

// app/src-tauri/src/lib.rs:491 —— 同一个文件里，这个走了清洗
.join(format!("{}.json", sanitize_id(&session_id)));
```

**实际风险低**：调用方是自己的 UI（走 Tauri IPC），且 `focus_session` 只读文件。但它违反了 `sanitize_id` 自己的注释承诺（`lib.rs:464`「杜绝 ../ 路径穿越（与 hook 端规则一致）」），也和 [conventions/security-boundaries.md](./conventions/security-boundaries.md) 规则 1 冲突。

**修法**：一行 —— `format!("{}.json", sanitize_id(&session_id))`。顺手检查 `open_dir`（`lib.rs:501`）收到任意路径直接 `spawn explorer/open`，同样只有自己 UI 会调，但值得加一句"必须是绝对路径且存在"的校验。

### B2. 高度计算里的 padding 魔数与 CSS 不一致 🟡

```js
// app/ui/src/main.js:275
let cards = 16; // #cards 上下 padding 各 8
```
```css
/* app/ui/src/styles.css:212 */
#cards { padding: 9px; ... }   /* 上下各 9 → 应该是 18 */
```

差 2px。`main.js:285` 有 2px 死区，所以表现上几乎看不出来 —— 但这正是它能一直活着的原因。同一行注释里的 `gap` 常量（7）目前是对的。

**修法**：改成 `18`，或者更好 —— 从 `getComputedStyle(cardsEl)` 读，彻底消除这对孪生常量。

### B3. Rust 侧窗口尺寸兜底值与 `tauri.conf.json` 不一致 🟢

`tauri.conf.json` 里两个窗口都是 `380 × 280`，但兜底值是：

- `lib.rs:561` —— `.unwrap_or(300.0)`（宽度）
- `lib.rs:630 / 712 / 743 / 781` —— `PhysicalSize::new(320, 280)`（4 处，都是 320）

只有 `outer_size()` / `inner_size()` 调用失败时才生效，实际几乎不触发。但 4 处重复的魔数 + 和配置不符，属于典型的"改配置忘改兜底"。

**修法**：提一个 `const DEFAULT_WIN: (u32, u32) = (380, 280);`，4 处引用它。

### B4. `hooks_status` 返回的两个字段前端从未使用 🟢

```rust
// app/src-tauri/src/install.rs:95-96
"bridge_exists": bridge_exists,
"statusline_wrapped": statusline_wrapped,   // 注释说「决定弹窗文案，也用于判断要不要提示接管」
```

`main.js:583-592` 只读了 `needs_install` / `first_time` / `installed_version` / `app_version`。`statusline_wrapped` 的那句注释描述的行为**没有实现** —— `main.js:590` 无条件 `checked = true`。

**修法**：要么让 UI 真的用上它（已接管过就不再强调"接管状态栏"这句话），要么删掉字段和那半句注释。

---

## C. 潜在缺陷

### C1. 拆分 `main.js` 会静默产出坏掉的 `main.legacy.js` 🔴（隐藏地雷）

`tools/phone/build.mjs:61` 调 esbuild 时**没有 `--bundle`**：

```js
['--yes', 'esbuild', `"${TMP}"`, '--target=es2015', '--format=iife', `--outfile="${OUT}"`]
```

实测：对含 ESM `import` 的文件，这套参数**不报错**，而是产出

```js
(() => { var import_dep = require("./dep.js"); ... })();
```

浏览器里 `require is not defined`，页面白屏；而 `build.mjs` 会打印 `✓ 已生成`。

**当前安全**：`main.js` 没有任何 `import`。但 [ui-vanilla/index.md](./ui-vanilla/index.md) 提到的"文件太长该拆"一旦执行，就会踩中这个 —— 而且是手机端白屏、桌面端正常，最难定位的那种。

**修法（做任一即可，建议现在就做）**：给 `build.mjs` 加 `--bundle`（当前无 import，加了行为不变，等于提前埋好安全网）；或在 `build.mjs` 里加一条断言 —— 源码含 `^import ` 就报错要求加 `--bundle`。

### C2. `notifiedStatus` 只增不减 🟢

```js
// app/ui/src/main.js:20
const notifiedStatus = new Map();     // session_id -> status
```

`render()` 在会话消失时 `rows.delete(id)`（`main.js:257`）但从不删 `notifiedStatus`。看板是常驻进程（开机自启、可能跑几周），每个**曾经出现过**的 session_id 都会留一条。

**注意这是个取舍，不是纯 bug**：`main.js:18` 的注释明确说了放模块级就是为了"某会话反复进出列表也不重复通知"。所以修的时候不能简单跟着 `rows` 一起删 —— 那会让"会话短暂消失再回来"重新触发通知。

**建议修法**：加上限（比如超过 500 条时按插入顺序丢掉最旧的一半），或者存 `{ status, seenAt }` 并在 `tick` 里清掉 24h 未见的。

### C3. `install.rs` 只能装不能卸 🟢

看板内有 `install_hooks`，没有 `uninstall_hooks`。用户通过弹窗装上采集端后，想卸载只能回到命令行跑 `node install/install-hooks.mjs --uninstall` —— 而这条路径恰恰是 `install.rs` 存在的理由所要规避的（macOS GUI 用户可能没有可用的 node）。

`README.md:123` 只承诺了"自动探测 + 一键更新"，没承诺卸载，所以不算文档失真。但功能是缺的。

---

## D. 死代码

### D1. `.row.leaving` / `@keyframes rowout` 从未被使用 🟢

```css
/* app/ui/src/styles.css:312-313 */
.row.leaving { animation: rowout 0.25s ease forwards; }
@keyframes rowout { to { opacity: 0; transform: translateX(10px); height: 0; ... } }
```

`main.js:258` 在会话消失时直接 `el.remove()`，没有任何地方加 `leaving` class。所以卡片有入场动画（`rowin`）却没有离场动画。

**两条出路**：删掉这 2 行；或者接上（`el.classList.add("leaving")` + `animationend` 后 `remove()`），但要注意这会让 `autosize` 的行高统计在动画期间不准 —— 大概是它当初被放弃的原因。

---

## E. 结构性（现在不必动，但要知道边界在哪）

### E1. `app/ui/src/main.js` 单文件 624 行承担 8 类职责 🟡

按注释分区：状态元数据 / 设置持久化 / 通知 / 渲染 / 高度自适应 / 用量条 / 标题栏与浮层 / 启动。

**现在不建议拆**，两个原因：

1. 分区注释 + 顶部纯函数区让它仍然可读，这是它到 624 行还没失控的原因。
2. 拆成 ES 模块会踩中 **C1** —— 先把那个修了再谈拆。

**边界**：超过 ~800 行、或者出现"改一处要在三个区块之间来回跳"的情况时再拆。拆的第一刀建议切 `设置 + 通知`（它们和渲染几乎没有耦合，只共享 `settings` 和 `IS_DOCK`）。

### E2. `app/src-tauri/src/lib.rs` 918 行混了 4 类职责 🟡

命令实现 / 窗口定位 / 平台原生调用 / 应用装配（`run()`）。`install.rs` 已经是一次成功的按职责拆分先例。

**边界**：如果再加一组平台原生能力，就该拆 —— 建议切法：`platform_win.rs` + `platform_mac.rs`（承接所有 `#[cfg]` 函数）、`window.rs`（`place_window` / `place_window_near` / `pin_popover_bottom`）、`lib.rs` 只留命令 + `run()`。

### E3. `tools/phone/server.mjs` 里的 `SHIM` 是模板字符串里的 ES5 代码 🟢

~190 行 JS 写在模板字符串里：没有语法高亮、没有 lint、没有类型检查、转义容易出错（`\\n`）。

**这是刻意的**（`server.mjs:2` 说明它必须被注入到 `<head>` 且同步执行，不能是独立模块请求）。**不建议改**，但如果它继续长大，考虑拆成独立文件 + 一个 `/shim.js` 路由（代价：多一次串行请求，老手机上首屏更慢 —— 这正是当初内联的原因）。

---

## 刻意保留（已评估，不改）

| 项 | 理由 |
|---|---|
| `install-hooks.mjs` 与 `install.rs` 的重复实现 | macOS GUI App 的 PATH 带不到 nvm 的 node，见 `install.rs:1-15`。靠 [hooks-node/settings-and-atomic-io.md](./hooks-node/settings-and-atomic-io.md) 的同步清单管住 |
| `focus.ps1` 与 `focus_hwnd_windows` 的重复实现 | 跨运行时，`focus.ps1:3` 有带行号的交叉引用 |
| `session_id` 清洗规则的三份实现 | 三个运行时，规则必须逐字等价；已在 spec 里成文 |
| `main.js`、`hooks/` 的引号风格不一致（双 / 单） | 各自内部一致即可，跨文件统一没有收益 |
| `win-capture.ps1` 的注释是英文 | 历史原因，改它时保持英文，别中英混排 |
| 手机端关掉 4 个常驻动画，与桌面端结论相反 | 两边的约束真的相反，`server.mjs:392` 解释了 |
