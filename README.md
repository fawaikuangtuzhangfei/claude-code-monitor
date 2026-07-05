# Claude 看板 (claude-code-monitor)

一个常驻屏幕、置顶悬浮的小看板，一眼看清你同时开的多个 Claude Code 会话谁在**跑着**、谁**完成了**、谁在**等你**输入 —— 这样你就能安心去浏览网页 / 干别的，需要你的时候一瞄就知道。

Windows + macOS 通用。数据来自 Claude Code 的 hooks，看板本身是个 Tauri 小窗（安装包 ~1.6MB、内存几十 MB、无边框、可拖动、可置顶、可缩到系统托盘、支持开机自启）。

```
┌─────────────────────────────┐
│ ● CLAUDE·MON  3 WAIT 2 RUN 1 DONE ▲ ▁ │
│ ● blog          WAIT  等你回答/授权    │  黄 = 在等你（排最前）
│ ● api-refactor  RUN   重构分层   2m14s │  绿 = 正在干活（带耗时）
│ ● data-clean    DONE  本轮完成      ✓  │  蓝 = 跑完了，可以去看
│ ● notes         IDLE  workspace/notes  │  灰 = 空闲
└─────────────────────────────┘
```

## 工作原理

```
Claude Code 会话 ──(hook)──> emit-status.mjs ──原子写──> ~/.claude/monitor/<session>.json
                                                                │
                                              Tauri 看板每秒读一次目录并增量渲染
```

- 每个会话一个 JSON 文件，hook 触发时更新状态：

  | Claude Code Hook | 看板状态 |
  |---|---|
  | `SessionStart` | ⚪ idle（空闲） |
  | `UserPromptSubmit` | 🟢 running（你刚下发任务） |
  | `PreToolUse` / `PostToolUse` | 🟢 running（工具在跑 / 授权后恢复） |
  | `Notification` / `PermissionRequest` | 🟡 waiting（等你输入或授权） |
  | `SubagentStop` | 🟢 running（子任务停了，主会话通常还在跑） |
  | `Stop` | 🔵 done（一轮结束） |
  | `SessionEnd` | 删除文件，看板上自然消失 |

- 完全被动、只读；不改你的会话，也不接管开窗口。
- 你现有的系统通知（Windows BurntToast / mac 通知）原样保留，看板是它的「汇总总览」。
- **点卡片 = 把对应终端窗口切到前台**（见下）。

## 点击卡片聚焦终端

卡片名默认显示**该会话所在终端窗口的实时标题**（读不到就退回项目文件夹名）。点一张卡片，会把对应终端窗口带到最前：

- **Windows**：hook 在你提交任务的瞬间用 `win-capture.ps1` 抓当前前台终端窗口的 HWND（能区分共享同一进程的多个 Windows Terminal 窗口），Rust 侧用 Win32 `SetForegroundWindow`（配合解前台锁）切到前台。
- **macOS**：hook 给终端标签写一个可识别标题，点击时用 `osascript` 激活 Ghostty 并把标题匹配的窗口 `AXRaise` 到最前。*（Mac 侧待真机实测，欢迎反馈。）*

## 安装

### 前置
- **Node.js**（发射器和安装脚本要用，v18+ 即可）
- 构建看板需要 **Rust** 和平台工具：
  - Windows：Microsoft C++ Build Tools（含 MSVC 链接器）+ WebView2（Win11 自带）
  - macOS：Xcode Command Line Tools (`xcode-select --install`)
- 前端用 [pnpm](https://pnpm.io/)（或 npm）。

> 🇨🇳 国内网络建议给 Rust 配 [rsproxy.cn](https://rsproxy.cn) 镜像，否则 crate 下载会很慢。

### 1. 装 hooks（两个平台一样）
```bash
node install/install-hooks.mjs
```
会把发射器复制到 `~/.claude/monitor-hooks/`，并把 hook 幂等地并入 `~/.claude/settings.json`（自动备份为 `settings.json.bak-monitor`，保留你已有的钩子）。
之后**新开**的 Claude Code 会话就会上报状态（已经开着的会话重启一下）。

卸载（同时清掉复制的脚本和状态文件）：
```bash
node install/install-hooks.mjs --uninstall
```

### 2. 跑看板

开发运行（改代码即时生效）：
```bash
cd app
pnpm install        # 首次
pnpm tauri dev
```

打包成可分发的应用：
```bash
cd app
pnpm tauri build
# Windows 产物: app/src-tauri/target/release/bundle/nsis/*-setup.exe
# macOS 产物:   app/src-tauri/target/release/bundle/ (.app / .dmg，需在 Mac 上打)
```

> macOS 的 `.dmg` 无法在 Windows 上交叉编译，必须在 Mac 上执行 `pnpm tauri build`。

## 使用

- **拖动**：拖标题栏移动位置。
- **▲**：切换是否置顶。
- **▁**：隐藏窗口；点系统托盘图标（或托盘菜单「显示/隐藏看板」）再唤出。
- **全局快捷键 `Ctrl/Cmd+Alt+C`**：随时召回看板。
- **点卡片**：把对应终端窗口切到前台。
- **托盘右键 → 退出**：关闭看板。
- 窗口高度会随会话数量自适应，超过屏幕才内部滚动。
- 安装后默认**开机自启**（可在系统的启动项设置里关闭）。

## 目录结构

```
claude-code-monitor/
├─ hooks/
│  ├─ emit-status.mjs        # 状态发射器（被各 hook 调用，纯 Node 无依赖）
│  └─ win-capture.ps1        # Windows 终端窗口 HWND 捕获
├─ install/install-hooks.mjs # 一键装/卸 hooks（幂等，自动备份 settings.json）
├─ app/                      # Tauri 看板
│  ├─ ui/                    # 前端（原生 JS，无框架）
│  │  ├─ index.html
│  │  └─ src/{main.js, styles.css}
│  ├─ gen-icon.mjs, app-icon.png  # 图标源（程序化生成）
│  └─ src-tauri/             # Rust：置顶透明窗口 + 读 monitor 目录 + 托盘 + 聚焦 + 自启
└─ README.md
```

## 隐私说明

状态文件写在你本机的 `~/.claude/monitor/`（仅当前用户可读），包含会话状态、终端标题、`cwd`，以及**最近一条 prompt 的前 120 字**用于卡片摘要。全部只留在本地，不上报任何服务器。若不希望持久化 prompt 摘要，可在 `hooks/emit-status.mjs` 里去掉 `last_prompt` 字段。

## License

[MIT](./LICENSE) © 2026 yechaoa
