# 跨平台：Windows 与 macOS

目标平台只有两个：**Windows（主力，作者日常环境）** 和 **macOS（次要，部分路径待真机实测）**。Linux 不是目标，但不要写死"非 Windows 即 macOS"的假设 —— 给出明确的"不支持"分支。

---

## 分叉方式

### Rust：编译期 `#[cfg]`

```rust
#[cfg(windows)]          // Windows
#[cfg(target_os = "macos")]  // macOS
#[cfg(not(windows))]     // 非 Windows（当前等价于 mac，但语义是"其余"）
```

规则：

1. **平台专属代码放独立函数**，函数整体打 `#[cfg]`，不要在函数体里塞一堆 `#[cfg]` 块。范本：`lib.rs:307 focus_hwnd_windows` / `lib.rs:334 focus_macos` / `lib.rs:431 window_alive_windows` / `lib.rs:263 process_alive_macos`。
2. 公共入口函数里按平台 `return`，末尾加 `#[allow(unreachable_code)] Ok(())` 兜住编译警告（见 `lib.rs:302`）。
3. `place_window_near` 有两份实现（`lib.rs:692` Windows、`lib.rs:772` `not(windows)`），**签名必须完全一致**，这样调用方无需知道平台。
4. 平台专属 crate 依赖写在 `Cargo.toml` 的 target 段里，不放主 `[dependencies]`：

   ```toml
   [target.'cfg(target_os = "macos")'.dependencies]
   libc = "0.2"
   [target.'cfg(windows)'.dependencies]
   windows = { version = "0.58", features = [...] }
   ```

   `windows` crate 的 features 按需列举（当前 5 个），**不要加 `Win32_*` 全家桶** —— 会显著拖慢编译。
5. `use` 语句放在平台函数体内部（见 `lib.rs:308-314`），而不是文件顶部，避免另一平台上的 unused import 警告。

### Node：运行期 `process.platform`

```js
// hooks/emit-status.mjs:282
if (process.platform === 'win32') { ... }
else if (process.platform === 'darwin') { ... }
```

用 `else if`（而不是 `else`）—— 第三种平台上应当什么都不做，而不是走进 macOS 分支。

---

## 同一能力的两条实现必须都说清语义差异

"剔除僵尸会话"是最典型的例子，两平台机制完全不同，注释里都交代了为什么：

| | Windows | macOS |
|---|---|---|
| 判据 | 终端窗口 `HWND` 是否还存在（`IsWindow`）**且** 当前拥有它的 pid 未变 | 承载会话的进程 `owner_pid` 是否还活着（`kill(pid, 0)`） |
| 位置 | `lib.rs:42-74` | `lib.rs:79-86` |
| 为什么不用超时 | —— | `lib.rs:78`：用进程存活而非超时，所以真在 waiting/idle 长时间挂着的会话不会被误删 |
| 特殊坑 | HWND 会被系统回收复用（`lib.rs:50`），必须加 pid 校验 | 没有窗口存活检测这种东西 |

聚焦终端同理：Windows 靠 Win32 `SetForegroundWindow` + 解前台锁；macOS 靠往 tty 写 OSC 2 标记 + AppleScript `focus`，并在 `lib.rs:336-379` 用 4 个编号步骤逐一解释为什么必须打标记→等读取→还原→BEL 兜底。

**新增跨平台能力时**：如果某平台做不到，要么明确不实现并在注释写清（`tools/phone/server.mjs:21`「聚焦终端依赖 Win32，仅 Windows 可用」），要么给出粒度更粗的降级路径并标注（`lib.rs:383`「粒度粗、选不到具体某一格，但聊胜于无」）。

**不支持要先判平台再判其他**，否则会把"不支持"误报成别的错误：

```js
// tools/phone/server.mjs:572
// 平台先判，否则非 Windows 上会把「不支持」误报成「窗口已关闭」
if (process.platform !== 'win32') {
  res.writeHead(501, ...); return res.end('聚焦终端依赖 Win32，仅 Windows 可用');
}
```

---

## 路径

- **写进 JSON / 命令行的路径统一用正斜杠**，Node 在 Windows 上也认，免去 JSON 里的反斜杠转义地狱。两份实现：

  ```js
  // install/install-hooks.mjs:35
  const emitterPathForCmd = EMITTER_DST.replace(/\\/g, '/');
  ```
  ```rust
  // app/src-tauri/src/install.rs:51
  fn slash(p: &PathBuf) -> String { p.to_string_lossy().replace('\\', "/") }
  ```

- 拼路径用 `join()` / `PathBuf::join`，不用字符串拼接。
- 脚本自身位置：Node ESM 里用 `dirname(fileURLToPath(import.meta.url))`（`emit-status.mjs:19`、`install-hooks.mjs:15`）或 `import.meta.dirname`（需 Node 20.11+，用它就要像 `tools/phone/server.mjs:34` 那样显式检测并报清楚原因）。
- UI 里展示路径时统一转正斜杠再切：`main.js:62` 的 `s.cwd.replace(/\\/g, "/").split("/")`。

## 调子进程

- 一律 `execFileSync` / `execFile` / `spawnSync` 传**参数数组**，不拼 shell 字符串。
- Windows 上必须加 `windowsHide: true`，否则每次 hook 都闪一个黑框。
- PowerShell 固定参数：`['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', <脚本>, ...]` —— `-NoProfile` 避免用户 profile 拖慢启动，`-Bypass` 避免执行策略拦下脚本。
- `npx` 在 Windows 上是 `.cmd`，Node 20 起 `spawnSync` 不再隐式用 shell 跑它，**必须显式 `shell: true`**（`tools/phone/build.mjs:60` 有注释说明）。
- GUI App **不要 shell out 调 node**：macOS 从访达/Dock 启动的 App PATH 极简，带不到 nvm 的 node。这是 `install.rs` 全程用 Rust 而不复用 `install-hooks.mjs` 的根本原因（`install.rs:10-12`）。

## 换行符与文件编码

- 仓库内一律 LF（`.gitattributes: * text=auto eol=lf`），二进制图片显式标 `binary`。
- 所有文本读写显式带 `'utf8'`。
- UI 的 `index.html` 声明 `<meta charset="UTF-8" />` 和 `lang="zh"`。

## CI 覆盖

`.github/workflows/ci.yml` 在 `windows-latest` + `macos-latest` 上各跑一次完整 `tauri build`，`fail-fast: false`（一个平台挂了另一个继续跑，好一次看清两边）。纯 Node 的状态机单测单独跑在 `ubuntu-latest` 上，秒级，排在编译前面。

**加了平台专属代码 → 确认 CI 两个平台都过**，不要只在本机 Windows 上验过就提交。
