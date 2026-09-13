# 错误处理：分级静默降级

这个项目的错误处理不是"尽量报错"，而是**按所在位置决定该不该吞**。核心判据是一句话：

> **采集端的任何失败，都不能让用户的 Claude Code 会话变慢、报错或中断。**

因为 `hooks/` 里的代码跑在用户每一次 prompt / 工具调用的关键路径上，`statusline-bridge.mjs` 更是每次状态栏刷新都要过一遍。看板少显示一张卡片是小事，卡住 `UserPromptSubmit` 是大事。

---

## 四个级别

### L0 — 必须静默吞掉（采集端 + UI 非关键路径）

**规则**：`try { ... } catch {}`，什么都不做，让功能退化而不是抛出。

```js
// hooks/emit-status.mjs:37 —— 抓不到窗口就是抓不到，返回 null，卡片退化成不可点击
function captureWindowWin() {
  try { ... } catch { return null; }
}

// hooks/emit-status.mjs:232 —— 旧状态文件坏了就当没有，重新开始
try { prev = JSON.parse(readFileSync(outFile, 'utf8')); } catch {}
```

```js
// hooks/statusline-bridge.mjs:85 —— 兜底注释直接写明取舍
} catch {
  process.exit(0); // 兜底：宁可这一帧 statusline 空，也不报错
}
```

适用：窗口/tty/pid 捕获、git 分支探测、读旧状态、localStorage、AudioContext、系统通知、剪贴板。
每个 `catch {}` 上方或行尾要有一句注释说明"降级成什么"，不要留裸的空 catch。

### L1 — 吞掉但留痕（UI 的 invoke 失败）

```js
// app/ui/src/main.js:196 —— 用户操作失败，打 console.warn，不弹窗
try { await invoke("focus_session", { sessionId: id }); }
catch (e) { console.warn("focus failed:", e); }
```

轮询类 invoke 用 `.catch(() => {})`（每秒一次，报错会刷屏 console）：`set_win_height`、`set_tray_status`、`get_autostart`。
**但**：用户主动点击触发的动作，若在某些环境根本不可用，必须给可见反馈 —— 见 `tools/phone/server.mjs:302` 对此的修正（桌面版静默 `.catch(()=>{})` 的 `focus_session`，在手机上被包成带 toast 的版本，注释写明"静默失败最难查"）。

### L2 — 必须返回错误给调用方（Tauri 命令中的用户动作）

`#[tauri::command]` 里凡是用户点了会期待结果的操作，签名用 `Result<T, String>`，错误信息写成**人能看懂的中文、并说清下一步怎么做**：

```rust
// app/src-tauri/src/lib.rs:287
return Err("这个会话还没捕获到终端窗口（需重启该会话或先提交一次任务）".into());
```

```rust
// app/src-tauri/src/install.rs:128
return Err(format!(
    "settings.json 解析失败（未做任何改动），已另存到 {}。请修好后重试：{}",
    bad.display(), e
));
```

"幂等成功"不算错误 —— 删一个已经不存在的文件要返回 `Ok`：

```rust
// app/src-tauri/src/lib.rs:494
Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
```

### L3 — 必须中止并保留证据（改用户文件之前）

唯一会让流程整体失败的场景：**要改用户的 `~/.claude/settings.json`，但读不懂它**。

```js
// install/install-hooks.mjs:56
// parse-guard：settings.json 是用户自己的文件，解析失败绝不覆盖——先把坏文件另存一份留证，
// 再中止，让用户自己修。绝不在解析失败时写回，避免把用户手写的注释/结构冲没。
```

两份实现（`install/install-hooks.mjs:57` 的 `loadSettings()` 和 `app/src-tauri/src/install.rs:117`）都必须：另存 `settings.json.unparsable-<时间戳>` → 报错 → 一个字节都不写。
另外 `install.rs:138` 还多一道 `if !settings.is_object()` 检查，同样中止。

---

## Rust 侧的写法约定

- 读盘、解析、取字段一律用 `let Ok(..) = .. else { continue/return }` 或 `.and_then(..)` 链，**不用 `unwrap()` / `expect()`**。全仓库只有两处例外，都是启动期不可恢复的：`lib.rs:845` 的 `default_window_icon().unwrap()` 和 `lib.rs:917` 的 `.expect("error while running tauri application")`。
- 窗口操作的返回值一律 `let _ = ...` 显式丢弃（`set_position` / `show` / `hide` / `set_icon` 等）—— 窗口可能已被关闭，失败无需处理，但要用 `let _ =` 表明"我知道它返回 Result"。
- 遍历目录用 `entries.flatten()` 跳过坏项，而不是 `?` 传播。
- 后台线程里的整条链（如 `lib.rs:349` 的 macOS 聚焦）失败全部忽略，因为它的目的只是"尽量帮你定位"，并且带了 BEL 兜底（`lib.rs:378`）。

## 超时是必需品，不是可选项

所有外部进程调用都要带超时，**不带超时就是 bug**（会阻塞用户的 prompt）：

| 位置 | 超时 | 理由 |
|---|---|---|
| `hooks/emit-status.mjs:30` PowerShell 窗口捕获 | 6000ms | 启动 PowerShell 本身就 ~0.5s |
| `hooks/emit-status.mjs:74` Ghostty tab 名 | 2000ms | 首次会弹 TCC 授权框把 osascript 卡住 |
| `hooks/emit-status.mjs:94/113` `ps` | 1000ms | |
| `hooks/emit-status.mjs:127` `git rev-parse` | 1500ms | |
| `hooks/statusline-bridge.mjs:77` 转调用户命令 | 5000ms | |
| `tools/phone/server.mjs:161` focus.ps1 | 8000ms | |
| `hooks/emit-status.mjs:207` 读 stdin 兜底定时器 | 3000ms | 管道不给 `end` 时不能挂死 |

`readStdin()` 的收口写法（`emit-status.mjs:195`）是范本：单次收口 + 收口后 `clearTimeout`，避免进程空转 3 秒。

## 性能也是错误处理的一部分

同步 Tauri 命令在 v2 会跑在主线程上，扫大文件足以卡死 UI。重活必须挪走：

```rust
// app/src-tauri/src/lib.rs:146
#[tauri::command]
async fn get_usage() -> Value {
    tauri::async_runtime::spawn_blocking(scan_usage)
        .await
        .unwrap_or_else(|_| serde_json::json!({ "last5h": 0, ... }))
}
```

同理，能用快路径先过滤就别 JSON 解析（`lib.rs:200` 先 `line.contains("\"usage\"")`）、能只读文件尾部就别整读（`emit-status.mjs:141` 的 `readTail`，注释里给了 28MB 全读 ~70ms vs 尾部 ~2ms 的实测对比）。
