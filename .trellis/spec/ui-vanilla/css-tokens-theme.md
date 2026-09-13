# 样式：变量体系、双主题、动画纪律

`app/ui/src/styles.css` 顶部有一行来源标记，说明这份样式是按 Hallmark 设计纪律写的：

```css
/* Hallmark · scope: app-ui (HUD) · 跳过 macrostructure/nav/footer/hero
 * pre-emit critique: P5 H4 E5 S4 R5 V4 · 纪律: 命名缓动 · 锁定 token · focus-visible a11y
 */
```

那三条纪律（**命名缓动、锁定 token、focus-visible 无障碍**）就是这一层的硬规。

---

## 规则 1：颜色一律走 token，不写死

`:root` 里分了 5 组变量（`styles.css:9-57`）：

| 组 | 变量 | 用途 |
|---|---|---|
| 字体 | `--font-mono` | 等宽字体栈，**所有**文字都用它 |
| 文字层级 | `--ink` / `--ink-dim` / `--ink-faint` | 主 / 次要 / 极弱 |
| 状态色 | `--wait` `--run` `--done` `--idle` `--danger` | 与状态机的五个状态一一对应 |
| 表面色阶 | `--surf-1/2/3`、`--hair`、`--hair-2` | 卡片底 / 芯片轨槽 / 悬浮高亮 / 分隔线 / 浮层描边 |
| 结构色 | `--body-bg` `--panel-*` `--float-*` `--corner` `--scanline` `--vignette` `--hover` `--tick` `--card-base` `--card-shadow` `--wait-name` `--scrollbar` | 换肤只改这一层 |

注释里写明了这套色阶的由来：`styles.css:25`「表面色阶：收拢散落的 rgba(白)，成一套可复用刻度」、`styles.css:39`「结构色：把原先写死在各处的深色收进语义 token，换肤只改这一层」。

**加颜色的正确做法**：先看现有 token 够不够；不够就在 `:root` 加一个语义名（不是 `--gray-3` 这种色值名），**同时在 `:root[data-theme="light"]` 里给亮色版本**。少一边就等于亮色主题下会瞎。

少数允许写死的例外：状态色的渐变深端（`.u-fill.u-ok` 的 `#2f9d5c`）和辉光 `box-shadow` 的 rgba —— 它们是同一状态色的派生，改状态色时要一起改。

## 规则 2：换肤只切 `<html data-theme>`

```js
// app/ui/src/main.js:86
// 换肤：亮/暗只切 <html data-theme>，所有颜色走 CSS token 自动重算（暗色为默认，不设属性）。
// 尽早调用，避免开窗瞬间先闪一下暗底。
```

- **暗色是默认**（不设属性），亮色是 `:root[data-theme="light"]` 覆盖。
- `applyTheme()` 在模块顶层立即调用（`main.js:91`），不等 DOMContentLoaded。
- 亮色主题不是把暗色反过来，它有自己的设计语言（Apple 浅色：白卡 + 灰面板 + 投影撑层次），并且**关掉了三个暗色专属效果**：`--panel-glow`、`--scanline`、`--vignette` 全设 `transparent`（`styles.css:85-90`，注释：浅底要平整，加暗角只会显脏）。
- 亮色的状态色是「可读深版」，注释承诺 **全部 ≥4.5:1 对比度**（`styles.css:68`）。新增/调整亮色状态色时要保住这条。

## 规则 3：命名缓动，杜绝浏览器默认 ease

```css
/* styles.css:31  动效：命名缓动 + 时长，杜绝浏览器默认 ease（Hallmark 硬规） */
--ease-out: cubic-bezier(0.2, 0.7, 0.2, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--dur-1: 0.15s;   /* 微交互 */
--dur-2: 0.28s;   /* 入场 */
```

