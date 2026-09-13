# 渲染、轮询与 IPC

---

## `invoke` 的唯一入口

```js
// app/ui/src/main.js:22
function invoke(cmd, args) {
  if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke(cmd, args);
  return Promise.reject(new Error("not in tauri"));
}
```

**所有命令调用都走这个包装，不直接摸 `window.__TAURI__`。** 好处有两个：纯浏览器打开时整页不报错（`tick()` 的 `catch` 会走 `render([])`）；`tools/phone/server.mjs` 只要伪造 `window.__TAURI__.core.invoke` 就能让整个 UI 一行不改地跑在手机上（那份垫片确实一行都没改 UI）。

**不要破坏这个契约**：不要改成 `import { invoke } from '@tauri-apps/api'`（会引入构建步骤），也不要在别处直接访问 `window.__TAURI__.core`。

其他可选能力也用可选链取，缺了自动降级：

```js
const notif = window.__TAURI__?.notification;   // main.js:96，缺了就不发系统通知
```

### 每个 `invoke` 都必须有 catch

| 场景 | 写法 |
|---|---|
| 每秒/每 30 秒的轮询 | `.catch(() => {})`（报错会刷屏 console） |
| 用户点击触发 | `try { await invoke(..) } catch (e) { console.warn("xxx failed:", e); }` |
| 乐观更新的开关 | 失败时回滚 UI（`main.js:481` 的 `set_autostart`：先 toggle，catch 里 toggle 回去） |

---

## 双窗口：`IS_DOCK` 门控

```js
// app/ui/src/main.js:27
// 这个 webview 是哪块？固定看板(dock) 与浮窗(popover) 跑的是同一份代码，用窗口 label 区分。
// 只有 dock 负责通知/提示音/托盘状态，避免两个窗口重复触发（弹两次 toast、响两声）。
function currentLabel() {
  try { return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || ""; }
  catch { return ""; }
}
const IS_DOCK = (currentLabel() || "dock") === "dock";
```

取不到 label 时**默认当 dock**（否则纯浏览器/手机上什么都不通知）。

必须用 `IS_DOCK` 门控的副作用（现有三处，新增同类副作用照办）：

1. 通知 / 提示音 / 闪烁（`main.js:166`）
2. `set_tray_status`（`main.js:318`）
3. 安装弹窗（`main.js:581`，这里直接判 `currentLabel() !== "dock"`）

窗口自身的操作（置顶、隐藏、改高度）**不要**门控 —— 它们本来就该各管各的，靠 Rust 侧注入 `WebviewWindow` 实现。

两个窗口共享 `localStorage`，靠 `storage` 事件同步设置（`main.js:496`）：一处切主题，另一处立刻跟上，无需重启。**新增设置项时确认 `storage` 事件处理里也生效了**（当前它会重读 settings + `applyTheme()` + `reflectMenu()`）。

---

## 增量渲染：静止时零 DOM 改动

这是 UI 最核心的约束。看板是个置顶透明小窗，任何多余重排都会被眼睛看见。

### 三层去重

```js
// 1. 行复用：session_id → HTMLElement 的 Map，行只创建一次
const rows = new Map();                       // main.js:17

// 2. 文本比对后再写：textContent 没变就不赋值
if (r.name.textContent !== name) r.name.textContent = name;   // main.js:210-214

// 3. 位置比对后再移动：只在位置不对时才移动节点
desired.forEach((el, i) => {
  if (cardsEl.children[i] !== el) cardsEl.insertBefore(el, cardsEl.children[i] || null);
});                                            // main.js:251
```

`createRow()`（`main.js:172`）只在首次见到某会话时调用，它用 `innerHTML` 建结构，然后把子节点引用缓存到 `el._refs`，后续更新只碰 `textContent` —— **不再有 `innerHTML` 赋值，也不再有 `querySelector`**。

行上挂两个自定义属性：`el._refs`（子节点引用）、`el._session`（当前这一帧的会话对象）。点击/右键回调读 `el._session`，**不要闭包捕获创建时的会话对象**（`main.js:192` 有注释：用行上实时挂的 `_session`，而非创建时捕获的旧对象）。

### 头部与托盘的二次去重

```js
// main.js:313  计数没变就不重绘头部、也不打扰托盘
const key = `${nWait}/${nRun}/${nDone}`;
if (key === lastHeaderKey) return;
```

`readoutEl.innerHTML` 是全量重写，所以必须有这道门 —— 否则每秒都在重建三个 `<span>`。

