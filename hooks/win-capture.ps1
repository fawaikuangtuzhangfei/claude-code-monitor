# win-capture.ps1 - find the terminal window (HWND) hosting this session.
# Strategy (first match wins):
#   0) If CLAUDEMON_TAG is set — a launcher gave this session's window a unique fixed
#      title (e.g. "1-1") via `wt --title X --suppressApplicationTitle` — match that
#      window by title. This is the ONLY reliable way to tell apart multiple Windows
#      Terminal windows: they all share ONE process, so pid and foreground can't.
#   1) Else the foreground window, if it belongs to a known terminal process — at prompt
#      time that is the window the user just pressed Enter in.
#   2) Else walk up the parent process chain from -StartPid and find an ancestor (or its
#      child conhost) that owns a visible top-level window.
# Prints "hwnd owningPid" (both decimal) to stdout, or "0 0".
# owningPid lets the board detect HWND recycling (closed window's handle reused
# by an unrelated window) instead of trusting IsWindow() alone.
param([int]$StartPid)

Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  // Find the visible Windows Terminal window whose title exactly == exactTitle.
  // Terminal runs every window under ONE pid, so neither pid nor foreground can tell
  // its windows apart — a unique per-window title (set by the launcher via
  // `wt --title X --suppressApplicationTitle`) is the only reliable key.
  public static IntPtr FindWindowByTitle(string exactTitle) {
    IntPtr result = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cn = new StringBuilder(256); GetClassName(h, cn, cn.Capacity);
      if (cn.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS") return true;
      var tb = new StringBuilder(512); GetWindowText(h, tb, tb.Capacity);
      if (tb.ToString() == exactTitle) { result = h; return false; }
      return true;
    }, IntPtr.Zero);
    return result;
  }
  public static IntPtr FindWindowForPids(HashSet<uint> pids) {
    IntPtr result = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (pids.Contains(wpid) && IsWindowVisible(h)) { result = h; return false; }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@

$termNames = @('WindowsTerminal','powershell','pwsh','cmd','conhost','OpenConsole',
               'wt','alacritty','wezterm-gui','mintty','Hyper','Code')

# --- 0) fixed window-title tag, if the launcher set one ---
# Highest priority: when a session is launched with CLAUDEMON_TAG (its window's fixed
# title, e.g. "1-1"), map straight to THAT window by title. This is the only reliable
# way to disambiguate multiple Windows Terminal windows, which all share one pid.
$tag = $env:CLAUDEMON_TAG
if ($tag) {
  $th = [WinCap]::FindWindowByTitle($tag)
  if ($th -ne [IntPtr]::Zero) {
    $tp = 0
    [WinCap]::GetWindowThreadProcessId($th, [ref]$tp) | Out-Null
    Write-Output ("{0} {1}" -f [int64]$th, [int]$tp)
    return
  }
}

# --- 1) foreground window, if it is a terminal ---
$fg = [WinCap]::GetForegroundWindow()
if ($fg -ne [IntPtr]::Zero) {
  $fgPid = 0
  [WinCap]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
  $pn = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).ProcessName
  if ($pn -and ($termNames -contains $pn)) {
    Write-Output ("{0} {1}" -f [int64]$fg, [int]$fgPid)
    return
  }
}

# --- 2) fallback: walk the parent process chain ---
$procs = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $procs[[uint32]$_.ProcessId] = @{ Parent = [uint32]$_.ParentProcessId; Name = $_.Name }
}
$skip = @('explorer.exe','svchost.exe','services.exe','wininit.exe','System','Idle')
$cur = [uint32]$StartPid
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 15; $i++) {
  if (-not $procs.ContainsKey($cur)) { break }
  $info = $procs[$cur]
  if ($skip -notcontains $info.Name) {
    $pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
    [void]$pidSet.Add($cur)
    foreach ($k in $procs.Keys) { if ($procs[$k].Parent -eq $cur) { [void]$pidSet.Add($k) } }
    $found = [WinCap]::FindWindowForPids($pidSet)
    if ($found -ne [IntPtr]::Zero) { $hwnd = $found; break }
  }
  $parent = $info.Parent
  if ($parent -eq 0 -or $parent -eq $cur) { break }
  if ($procs.ContainsKey($parent) -and $skip -contains $procs[$parent].Name) { break }
  $cur = $parent
}
$outPid = 0
if ($hwnd -ne [IntPtr]::Zero) {
  [WinCap]::GetWindowThreadProcessId($hwnd, [ref]$outPid) | Out-Null
}
Write-Output ("{0} {1}" -f [int64]$hwnd, [int]$outPid)
