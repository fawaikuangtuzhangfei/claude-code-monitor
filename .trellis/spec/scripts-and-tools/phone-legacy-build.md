# tools/phone：旧浏览器降级与局域网服务

把旧手机当常驻看板显示屏。目标环境是**金立 Android 5.1 上能装到的 Chrome 75** —— 这个数字决定了这里几乎所有的写法。

```
tools/phone/
├─ server.mjs        # 零依赖 Node HTTP：托管 app/ui + 伪造 window.__TAURI__ + REST
├─ build.mjs         # 给 main.js 打补丁 → esbuild 降到 ES2015 + IIFE
├─ focus.ps1         # 聚焦窗口（见 powershell.md）
├─ main.legacy.js    # build.mjs 产物，.gitignore
├─ token.txt         # 首次运行随机生成，.gitignore
└─ README.md
```

---

## 核心约束：一行都不改 `app/ui`

三条通道，按「改什么」选：

| 要改的东西 | 通道 | 位置 |
|---|---|---|
| JS 行为 | `build.mjs` 的 `PATCHES` 数组（字符串替换源码**副本**） | `build.mjs:27` |
| 样式 | `server.mjs` 的 `MOBILE_CSS`（注入到 `</head>` 前） | `server.mjs:365` |
| Tauri 能力 | `server.mjs` 的 `SHIM`（伪造 `window.__TAURI__.core.invoke`） | `server.mjs:173` |

注释直接写明了为什么能做到：

```js
// server.mjs:4
// 再伪造一个 window.__TAURI__ 把 UI 的 invoke() 接到 REST 上——
// 因为 app/ui/src/main.js 的 invoke 只认 window.__TAURI__?.core?.invoke，
// 把它喂饱，UI 就一行都不用改（也确实一行都没改）。
```

---

## 补丁必须命中，否则构建失败

```js
// build.mjs:8
// 补丁若匹配不上会直接报错退出——仓库 UI 改动后宁可构建失败，
// 也不要悄悄产出一个「看起来正常但补丁没生效」的版本。
for (const p of PATCHES) {
  if (!src.includes(p.from)) { console.error(`✗ 补丁失配，仓库 UI 可能改了：...`); process.exit(1); }
  ...
}
```

每条补丁三个字段：`why`（为什么要打，写到原理层）、`from`（原始片段）、`to`（替换成什么）。**`why` 不是可选的** —— 当前两条补丁的 `why` 都解释到了"WiFi 芯片占空比"和"浏览器后台节流只拉长不停表"这个层面。

改了 `app/ui/src/main.js` 里 `setInterval(tick, 1000)` 或 `setInterval(tickUsage, 30000)` 这两行 → `node build.mjs` 会立刻失败并告诉你哪条补丁失配。这是设计好的早失败，不要为了"让构建过"改宽匹配（比如改成正则模糊匹配）。

## 手机端的三类特殊要求

### 1. 省电优先于精确

| 手段 | 效果 | 位置 |
|---|---|---|
| 轮询 1s → 6s | 秒表变 6 秒一跳，但读数仍由前端按 `running_since` 算，不会错 | `build.mjs:24` |
| 可见性门控 | `document.hidden` 时彻底停表；回前台立刻补一次，不等下一周期 | `build.mjs:33` |
| 关掉 4 个常驻动画 | 合成器能进空闲，GPU 和 CPU 核不被持续唤醒 | `server.mjs:392` |
| ETag / 304 | 省传输 + JSON.parse + 一次全量 render → 射频高功耗窗口更短 | `server.mjs:467` |

第 3 条注释里明确指出桌面端的结论在手机上是反过来的（见 [../ui-vanilla/css-tokens-theme.md](../ui-vanilla/css-tokens-theme.md) 的规则 4）。

### 2. ETag 必须配 `no-store`，且条件请求完全由垫片掌控

```js
// server.mjs:462
// 这里的 ETag 是「应用级」的，不走浏览器 HTTP 缓存——所以仍然发 no-store。
// 别改成 no-cache：那样浏览器会自己存一份，并在下次请求时**追加**它自己的
// If-None-Match；XHR 的 setRequestHeader 是逗号拼接语义，两个值拼在一起
// 就永远等不上服务端算出来的那个，304 一次都不会命中，白折腾。
```

