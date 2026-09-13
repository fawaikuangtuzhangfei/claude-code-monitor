# PowerShell 脚本规范

两个脚本：`hooks/win-capture.ps1`（生产，每次 hook 调起）、`tools/phone/focus.ps1`（实验）。都是"用 PowerShell 当 Win32 P/Invoke 的壳"。

---

## 调用约定

从 Node 侧固定这样调（`emit-status.mjs:29`、`server.mjs:159`）：

```js
execFileSync('powershell', [
  '-NoProfile',            // 别加载用户 profile（否则启动慢好几倍）
  '-ExecutionPolicy', 'Bypass',   // 否则执行策略会直接拦下脚本
  '-File', <脚本绝对路径>,
  '-StartPid', String(process.pid),
], { encoding: 'utf8', windowsHide: true, timeout: 6000 });
```

四项都是必需的：`-NoProfile`、`-ExecutionPolicy Bypass`、`windowsHide: true`、**超时**。

## 脚本侧约定

### 1. 参数用 `param()` 强类型

```powershell
param([int]$StartPid)                                        # win-capture.ps1:14
param([Parameter(Mandatory = $true)][int64]$Hwnd)            # focus.ps1:11
```

HWND 用 `[int64]`（64 位系统上句柄超 int32 范围），pid 用 `[int]`/`[uint32]`。

### 2. 输出是**给程序读的**，格式必须窄且稳定

| 脚本 | 输出 | 失败时 |
|---|---|---|
| `win-capture.ps1` | `"<hwnd> <owningPid>"`，两个十进制数 | `"0 0"` |
| `focus.ps1` | `OK` | `NOWINDOW` + `exit 1` |

解析侧配合（`emit-status.mjs:32`）：`String(out).trim().split(/\s+/)` → `parseInt` → `Number.isFinite` 校验。

**不要往 stdout 打调试信息**。所有 cmdlet 的返回值用 `| Out-Null` 或 `[void]` 吃掉：

```powershell
[void][Fg]::ShowWindow($h, 9)
[WinCap]::GetWindowThreadProcessId($th, [ref]$tp) | Out-Null
```

### 3. Win32 调用用内联 C# `Add-Type`

```powershell
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  ...
}
'@
```

- 类名短且唯一（`WinCap` / `Fg`）。
- here-string 用 `@'...'@`（单引号，不做变量插值）优于 `@"..."@` —— `win-capture.ps1` 用的是单引号版本，`focus.ps1` 用了双引号版但里面没有 `$`，新脚本一律用单引号版。
- `focus.ps1` 加了 `-ErrorAction SilentlyContinue | Out-Null`，因为同一进程内重复 `Add-Type` 同名类会报错。
- 需要回调的 API（`EnumWindows`）在 C# 里声明 `delegate`，在 PowerShell 里传 lambda（`win-capture.ps1:35`）。
- 常量写魔数 + 行内注释，别引 `System.Windows.Forms` 之类的大程序集：

  ```powershell
  if ([Fg]::IsIconic($h)) { [void][Fg]::ShowWindow($h, 9) }   # 最小化了先还原（SW_RESTORE = 9）
  [Fg]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)              # VK_MENU = 0x12, KEYEVENTF_KEYUP = 2
  ```

### 4. 多策略降级要在文件头列成编号清单

`win-capture.ps1:2-13` 是范本 —— 文件头用 `Strategy (first match wins)` 列出 0/1/2 三级，正文用 `# --- 0) ... ---` 对应分段。三级是：

```
0) CLAUDEMON_TAG 环境变量给的固定窗口标题 → 按标题精确匹配
1) 前台窗口（若属于已知终端进程）
2) 沿父进程链向上找拥有可见顶层窗口的祖先（或其 conhost 子进程）
```

为什么 0) 优先级最高，注释解释得很清楚（也是这个脚本存在的核心难点）：

```
This is the ONLY reliable way to tell apart multiple Windows Terminal windows:
they all share ONE process, so pid and foreground can't.
```

已知终端进程名白名单在 `$termNames`（`win-capture.ps1:57`），进程链遍历有**跳出条件**（`$skip` 列表 + 最多 15 层）—— 遍历必须有上界。

### 5. 注释语言：这两个文件里的注释

- `hooks/win-capture.ps1` —— **英文**（历史原因）。改它时保持英文，不要中英混排。
- `tools/phone/focus.ps1` —— 中文。

### 6. 逻辑重复时必须交叉引用

`focus.ps1` 和 `lib.rs` 的 `focus_hwnd_windows` 是同一套 Win32 序列的两份实现，`focus.ps1:3` 直接指了过去：

```powershell
# 逻辑照搬 claude-code-monitor 的 app/src-tauri/src/lib.rs:307 focus_hwnd_windows()。
# 那两个看起来多余的步骤（模拟 ALT 抬起、AttachThreadInput）是必需的：
# Windows 有「前台锁」，不属于当前前台线程的进程直接调 SetForegroundWindow 会被静默忽略...
```

**改一处必须改另一处**，并保持这条交叉引用（含行号）是准确的。

前台锁那套序列的完整顺序（两处都必须一致）：

```
IsIconic → ShowWindow(SW_RESTORE)
keybd_event(VK_MENU, KEYEVENTF_KEYUP)      # 假装有键盘活动，解前台锁
GetForegroundWindow → GetWindowThreadProcessId → GetCurrentThreadId
AttachThreadInput(me, fgThread, true)
BringWindowToTop → SetForegroundWindow
AttachThreadInput(me, fgThread, false)     # 必须解绑
```

### 7. 部署联动

`win-capture.ps1` 会被复制/内嵌到用户机器上（`install-hooks.mjs:24` 的 `copyFileSync`、`install.rs:25` 的 `include_str!`）。**改它等于改采集端 → 必须 bump 版本号**，否则用户拿不到新版本。见 [../conventions/versioning-release.md](../conventions/versioning-release.md)。
