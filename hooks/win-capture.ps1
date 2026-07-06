# win-capture.ps1 - find the terminal window (HWND) hosting this session.
# Strategy:
#   1) The foreground window at the moment a prompt is submitted IS the user's
#      terminal window (they just pressed Enter in it). If it belongs to a known
#      terminal process, use it. This also disambiguates Windows Terminal, whose
#      multiple windows share ONE WindowsTerminal.exe pid.
#   2) Fallback: walk up the parent process chain from -StartPid and find an
#      ancestor (or its child conhost) that owns a visible top-level window.
# Prints "hwnd owningPid" (both decimal) to stdout, or "0 0".
# owningPid lets the board detect HWND recycling (closed window's handle reused
# by an unrelated window) instead of trusting IsWindow() alone.
param([int]$StartPid)

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
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
