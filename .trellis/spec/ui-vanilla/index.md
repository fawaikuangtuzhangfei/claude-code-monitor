# 看板前端（原生 JS / 原生 CSS）规范

范围：`app/ui/`。

```
app/ui/
├─ index.html        # 静态骨架：所有容器/浮层节点都在这里，JS 只填内容
└─ src/
   ├─ main.js        # 全部逻辑（~624 行，按注释分区的单文件）
   └─ styles.css     # 全部样式（~502 行，CSS 变量驱动）
```

---

## 铁律

1. **无框架、无构建、无 TypeScript、无 npm 运行时依赖。** Tauri 直接把 `app/ui` 当静态目录托管（`tauri.conf.json` 的 `frontendDist: "../ui"`），没有打包步骤。引入任何需要构建的东西都会破坏这个模型。
2. **唯一外部接口是 `window.__TAURI__`**（`withGlobalTauri: true`），且必须可选链访问、必须能在没有它的环境下降级（纯浏览器打开、手机原型）。
3. **静止时零 DOM 改动。** 每秒一次的轮询绝不能产生重排/闪屏。见 [render-and-polling.md](./render-and-polling.md)。
4. **样式全部走 CSS 变量**，颜色/间距不写死在规则里。见 [css-tokens-theme.md](./css-tokens-theme.md)。
5. **结构写在 HTML 里，不在 JS 里拼整页。** 只有卡片行（唯一的重复结构）用 `innerHTML` 模板生成。
6. **两个窗口共用这份代码**，凡是"只该发生一次"的副作用必须用 `IS_DOCK` 门控。

## 代码风格（`main.js`）

- 双引号（与 `hooks/` 的单引号不同，各自保持现状）。
- 2 空格缩进，分号结尾。
- `const` / `let`，不用 `var`。
- 用 `// ==== 区块名 ====` 分区，当前 8 个区块：状态元数据 → 设置持久化 → 通知 → 渲染 → 高度自适应 → 用量条 → 标题栏/菜单/右键 → 启动。**新功能加进对应区块，不要追加到文件末尾。**
- 短小的纯函数集中放在顶部（`elapsed`、`nameOf`、`subOf`、`sideOf`、`fmtTokens`、`pctClass`、`fmtReset`），它们只做格式化、不碰 DOM。
- 事件绑定紧跟在对应元素的 `getElementById` 之后，不集中到一个 `initEvents()`。
- 文件末尾是启动区，只有 6 行：`ensureNotifyPerm` / `tick` / `setInterval(tick, 1000)` / `tickUsage` / `setInterval(tickUsage, 30000)` / `maybePromptInstall`。

## HTML 约定（`index.html`）

- 所有浮层（设置菜单 `#menu`、右键菜单 `#ctx`、安装弹窗 `#install-overlay`）都预先写在 HTML 里，带 `hidden` class，由 JS 切 class 显隐 —— **不在 JS 里动态创建**。
- 交互项用 `data-*` 携带语义，JS 靠 `closest()` + `dataset` 分发：
  - 设置项：`<button class="menu-item" data-k="notify">` → `main.js:476` 的 `item.dataset.k`
  - 右键项：`<button class="ctx-item" data-a="focus">` → `main.js:537` 的 `switch (item.dataset.a)`
  加一个开关 = HTML 加一行 + `DEFAULTS` 加一个键，不用改分发逻辑。
- 可拖动区域标 `data-tauri-drag-region`（标题栏及其子元素）。
- 纯装饰元素标 `aria-hidden="true"`（四个 `.corner`）。
- 用 `<button>` 而不是 `<div>` 做可点项 —— 键盘可达性靠这个，配合 CSS 的 `:focus-visible` 焦点环。

## 本层的两份规范

| 文件 | 内容 |
|---|---|
| [render-and-polling.md](./render-and-polling.md) | 增量渲染、轮询节奏、`invoke` 降级、通知去重、高度自适应 |
| [css-tokens-theme.md](./css-tokens-theme.md) | CSS 变量体系、双主题、动画纪律、无障碍 |
