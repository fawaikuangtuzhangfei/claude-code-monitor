# 版本号与发布

看板（GUI）和采集端（hooks）是**两个独立部署的东西**，版本必须能对上，否则用户会遇到"看板是新的、hooks 是旧的 → 限额 % 显示不出来"。整套版本握手机制就是为这个建的。

---

## 版本号在 3 个文件里（改一处必须改全）

| 文件 | 字段 | 作用 |
|---|---|---|
| `app/package.json` | `"version"` | npm 元数据 |
| `app/src-tauri/tauri.conf.json` | `"version"` | 安装包版本、系统里显示的版本 |
| `app/src-tauri/Cargo.toml` | `version` | **`install.rs` 的 `APP_VERSION` 从这里来**（`env!("CARGO_PKG_VERSION")`） |

当前三处均为 `0.3.5`。根目录 `package.json` **刻意不带版本号**（它只是 hooks 单测入口，`"description": "hooks 状态机的测试入口；看板本体在 app/"`）。

改版本号单独一个 commit：`chore: 版本号 0.3.4 → 0.3.5`。

---

## 采集端版本握手

```
app/src-tauri/src/install.rs
  APP_VERSION = env!("CARGO_PKG_VERSION")          # 编译期烙进二进制
  install_hooks() → 写 ~/.claude/monitor-hooks/.installed-version
  hooks_status()  → needs_install = 缺发射器 || 缺桥接 || .installed-version != APP_VERSION
        ↓
app/ui/src/main.js:580 maybePromptInstall()
  needs_install 为真 → 弹 #install-overlay（仅 dock 窗口弹，popover 不重复）
```

由此推出两条硬规：

1. **改了 `hooks/*.mjs` 的任何字段、命令格式或行为 → 必须 bump 版本号**。否则 `.installed-version` 仍等于 `APP_VERSION`，`needs_install` 为假，用户机器上的采集端永远不会被刷新。
2. **hook 脚本是 `include_str!` 编译进二进制的**（`install.rs:22-25`，路径 `../../../hooks/*`）。所以改 `hooks/` 下的文件必须重新编译看板才能生效 —— 不要以为改了源文件用户就能拿到。这四个内嵌文件是：`emit-status.mjs`、`status-logic.mjs`、`statusline-bridge.mjs`、`win-capture.ps1`。

> `include_str!` 的路径是相对 `install.rs` 的，往上三级到仓库根。**移动 `hooks/` 或 `src-tauri/src/` 会直接编译失败** —— 这是好事，比运行时找不到文件好。

---

## 安装/升级必须幂等

两份实现（`install/install-hooks.mjs` 和 `app/src-tauri/src/install.rs`）都采用**先删后加**策略：

```js
// install/install-hooks.mjs:128
// 「先删后加」：把该事件里我们之前装的钩子（按 MARK 识别）全部删掉，再补一条最新的。
// 这样重装即幂等升级——命令格式变了也能把旧条目刷成最新，绝不重复堆叠；用户自己的其它
// 钩子（不含 MARK）原样保留。
```

识别标记（改这两个常量等于放弃所有老版本的清理能力，别动）：

- `MARK = 'emit-status.mjs'` —— 识别"是我们装的采集钩子"
- `BRIDGE_MARK = 'statusline-bridge.mjs'` —— 识别"statusLine 已被桥接包住"

`statusLine` 包裹要能还原：首次包裹时把用户原命令原样存进 `monitor-hooks/wrapped-statusline.json`，卸载时据此还原（原来没有就 `delete`）。已包裹时只刷新路径、**不覆盖已存的原命令**（`install-hooks.mjs:83`、`install.rs:172`）。

---

## 发布流程

1. 改完代码，`node --test hooks/` 通过。
2. 三处版本号同步 bump，单独 commit。
3. CI（`.github/workflows/ci.yml`）在 Windows + macOS 上跑完整 `tauri build`。
4. `.github/workflows/release.yml` 出 Releases 产物。
5. macOS 的 `.dmg` 无法交叉编译，必须在 Mac 上 `pnpm tauri build`。
6. 产物：Windows `app/src-tauri/target/release/bundle/nsis/*-setup.exe`；macOS `bundle/` 下 `.app` / `.dmg`。

### README 里已承诺的用户升级路径（别破坏）

- 看板：下新安装包覆盖安装，**应用标识 `com.claudemon.app` 不变**，原地升级保留设置。改 identifier 等于让所有用户变成全新安装。
- 采集端：看板启动自动探测、弹窗一键更新，不需要用户装 Node、不需要跑脚本。
- 手动路径仍须可用：`node install/install-hooks.mjs`（幂等、自动备份）。**两条路径的效果必须一致** —— 所以 `install.rs` 和 `install-hooks.mjs` 的 `MAP` 表、标记常量、包裹逻辑必须同步修改。

### 用户设置的兼容性

- `~/.claude/monitor/.autostart-init` 标记文件（`lib.rs:878`）：仅首次运行默认开启自启，之后尊重用户开关。**不要删除或改名这个标记**，否则每次升级都会把用户手动关掉的自启重新打开。
- 状态文件里的旧字段缺失要能兼容：`lib.rs:54` 明确注释「旧状态文件没有 `win_pid` 时跳过此校验，保持兼容」。新增字段一律按"可能不存在"处理。
- `localStorage` 键 `cm.settings`（`main.js:77`）：新增设置项加到 `DEFAULTS` 里，靠 `{ ...DEFAULTS, ...JSON.parse(...) }` 自动兼容老数据。**不要改这个键名。**
