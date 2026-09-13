# 窗口、托盘与屏幕坐标

这一层几乎每行代码都是被平台行为逼出来的，注释密度最高。**动这里之前把对应函数的注释读完。**

---

## 双窗口模型

`tauri.conf.json` 里定义两个窗口，配置**完全相同**，只有 `label` 不同：

| label | 角色 | 显示时机 | 位置 |
|---|---|---|---|
| `dock` | 固定看板，常驻桌面 | 启动即显示（`lib.rs:891`） | 首次按主屏右上角摆放，之后由用户自己拖 |
| `popover` | 托盘浮窗，CodexBar 式 | 托盘左键开合（`lib.rs:664`） | 每次弹出都贴到离托盘图标最近的**工作区角** |

共同配置：`decorations: false`、`transparent: false`、`alwaysOnTop: true`、`skipTaskbar: true`、`shadow: false`、`visible: false`。

- `transparent: false` + CSS 里 `html, body { background: var(--body-bg) }` 是刻意的组合（`styles.css:107` 注释：避免边角闪白）。**不要改成 transparent** —— 透明置顶窗口下 `backdrop-filter` 会持续闪屏（`styles.css:124`）。
- 两个窗口跑同一份前端，前端用 label 区分职责，见 [../ui-vanilla/render-and-polling.md](../ui-vanilla/render-and-polling.md)。
- `popover` 失焦自动收起（`lib.rs:900`），并记下收起时刻供托盘点击守卫使用。

### 浮窗开合的 300ms 守卫（别删）

```rust
// lib.rs:659
/// 浮窗（popover）刚因失焦自动收起的时刻，用来挡住「点托盘那一下」引发的重复触发。
struct PopoverHidden(std::sync::Mutex<Option<std::time::Instant>>);
```

点托盘 → 浮窗失焦 → 自动 hide → 托盘点击事件到达 → 若无守卫就又弹回来。`lib.rs:672` 的 `< 300ms` 判断就是挡这个的。

托盘点击只认**左键抬起**（`lib.rs:860`：`Click` 会在按下/抬起各触发一次，只认一次），右键走系统菜单（`show_menu_on_left_click(false)`）。

---

## 屏幕坐标：三条规则

### 1. 永远不要在配置里写死坐标

```rust
// lib.rs:612
/// 之前是在 tauri.conf.json 里写死 x=1560/y=60，作者的单屏宽屏没问题，
/// 但换分辨率或多屏（尤其外接屏把坐标原点拉成负数）时，窗口会被丢到可见区
/// 之外，表现为「看板打开了但什么都看不到」。
```

运行时按 `primary_monitor()` / `monitor_from_point()` 实测尺寸算。拿不到显示器就 `w.center()` 兜底 —— **至少可见**。

### 2. 全程用同一块显示器的物理坐标

`monitor.position()` / `monitor.size()` 是物理像素，多屏下 `position` 可能是负数；`set_position(PhysicalPosition)` 也是物理坐标系。两边一致就不会跑到屏外。需要逻辑单位时显式乘 `monitor.scale_factor()`（`lib.rs:632` 的 `margin` / `top_gap`）。

### 3. 算完必须钳制

```rust
// lib.rs:638
// 钳制：万一窗口比屏还宽/高，或算出来越界，都拉回屏内
x = x.clamp(min_x, max_x.max(min_x));
y = y.clamp(min_y, max_y.max(min_y));
```

注意 `max_x.max(min_x)` —— 窗口比屏还宽时 `max_x < min_x`，`clamp` 会 panic。这个写法是必需的。

### Windows 浮窗贴边用「工作区」而不是整屏

```rust
// lib.rs:686
/// 关键：用**工作区**（rcWork，已排除任务栏）而非整块屏幕来贴边，这样面板不会压到任务栏，
/// 也永远从图标那一侧"长出来"。任务栏在哪条边都自适应（rcWork 已替我们算好）。
```

`MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST)` + `GetMonitorInfoW` → `mi.rcWork`。取不到就退回 `place_window(w)`。

### 高度自适应时浮窗要「底边不动、往上长」

```rust
// lib.rs:566
// 浮窗贴在屏角、从任务栏上方"长出来"：高度变了要保持**底边不动、往上长**，
// 否则每次卡片增减都会把窗口往下顶进任务栏。
#[cfg(windows)]
if window.label() == "popover" { pin_popover_bottom(&window, h * scale); }
```

`pin_popover_bottom` 用**刚设定的新高度**算 y，不读可能还没刷新的 `outer_size()`（`lib.rs:732`：避免钉偏一帧）。

`set_win_height` 只改高度、保持当前宽度，并且下限 80（`h.max(80.0)`）。

---

## 托盘

`TrayIconBuilder::with_id("main")`，后续用 `app.tray_by_id("main")` 取。

**状态要"上移"到托盘图标本身**，这样面板收进托盘后余光扫一眼就知道有没有会话在等你（`lib.rs:577`）。两平台手段不同：

| | Windows | macOS |
|---|---|---|
| 有人 WAIT | 换成 `icons/tray-alert.png`（红点告警） | `set_title("⏸N")` 在菜单栏显示文字 |
| 无人 WAIT | 换回 `app.default_window_icon()` | 只在跑时显示 `▶N`，其余清空 |
| 明细 | tooltip（两平台都设） | tooltip |

Windows 托盘不支持文字，所以只能换图标；图标用 `tauri::include_image!` 编译期内嵌。

托盘菜单三项固定：显示固定看板 / 隐藏固定看板 / 退出（`lib.rs:839`）。

---

## 全局快捷键与自启

- 快捷键：`CmdOrControl+Alt+C`，只在 `ShortcutState::Pressed` 时响应（否则按一次触发两回）。处理函数是 `show_window`（显示 + `unminimize` + `set_focus`），**永远能召回看板**，README 把它作为 macOS 找不到窗口时的解法写进了安装说明。
- 自启：`tauri_plugin_autostart`，macOS 用 `MacosLauncher::LaunchAgent`。首次运行默认开启，靠 `~/.claude/monitor/.autostart-init` 标记文件区分"首次"（`lib.rs:878`）—— 之后完全听用户在 ⚙ 菜单里的开关。

## setup 顺序（`lib.rs:835`）

```
1. app.manage(PopoverHidden(..))          # 必须在托盘回调注册之前
2. 建托盘菜单 + TrayIconBuilder
3. 注册全局快捷键
4. 首次运行则开启自启 + 写标记文件
5. dock：place_window() 再 show()         # 先摆位再显示，避免闪现在错误位置
6. popover：注册失焦自动收起
```

第 5 步的顺序是硬要求 —— 先 `show()` 再摆位会让窗口在旧位置闪一帧。
