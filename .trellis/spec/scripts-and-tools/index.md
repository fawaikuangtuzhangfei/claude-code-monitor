# 脚本与辅助工具规范

范围：PowerShell 原生脚本、`tools/phone/` 手机看板实验、`app/gen-icon.mjs` 图标生成。

| 路径 | 性质 | 规范 |
|---|---|---|
| `hooks/win-capture.ps1` | **生产**：被每次 hook 调起，抓终端窗口 HWND | [powershell.md](./powershell.md) |
| `tools/phone/focus.ps1` | 实验：手机端点卡片时聚焦窗口 | [powershell.md](./powershell.md) |
| `tools/phone/{server.mjs,build.mjs}` | **实验性辅助脚本，非正式功能** | [phone-legacy-build.md](./phone-legacy-build.md) |
| `app/gen-icon.mjs` | 一次性工具：程序化生成 app 图标 | 见下 |

---

## 实验性代码的标注义务

`tools/` 下的东西不是产品功能，但它读的是生产数据、动的是用户的窗口。所以必须在文件头把三件事写清（`tools/phone/server.mjs:1-22` 是范本）：

1. **第一行就说明它是实验性的**：`// server.mjs — 在手机浏览器里看这个项目的看板（实验性辅助脚本，非正式功能）`
2. **安全模型**，带「重要，别想当然」这类明确措辞，说清绑什么地址、谁能读、哪个接口会"动手"。
3. **已知取舍**：哪里是近似实现、和正式版差在哪、哪个平台不支持。

不许出现"看起来像正式功能"的实验代码。

## 实验代码不得污染生产代码

`tools/phone` 的核心约束是**一行都不改 `app/ui`**：

- 需要改 UI 行为 → 在 `build.mjs` 里打补丁（对源码副本操作），不改仓库文件。
- 需要改样式 → 在 `server.mjs` 的 `MOBILE_CSS` 里覆盖，不动 `styles.css`。
- 需要 Tauri 能力 → 伪造 `window.__TAURI__`，靠 `main.js` 的 `invoke` 包装天然兼容。

> 反向义务：如果发现只有靠改 `app/ui` 才能支持某个实验，那说明 UI 的接口设计有问题，应该先把 UI 改成可注入的形状（像 `invoke()` 那样），而不是在 UI 里加 `if (isPhone)` 分支。

## `app/gen-icon.mjs`

一次性生成工具：纯 Node（只用 `node:zlib` 手写 PNG）+ 2x 超采样抗锯齿 → `app-icon.png` → 再交给 `tauri icon` 切各平台。

约定：

- 参数全部是顶部常量并带注释说明（`OUT`/`SS`/`S`、调色 RGB 数组、星芒几何 `N`/`R_LONG`/`R_SHORT`/`W`/`CENTER_R`/`START`、圆角 `MARGIN`），改设计只改常量。
- 零第三方依赖 —— 不要为了画图引 canvas / sharp。
- 产物 `app-icon.png` 入库（它是设计源，不是构建产物）。
