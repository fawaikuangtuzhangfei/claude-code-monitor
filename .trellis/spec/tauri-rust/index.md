# 看板后端（Rust / Tauri v2）规范

范围：`app/src-tauri/`。

| 文件 | 职责 | 行数 |
|---|---|---|
| `src/main.rs` | 入口，只调 `claude_monitor_lib::run()` | 极短 |
| `src/lib.rs` | 全部 Tauri 命令 + 窗口/托盘/屏幕定位 + 平台原生调用 | ~918 |
| `src/install.rs` | 采集端安装/升级（`hooks_status` / `install_hooks`） | ~222 |
| `Cargo.toml` | 依赖（刻意极少）+ release profile | |
| `tauri.conf.json` | 两个窗口、CSP、打包目标 | |
| `capabilities/default.json` | 最小权限集 | |

---

## 铁律

1. **依赖保持极少。** 当前只有 `tauri`（+3 个官方插件）、`serde`、`serde_json`、`dirs`，平台侧 `libc` / `windows`。加依赖前先问能不能用 std 写完（`iso8601_to_ms` 手写 days-from-civil 就是为了不引 `chrono`，见 `lib.rs:103`）。
2. **不用 `unwrap()` / `expect()`**（启动期两处例外见 [../conventions/error-handling.md](../conventions/error-handling.md)）。
3. **同步命令不做重活** —— Tauri v2 的同步命令跑在主线程，会卡住 UI。见 [commands.md](./commands.md)。
4. **平台专属逻辑用 `#[cfg]` 拆成独立函数**，见 [../conventions/cross-platform.md](../conventions/cross-platform.md)。
5. **窗口操作永远可能失败**（窗口已被关闭），一律 `let _ = ...`。
6. **不信任状态文件的任何字段**：可能缺、可能是旧版本写的，全用 `.and_then(...).unwrap_or(...)`。

## 代码风格

- `rustfmt` 默认（4 空格），edition 2021。
- 每个 `fn` 上方 `///` 或 `//` 中文说明：**职责一句话 + 为什么这么写**。
- 早退用 let-else：`let Some(home) = dirs::home_dir() else { return out; };`
- 平台专属 `use` 写在函数体内，不在文件顶部。
- 构造 JSON 返回值用 `serde_json::json!` 宏，字段名 snake_case（与状态文件契约一致）。
- 返回类型：只读查询返回 `Value`（失败给空对象/空数组）；用户动作返回 `Result<(), String>` 或 `Result<Value, String>`。

## release profile（不要改宽）

```toml
[profile.release]
opt-level = "s"   # 体积优先：README 承诺「安装包 ~1.6MB」
lto = true
strip = true
```

安装包体积是这个项目对外的卖点之一，改这三项前先量一下产物大小。

## 本层的两份规范

| 文件 | 内容 |
|---|---|
| [commands.md](./commands.md) | `#[tauri::command]` 的签名/注册/性能约定 |
| [windows-tray-screen.md](./windows-tray-screen.md) | 双窗口模型、托盘、屏幕坐标与多屏钳制 |
