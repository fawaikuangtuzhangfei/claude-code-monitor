# Claude 看板 (claude-code-monitor)

一个常驻屏幕、置顶悬浮的小看板，一眼看清你同时开的多个 Claude Code 会话谁在**跑着**、谁**完成了**、谁在**等你**输入 —— 这样你就能安心去浏览网页 / 干别的，需要你的时候一瞄就知道。

Windows + macOS 通用。数据来自 Claude Code 的 hooks，看板本身是个 Tauri 小窗（安装包 ~1.6MB、内存几十 MB、无边框、可拖动、可置顶、可缩到系统托盘、支持开机自启）。

```
┌───────────────────────────────────┐
│ ● CLAUDE·MON  3 WAIT 2 RUN 1 DONE ⚙ ▲ ▁ │
│ ● blog        WAIT ⑂main  等你回答/授权 8s │  黄 = 在等你（排最前，带已等待时长）
│ ● api-refactor RUN ⑂dev   重构分层   2m14s │  绿 = 正在干活（带耗时）
│ ● data-clean  DONE        本轮完成       ✓ │  蓝 = 跑完了，可以去看
│ ● notes       IDLE        workspace/notes  │  灰 = 空闲
└───────────────────────────────────┘
```

## 亮点

- 🔔 **状态变化提醒**：某会话切到「等你」或「完成」时，系统通知 + 提示音 + 卡片描边闪烁 —— 你可以彻底不盯着面板，被叫时才回头。
- ⑂ **会话身份**：卡片显示终端标题 / 项目名、**git 分支**、运行耗时、**已等待时长**，多开也分得清谁是谁。
- 🎯 **需输入时自动切窗**（可选）：某会话等你输入时，自动把它的终端拉到前台。
- 🖱 **卡片右键菜单**：切到终端 / 打开项目目录 / 复制会话 ID / 移除卡片。
- 🪟 **迷你模式**：折叠成一条，只留 `WAIT/RUN/DONE` 计数 + 呼吸信号灯，占地极小。
- ⚙ 以上开关都在标题栏 **设置菜单**里，一键切换、本地记忆。

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
  | `PreToolUse` / `PostToolUse` / `SubagentStop` | 保活：仅当在等待中才清成 🟢 running，否则不改状态 |
  | `PermissionRequest` | 🟡 waiting（等你授权） |
  | `Notification` | 运行中才算 🟡 waiting（真的需要输入）；一轮结束后的空闲提醒会被忽略，保持 🔵 done |
  | `Stop` | 🔵 done（一轮结束） |
  | `SessionEnd` | 删除文件，看板上自然消失 |

- 状态判定对并发写做了兜底：保活事件不与 `Stop` 抢写（避免 done 被冲回 running），空闲提醒不会把 done 误翻成 waiting。
- **僵尸清理**：直接关掉终端窗口（不触发 `SessionEnd`）时，Windows 下看板会检测到该终端窗口已不存在，自动移除对应卡片，不残留假状态。
- 完全被动、只读；不改你的会话，也不接管开窗口。
- 你现有的系统通知（Windows BurntToast / mac 通知）原样保留，看板是它的「汇总总览」。
- **点卡片 = 把对应终端窗口切到前台**（见下）。

## 点击卡片聚焦终端

卡片名默认显示**该会话所在终端窗口的实时标题**（读不到就退回项目文件夹名）。点一张卡片，会把对应终端窗口带到最前：

- **Windows**：hook 在你提交任务的瞬间用 `win-capture.ps1` 抓当前前台终端窗口的 HWND（能区分共享同一进程的多个 Windows Terminal 窗口），Rust 侧用 Win32 `SetForegroundWindow`（配合解前台锁）切到前台。
- **macOS**：hook 给终端标签写一个可识别标题，点击时用 `osascript` 激活 Ghostty 并把标题匹配的窗口 `AXRaise` 到最前。*（Mac 侧待真机实测，欢迎反馈。）*

## 安装

