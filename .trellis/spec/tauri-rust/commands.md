# Tauri 命令规范

当前 14 个命令，全部在 `lib.rs:819 invoke_handler(tauri::generate_handler![...])` 里注册。

---

## 分类与签名约定

| 类别 | 签名形状 | 例子 |
|---|---|---|
| 只读查询 | `fn x() -> Value` | `list_sessions`、`get_rate_limits`、`hooks_status` |
| 重只读查询 | `async fn x() -> Value` + `spawn_blocking` | `get_usage` |
| 用户动作（会失败） | `fn x(args) -> Result<(), String>` / `Result<Value, String>` | `focus_session`、`remove_session`、`open_dir`、`install_hooks` |
| 窗口自身操作 | `fn x(window: tauri::WebviewWindow, ..)` | `set_pin`、`hide_win`、`set_win_height` |
| App 级操作 | `fn x(app: tauri::AppHandle, ..)` | `get_autostart`、`set_autostart`、`set_tray_status` |

### 注入 `WebviewWindow` 而不是按 label 取窗口

固定看板（`dock`）和浮窗（`popover`）跑的是**同一份前端代码**。凡是"作用于我自己这个窗口"的命令，必须注入 `window: tauri::WebviewWindow`，Tauri 会自动给出发起调用的那个窗口：

```rust
// app/src-tauri/src/lib.rs:523
/// 置顶开关（前端 📌 按钮调用）——作用于发起调用的那个窗口自身（固定看板 / 浮窗各管各的）
#[tauri::command]
fn set_pin(window: tauri::WebviewWindow, on: bool) { let _ = window.set_always_on_top(on); }
```

**反模式**：`app.get_webview_window("dock")` 写死 label —— 会让浮窗点了按钮却操作到固定看板。只有"明确要操作固定看板"的场合才按 label 取（`show_window` / 托盘菜单的显示/隐藏，`lib.rs:651`）。

### 参数命名：前端 camelCase ↔ Rust snake_case

Tauri 自动转换。前端一律写 camelCase：

```js
invoke("focus_session", { sessionId: id })     // → fn focus_session(session_id: String)
invoke("install_hooks", { withStatusline })    // → fn install_hooks(with_statusline: bool)
invoke("set_tray_status", { nWait, nRun, nDone })
```

命令名本身是 snake_case，两边一致。

### 重活必须 `spawn_blocking`

```rust
// app/src-tauri/src/lib.rs:143
/// Tauri 命令入口：把重活（扫目录 + 读大文件 + 解析）丢到阻塞线程池，绝不占主线程。
/// 同步命令在 Tauri v2 会跑在主线程上，扫到 28MB transcript 时足以卡住 UI；故这里用
/// async + spawn_blocking 把它挪走。
#[tauri::command]
async fn get_usage() -> Value {
    tauri::async_runtime::spawn_blocking(scan_usage).await.unwrap_or_else(|_| /* 空结果 */)
}
```

模式：`async` 命令壳 + 同名 `fn scan_xxx()` 纯同步实现。判据 —— 只要可能读多个文件、或单文件可能上 MB，就得 `spawn_blocking`。

`list_sessions` 目前是同步的（只读 `~/.claude/monitor/` 下的小 JSON，每秒一次），如果将来它要扫更多东西，同样改成 `spawn_blocking`。

### 可能弹权限框/等外部程序的链路要开线程

macOS 首次 `osascript` 会弹 TCC 授权框，把整条调用卡住：

```rust
// app/src-tauri/src/lib.rs:341
// 这条链有先后依赖(打标记→等 AppleScript 读→还原)，且首次会弹 TCC 授权框把
// osascript 卡住，所以整段放进分离线程跑，命令立即返回、看板 UI 永不阻塞。
std::thread::spawn(move || { ... });
```

命令本身立刻返回 `Ok(())`，不等结果。

---

## 只读查询的失败语义

**失败等于"没有数据"，不等于错误**。查询命令返回空值让前端自己降级：

```rust
// lib.rs:13    读不到 home / 读不到目录 → 返回空 Vec，UI 显示空态
// lib.rs:245   读不到 usage-limits.json → 返回 json!({})，UI 退回 token 累加显示
// lib.rs:150   spawn_blocking 失败 → 返回 { last5h: 0, last24h: 0, updated_at: now }
```

遍历目录时逐项跳过坏数据，不整体失败：

```rust
for entry in entries.flatten() {
    if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
    let Ok(text) = fs::read_to_string(&path) else { continue };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
    if v.get("status").and_then(|x| x.as_str()).is_none() { continue; }  // 不是会话文件
    ...
}
```

最后那条 `status` 判据很关键（`lib.rs:34` 注释）：跳过 `usage-limits.json` 这类同目录非会话文件，别渲染成一张 `unknown` 空卡。

---

## 加一个新命令的清单

1. 在 `lib.rs`（或按职责新开模块，如 `install.rs`）写函数，加 `#[tauri::command]`，上方写中文文档注释说明**谁在什么时候调它**（现有注释都是这个格式，如「前端 ⏻ 按钮加载时读一次」）。
2. 加进 `lib.rs:819` 的 `generate_handler![]`。模块内的命令写成 `install::hooks_status` 形式，并在模块里加 `pub`。
3. 若用到新的 Tauri 内置能力（窗口方法、插件），在 `capabilities/default.json` 的 `permissions` 里补对应 ACL 项 —— 只补真正用到的那一条，不要加 `:default` 全家桶。
4. 前端 `main.js` 里通过 `invoke()` 调用，**必须带 `.catch()`**（见 [../ui-vanilla/render-and-polling.md](../ui-vanilla/render-and-polling.md) 的 `invoke` 约定）。
5. 如果手机原型也要用，在 `tools/phone/server.mjs` 的 `READ` 表里加映射；否则它会落到默认分支返回 `Promise.resolve(null)`（这是刻意的，见 `server.mjs:170`）。

## 全局状态

需要跨回调共享的可变状态用 newtype + `Mutex`，`setup` 里 `app.manage(...)`，读取用 `try_state`：

```rust
// lib.rs:660
struct PopoverHidden(std::sync::Mutex<Option<std::time::Instant>>);
// lib.rs:837
app.manage(PopoverHidden(std::sync::Mutex::new(None)));
// lib.rs:673
if let Some(state) = app.try_state::<PopoverHidden>() {
    if let Ok(guard) = state.0.lock() { ... }
}
```

`try_state` 而不是 `state()`（后者会 panic），`lock()` 用 `if let Ok(..)`（不 `unwrap`）。
