# claude-code-monitor 编码规范总索引

> 本目录记录的是**这个仓库实际在用的**约定，不是理想状态。
> 写代码前先读对应层的 index，改跨层字段时必须读 [hooks-node/status-contract.md](./hooks-node/status-contract.md)。

---

## 这是什么项目

一个常驻桌面的悬浮看板，展示同时开着的多个 Claude Code 会话谁在跑 / 谁完成 / 谁在等你。

数据链路（**单向、只读、无服务端**）：

```
Claude Code 会话
  └─(9 个 hook 事件)→ hooks/emit-status.mjs
        └─原子写→ ~/.claude/monitor/<session_id>.json
              └─每秒读一次→ app/src-tauri (Rust)
                    └─invoke→ app/ui (原生 JS 渲染)

Claude Code statusline
  └─包一层→ hooks/statusline-bridge.mjs
        └─原子写→ ~/.claude/monitor/usage-limits.json  (限额 % 的唯一来源)
```

`~/.claude/monitor/*.json` 是**唯一的跨进程契约**。改它的字段就是改 4 个实现的契约（发射器、Rust、UI、手机原型服务端）。

---

## 技术栈与分层地图

| 层 | 路径 | 技术 | 依赖约束 | 规范 |
|---|---|---|---|---|
| 采集端（hook） | `hooks/` | Node ≥18 ESM `.mjs` | **零第三方依赖**（要被复制到用户机器上跑） | [hooks-node/](./hooks-node/index.md) |
| 安装器 | `install/` | Node ESM | 零依赖 | [hooks-node/](./hooks-node/index.md) |
| 看板后端 | `app/src-tauri/src/` | Rust 2021 + Tauri v2 | 依赖极少，见 `Cargo.toml` | [tauri-rust/](./tauri-rust/index.md) |
| 看板前端 | `app/ui/` | **原生 JS + 原生 CSS，无框架、无构建、无 TypeScript** | 只依赖 `window.__TAURI__` | [ui-vanilla/](./ui-vanilla/index.md) |
| Windows 原生脚本 | `hooks/win-capture.ps1`、`tools/phone/focus.ps1` | PowerShell + 内联 C# P/Invoke | 只用系统自带 | [scripts-and-tools/powershell.md](./scripts-and-tools/powershell.md) |
| 手机看板（实验） | `tools/phone/` | 零依赖 Node HTTP + esbuild 降级 | 明确标注「实验性辅助脚本」 | [scripts-and-tools/phone-legacy-build.md](./scripts-and-tools/phone-legacy-build.md) |

**不存在的东西，别引入**：React / Vue、TypeScript、打包器（`app/ui` 由 Tauri 直接当静态目录托管，见 `tauri.conf.json` 的 `frontendDist: "../ui"`）、CSS 预处理器、ESLint / Prettier 配置、运行时第三方 npm 包。
唯一的 devDependency 是 `@tauri-apps/cli`；`tools/phone` 通过 `npx --yes esbuild` 临时拉 esbuild，不写进任何 `package.json`。

---

## 该读哪一份

| 你要做的事 | 必读 |
|---|---|
| 改状态判定 / 加 hook 事件 | [hooks-node/status-contract.md](./hooks-node/status-contract.md) + [hooks-node/pure-logic-and-tests.md](./hooks-node/pure-logic-and-tests.md) |
| 往状态 JSON 加字段 | [hooks-node/status-contract.md](./hooks-node/status-contract.md)（4 处联动清单） |
| 改 `~/.claude/settings.json` 的安装逻辑 | [hooks-node/settings-and-atomic-io.md](./hooks-node/settings-and-atomic-io.md)（Node 与 Rust 两份实现必须同改） |
| 加 Tauri 命令 | [tauri-rust/commands.md](./tauri-rust/commands.md) |
| 动窗口 / 托盘 / 屏幕坐标 | [tauri-rust/windows-tray-screen.md](./tauri-rust/windows-tray-screen.md) |
| 改 UI 渲染 / 轮询 | [ui-vanilla/render-and-polling.md](./ui-vanilla/render-and-polling.md) |
| 改样式 / 加颜色 | [ui-vanilla/css-tokens-theme.md](./ui-vanilla/css-tokens-theme.md) |
| 写 / 改 PowerShell | [scripts-and-tools/powershell.md](./scripts-and-tools/powershell.md) |
| 动 `tools/phone` | [scripts-and-tools/phone-legacy-build.md](./scripts-and-tools/phone-legacy-build.md) |
| 发版 / 改版本号 | [conventions/versioning-release.md](./conventions/versioning-release.md) |
| 任何代码 | [conventions/](./conventions/index.md) 全部 5 份都是通用硬规 |

---

## 十条硬规（违反任何一条都算缺陷）

1. **注释写"为什么"，不写"是什么"**。凡是"看起来多余/绕弯"的代码必须留下它为何非这么写的理由。见 [conventions/comment-and-doc.md](./conventions/comment-and-doc.md)。
2. **绝不因为采集端出错而影响用户的 Claude Code 会话**。hook 与 statusline 桥接全程 `try/catch` 兜底，失败就静默降级。见 [conventions/error-handling.md](./conventions/error-handling.md)。
3. **`~/.claude/settings.json` 是用户的文件**：解析失败绝不覆盖，改动前先备份，只动带自身标记的条目。
4. **所有落盘都是原子写**（临时文件 + `rename`），文件名带 `process.pid` 防并发撞名。
5. **一切进入文件路径的 id 必须先清洗**（只留 `[A-Za-z0-9_-]`，截断 128）。Node 侧和 Rust 侧规则必须逐字一致。
6. **平台分叉用编译期/运行期显式判断**，不做"碰巧能跑"的隐式兼容；非目标平台要给明确的失败原因，而不是伪装成别的错误。
7. **`hooks/` 和 `app/ui/` 零依赖**。加依赖前先问：能不能用 Node 内置模块 / 原生 DOM 写完。
8. **纯决策逻辑与 I/O 分离**，纯的那部分必须有 `node:test` 单测覆盖（`hooks/status-logic.mjs` 是范本）。
9. **每个回归过的 bug 都要在单测里留一条用例**，测试名写清它防的是什么现象（如"done 之后来的保活事件不会把 done 冲回 running"）。
10. **改版本号要同时改 3 个文件**，且采集端与看板版本必须能对上。见 [conventions/versioning-release.md](./conventions/versioning-release.md)。

---

## 语言与格式

- **代码注释、文档、UI 文案、commit message、测试名一律中文**；标识符、日志 key、JSON 字段名用英文 snake_case（状态文件）/ camelCase（invoke 参数）。
- `hooks/win-capture.ps1` 的注释是英文（历史原因，改它时保持英文，不要中英混排）。
- 换行符统一 LF，由 `.gitattributes` 的 `* text=auto eol=lf` 强制。
- 缩进：JS / JSON / CSS 2 空格，Rust 4 空格（`rustfmt` 默认），PowerShell 2 空格。
- JS 用单引号（`hooks/`、`install/`、`tools/`）；`app/ui/src/main.js` 用双引号 —— 各自保持现状，别跨文件统一。

---

## 现存问题

[code-smells.md](./code-smells.md) 列了本次规范化时扫出的、与上述规范冲突的具体位置。它是待办清单，不是规范本身。