> ### ⚠️ macOS 首次打开：先过 Gatekeeper（否则「双击没反应 / 看板打不开」）
>
> Releases 里的 `.dmg` 是 **adhoc 签名、未做 Apple 公证**的。macOS 的 Gatekeeper 会拦下未公证应用，表现常常是**双击图标什么都不发生**（进程根本没起来），看板自然出不来。两种解法任选其一：
>
> **① 图形界面（最省事）**：在「访达」里找到 `Claude Monitor.app`（在「应用程序」里），**右键 → 打开**，弹窗里再点「打开」。只需这一次，之后双击 / 开机自启都正常。
>
> **② 命令行（一劳永逸）**：
> ```bash
> xattr -rd com.apple.quarantine "/Applications/Claude Monitor.app"   # 去掉下载隔离标记
> codesign --force --deep --sign - "/Applications/Claude Monitor.app" # 打一个本机签名让系统放行
> ```
>
> 如果打开后**看板进程在跑、但屏幕上找不到窗口**：按全局快捷键 **`Cmd+Alt+C`** 召回；窗口会按你当前主屏尺寸摆到右上角（v0.2.4 起已修复多屏/异分辨率下窗口跑到屏幕外的问题）。

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

## 更新 / 升级

看板（GUI）和 hooks（状态采集）是两个独立部分，升级时**都要更新**：

1. **升级看板**：从 [Releases](https://github.com/fawaikuangtuzhangfei/claude-code-monitor/releases/latest) 下最新安装包。
   - 先在系统托盘右键 → **退出**（否则安装时旧 exe 被占用会报错）。
   - Windows 双击 `*-setup.exe` 覆盖安装；macOS 打开 `.dmg` 覆盖 —— 应用标识不变，原地升级、保留你的设置。
2. **升级 hooks**：拉最新代码后**重跑一次**，把新版发射器复制进 `~/.claude/monitor-hooks/`：
   ```bash
   node install/install-hooks.mjs
   ```
   > hook 里的新字段（如 git 分支、已等待时长）靠更新后的发射器产出，光换看板不换 hooks 是不生效的。
   > 脚本幂等：已存在的 hook 会跳过，`settings.json` 自动备份。**重启正在跑的 Claude 会话**后新字段才上报。

## 使用

- **拖动**：拖标题栏移动位置。
- **⚙ 设置菜单**：状态通知、提示音、需输入时自动切窗、迷你模式、开机自启 —— 逐项开关，本地记忆。
- **▲**：切换是否置顶。
- **▁**：隐藏窗口；点系统托盘图标（或托盘菜单「显示/隐藏看板」）再唤出。
- **全局快捷键 `Ctrl/Cmd+Alt+C`**：随时召回看板。
- **点卡片**：把对应终端窗口切到前台。**右键卡片**：切窗 / 打开项目目录 / 复制会话 ID / 移除卡片。
- **托盘右键 → 退出**：关闭看板。
- 窗口高度会随会话数量自适应，超过屏幕才内部滚动。
- 首次安装默认**开机自启**，之后完全听 ⚙ 菜单里的开关（也可在系统启动项里关）。

## 目录结构

```
claude-code-monitor/
├─ hooks/
│  ├─ emit-status.mjs        # 状态发射器（被各 hook 调用，纯 Node 无依赖）
│  ├─ status-logic.mjs       # 状态机决策核心（纯函数，无 I/O；发射器 import 它）
│  ├─ status-logic.test.mjs  # 状态转移单测（node --test / npm test）
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

状态文件写在你本机的 `~/.claude/monitor/`（仅当前用户可读），包含会话状态、终端标题、`cwd`、git 分支，以及**最近一条 prompt 的前 120 字**用于卡片摘要。全部只留在本地，不上报任何服务器。若不希望持久化 prompt 摘要，可在 `hooks/emit-status.mjs` 里去掉 `last_prompt` 字段。

## License

[MIT](./LICENSE) © 2026 yechaoa