`transition` / `animation` 一律引用这些变量。少数遗留的裸 `ease` / `ease-in-out`（`@keyframes` 的 `breathe` / `alert` / `sigpulse` / `flashwait`）属于常驻呼吸动画，保持现状即可，**新写的交互动效必须用命名缓动**。

## 规则 4：常驻动画只动 `opacity`

```css
/* styles.css:293
   常驻动画只动 opacity（GPU 合成层，不触发重绘 → 不闪屏）。
   辉光用静态 box-shadow，靠整颗灯淡入淡出来呼吸。 */
.row.running .led { animation: breathe 2.6s ease-in-out infinite; }
@keyframes breathe { 50% { opacity: 0.55; } }
```

置顶透明窗口下动 `box-shadow` / `filter` / `background` 会持续闪屏。四个 `infinite` 动画（`breathe`、`alert`、`sigpulse`、`blink`）都只动 `opacity`。

**这条结论只对桌面成立**。手机端反过来（任何 `infinite` 动画都让合成器进不了空闲、持续烧电），所以 `tools/phone/server.mjs:392` 把这四个动画全关了并解释了原因。改这些动画时两边都要想到。

另外：**不用 `backdrop-filter`**（`styles.css:124` 注释：在透明置顶窗口下会持续闪屏），面板用近乎不透明的渐变代替。

## 规则 5：无障碍底线

```css
/* styles.css:201  键盘可达：即时显现的焦点环（Hallmark 硬底线，绝不动画化） */
.tb-btn:focus-visible, .menu-item:focus-visible, .ctx-item:focus-visible {
  outline: 2px solid var(--focus); outline-offset: 1px;
}
```

- 所有可点项必须进这个选择器列表（新增浮层按钮别忘）。
- 焦点环**不做过渡/动画** —— 键盘用户需要它立刻出现。
- 文件末尾的减动偏好是全局兜底，别删：

  ```css
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  ```

## 布局约定

- `#app` 是 `flex column` 撑满 `100vh`；`#cards` 是唯一 `flex: 1` 的滚动区。
- 顶栏三段：`.brand`（固定）+ `.readout`（`flex: 1 1 0; min-width: 0; overflow: hidden` —— `styles.css:181` 注释：挤不下就自己收，绝不顶掉右侧按钮）+ `.ctl`（`flex-shrink: 0`，按钮组永不被压缩）。
- `.row` 必须 `flex-shrink: 0`（高度自适应依赖真实行高，见 [render-and-polling.md](./render-and-polling.md)）。
- 文本省略统一三件套：`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`。
- 数字用 `font-variant-numeric: tabular-nums`（计时器/百分比不跳字）。
- 空内容自动隐藏用 `:empty`（`.row .branch:empty { display: none }`），不靠 JS 加 class。
- z-index 层级（别乱插）：背景氛围 `2` → 卡片/空态 `3` → 角标 `6` → 顶栏 `7` → 设置菜单 `30` → 右键菜单 `40` → 安装弹窗 `50`。
- `.hidden { display: none !important }` 是唯一的显隐 class，JS 只用 `classList.toggle("hidden", ...)`。

## 旧浏览器兼容边界（只在 tools/phone 场景相关）

桌面看板跑在 WebView2 / WKWebView 上，可以放心用现代特性。但 `tools/phone` 要跑 Chrome 75，以下特性会失效并由 `server.mjs:365 MOBILE_CSS` 补偿 —— **用它们不是错，但要知道手机端已经在补丁里兜了**：

| 特性 | 需要 | 手机端补偿 |
|---|---|---|
| `flex` 的 `gap` | Chrome 84 | 改用 `#cards > * + * { margin-top: 7px }` |
| `color-mix()`（样式表里 7 处） | Chrome 111 | `@supports not (...)` 给 `.row` 补底色 |
| `100dvh` | Chrome 108 | 全用 `height: 100%` 逐级继承 |

新增 `color-mix()` 或其他新特性时，确认手机端的 `@supports` 兜底还够用；否则补一条。