**新增任何每秒会被调用的渲染代码，必须自带这种"没变就不动"的门。**

---

## 轮询节奏

| 循环 | 间隔 | 取什么 | 理由 |
|---|---|---|---|
| `tick()` | 1000ms | `list_sessions` | 状态要跟手；计时器每秒走字 |
| `tickUsage()` | 30000ms | `get_rate_limits` → 缺失则 `get_usage` | `main.js:623`：用量变化慢，30s 拉一次即可，避免每秒全盘扫日志 |

用量条的**数据**每 30s 取一次缓存在 `usageState`，**倒计时每秒用缓存重算**（`main.js:334` 在 `tick()` 末尾调 `renderUsage()`），不重复取数/扫盘。这个"慢取数 + 快重绘"的分离是刻意的，别把 `fmtReset` 的重算挪回 30s 循环里。

数据源优先级（`main.js:398 tickUsage`）：

```
get_rate_limits → 有 rate_limits.five_hour/seven_day → mode "limits"（真实限额 %）
              → 否则 get_usage → 有非零值 → mode "tokens"（本地 transcript 累加）
              → 否则 null → 隐藏用量条
```

`cost`（$）刻意不显示，理由写在 `main.js:383`：`usage-limits.json` 全局一份，多开时会来回跳。

---

## 通知：去重键是 `session_id`，不是行元素

```js
// app/ui/src/main.js:18
// 已通知过的状态：session_id -> status。放模块级（不挂在行元素上）——这样某会话哪怕
// 在列表里反复进出、行被反复重建，也不会把同一个「完成/等你」重复通知。
const notifiedStatus = new Map();
```

三道门（`main.js:156 maybeNotify`），缺一条就会刷屏：

1. `prev === undefined` → **静默打底，绝不通知**。首次见到某会话时不知道它是"刚变成 done"还是"开板前就 done 了"。注释直言这是刷屏的根因。
2. `!primed` → 首帧结束前不通知（`primed` 在 `render()` 末尾置 true）。
3. `st === prev` → 状态没变不通知。
4. `!IS_DOCK` → 浮窗不重复通知。

通知的三个通道（`main.js:128 fireAlert`）：卡片描边脉冲（CSS 动画，靠 `void el.offsetWidth` 重启）+ WebAudio 提示音 + 系统 toast。三者各自受 settings 开关控制，且都在 `try/catch` 里。

WebAudio 需要用户交互解锁（WebView2 自动播放策略），`main.js:567 unlockAudio` 在首次 `pointerdown` 时 resume 并自摘监听。

---

## 窗口高度自适应

`autosize(n)`（`main.js:272`）→ `invoke("set_win_height", { height })`。

四条必守的细节：

1. **量"自然内容高度"用逐行 `offsetHeight` 累加**，不用容器高度 —— 容器受 flex 拉伸影响，量出来只会变大不会缩回去。配合 CSS 里 `.row { flex-shrink: 0 }`（`styles.css:221` 注释：永不被 flex 压扁，量到的才是真实行高）。
2. **gap 要手动加回去**：`cards += (kids.length - 1) * 7`，这个 `7` 必须与 `styles.css` 里 `#cards` 的 `gap: 7px` 一致。改 gap 要同时改这个数（已在代码注释里标明）。
3. **变化小于 2px 就不动窗口**（`main.js:285`），避免抖动。
4. **浮层撑高机制**：打开设置/右键菜单前若它会超出窗口下沿，临时撑高窗口（`forceHeightFor`），期间 `forcedHeight = true` 让每秒的 `autosize` 停手（`main.js:273`：别让每秒 tick 把撑高的窗口缩回去，导致浮层又被裁切），关闭后 `restoreHeight()` 把 `lastHeight` 归零强制重算。**两个浮层互斥**（打开一个先关另一个），否则各自撑高会打架。

---

## 渲染函数的输入约定

`render(sessions)` 会**就地修改**传入的对象（加 `s.__id`、`s.__dupId`）并 `sort()` 数组。这是刻意的（每帧都是新对象，来自 `invoke` 的 JSON），但**新增的临时字段一律用 `__` 前缀**，以区别于状态文件的真实字段。

同名会话去重（`main.js:220`）：`term_title`/项目名相同时，加 `session_id` 前 4 位后缀。

排序：先按 `STATUS_META[status].order`（waiting=0 最前），同状态按 `updated_at` 降序。未知状态权重 `9` 兜底。**加新状态要同时加进 `STATUS_META`**（`main.js:4`），它同时提供 UI 标签文字（`tag`）和排序权重。
