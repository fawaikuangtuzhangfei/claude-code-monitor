# focus.ps1 — 把指定 HWND 的窗口提到前台
#
# 逻辑照搬 claude-code-monitor 的 app/src-tauri/src/lib.rs:307 focus_hwnd_windows()。
# 那两个看起来多余的步骤（模拟 ALT 抬起、AttachThreadInput）是必需的：
# Windows 有「前台锁」，不属于当前前台线程的进程直接调 SetForegroundWindow 会被静默忽略，
# 只闪一下任务栏。附加输入线程 + 假装有键盘活动才能真正把窗口提上来。
#
# 用法：powershell -File focus.ps1 -Hwnd 331134
# 输出：OK / NOWINDOW

param([Parameter(Mandatory = $true)][int64]$Hwnd)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@ -ErrorAction SilentlyContinue | Out-Null

$h = [IntPtr]$Hwnd

if (-not [Fg]::IsWindow($h)) {
  Write-Output "NOWINDOW"
  exit 1
}

# 最小化了先还原（SW_RESTORE = 9）
if ([Fg]::IsIconic($h)) { [void][Fg]::ShowWindow($h, 9) }

# 模拟一次 ALT 抬起，解除前台锁（VK_MENU = 0x12, KEYEVENTF_KEYUP = 2）
[Fg]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)

# 把自己的输入线程附加到当前前台线程上，才有资格改前台窗口
$fg = [Fg]::GetForegroundWindow()
$fgThread = [Fg]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$me = [Fg]::GetCurrentThreadId()

[void][Fg]::AttachThreadInput($me, $fgThread, $true)
[void][Fg]::BringWindowToTop($h)
[void][Fg]::SetForegroundWindow($h)
[void][Fg]::AttachThreadInput($me, $fgThread, $false)

Write-Output "OK"