垫片侧自己存 `etags[path]` + `cachedBody[path]`（`server.mjs:226`），并处理"说好没变、本地却没缓存"的不该发生分支 —— 清掉 etag 让下次无条件重取，而不是留个永远命中 304、页面永远空的死循环。

### 3. 垫片本身必须能在最旧的浏览器上跑

```js
// server.mjs:220
// 用 XHR 不用 fetch：这段垫片必须能在最旧的浏览器上跑起来，
// 否则连"为什么跑不起来"都上报不出去（第一次就栽在这——垫片用了 async/await，
// 旧浏览器解析阶段就挂了，页面只剩静态 HTML，看着就是"空页面"）。
```

`SHIM` 是写在模板字符串里的 ES5 代码（没有 lint、没有类型检查），所以：

- **只用 ES5**：`var`、`function`、`XMLHttpRequest`、`new Date().getTime()`（不用 `Date.now()` 也无妨但保持一致）、字符串拼接（不用模板字符串 —— 它本身就在模板字符串里）。
- 转义要小心：`SHIM` 里的 `\\n` 是给内层字符串的换行。
- 垫片是**普通 `<script>`（同步执行）**，必须排在 `type="module"` 的 `main.js` 之前；放 `<head>` 就稳（module 是 defer 语义）。
- 垫片的 `invoke` 实现**绝不 reject 未实现的命令**，一律 `Promise.resolve(null)`（`server.mjs:170`：UI 里不少地方没 catch，抛了会中断渲染）。

## 手机上没有 devtools → 错误必须双向上报

`SHIM` 的 `report()` 同时做两件事：画一个全屏红色 `<pre id="__err">` 到页面上，**并** POST 到 `/api/log` 打到服务端控制台（`server.mjs:176`）。

三个探针，缺一个就会出现"查不出为什么白屏"：

1. `post('hello', 'shim 已执行')` —— 立刻报 UA，哪怕后面全挂也知道是什么浏览器。
2. `window.addEventListener('error' / 'unhandledrejection')`。
3. **存活信标**（`server.mjs:208`）：load 后 1.5s 报 `rows=N readout="..." tauri=<type>`，用来区分「模块没执行」和「模块执行了但渲染不出来」。

服务端打印前一律过 `safeLine()`，见 [../conventions/security-boundaries.md](../conventions/security-boundaries.md) 规则 3。

## 断线要明确，静默失败是陷阱

```js
// server.mjs:254
// main.js 的 tick() 拉数失败时会走 render([])，页面显示「无运行中的会话」——
// 于是「服务挂了 / WiFi 断了 / 电脑休眠了」和「一切正常、没会话在跑」长得一模一样。
// 对「回家瞄一眼」的用法这是个陷阱：扫一眼以为没事，其实根本没连上。
```

所以垫片加了断线横幅（连错 2 次才报，避免一次抖动就闪红条）并盖掉那句会误导人的空态文案；聚焦操作加了 toast（成功/失败都说话）。

**通用原则**：只读看板类的 UI，"没数据"和"连不上"必须视觉可区分。

## 启动提示必须说破前置条件

```js
// server.mjs:640
// 没跑过 build.mjs 时，旧安卓浏览器会白屏且毫无线索——在这里就说破，
// 别让人对着「只有标题和齿轮」的页面去查后端。
if (!USE_LEGACY) { console.log('  ⚠ 未加载 main.legacy.js ... 先跑一次：node build.mjs'); }
```

启动横幅还打印：本机地址、每个网卡 IP 的带令牌地址、状态文件过滤统计（总数 → 显示数 → 三类剔除原因）。`/api/debug` 提供同样的统计供随时自查。

## 环境变量

全部带默认值、全部在注释里说明取值理由：`PORT`（7788）、`UI_DIR`、`MAX_AGE_H`（24）、`POLL_MS`（6000，build 时）、`LEGACY`（设 `0` 可强制用原版 `main.js`）。
