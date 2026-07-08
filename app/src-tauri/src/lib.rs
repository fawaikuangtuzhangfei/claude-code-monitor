use serde_json::Value;
use std::fs;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// 读取 ~/.claude/monitor/*.json，每个文件是一个会话的状态
#[tauri::command]
fn list_sessions() -> Vec<Value> {
    let mut out = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let dir = home.join(".claude").join("monitor");
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };

        // Windows：实时读取该会话终端窗口标题；窗口已不存在 = 终端被直接关掉
        // （未触发 SessionEnd）的僵尸会话，剔除，避免残留一张假 RUN/DONE/WAIT。
        #[cfg(windows)]
        let v = {
            let mut v = v;
            if let Some(hwnd) = v.get("win_hwnd").and_then(|x| x.as_i64()) {
                if hwnd != 0 {
                    if !window_alive_windows(hwnd) {
                        continue;
                    }
                    // IsWindow 还不够：Windows 会把关掉窗口的 HWND 号回收给别的窗口
                    // （重启后尤为普遍），于是一堆早已关闭的会话卡片赖着不走。
                    // 再校验“当前拥有该 HWND 的进程”是否仍是捕获时那个 pid：
                    // 不一致 = 句柄已被复用 → 同样是僵尸，剔除。
                    // （旧状态文件没有 win_pid 时跳过此校验，保持兼容。）
                    if let Some(pid) = v.get("win_pid").and_then(|x| x.as_i64()) {
                        if pid != 0 {
                            let cur = window_pid_windows(hwnd);
                            // 拿不到当前 pid（cur==0）时不据此判定，避免误删活会话；
                            // 只有确实取到且与捕获时不一致，才认定句柄已被复用。
                            if cur != 0 && cur as i64 != pid {
                                continue;
                            }
                        }
                    }
                    let title = window_title_windows(hwnd);
                    if !title.is_empty() {
                        if let Some(obj) = v.as_object_mut() {
                            obj.insert("term_title".into(), Value::String(title));
                        }
                    }
                }
            }
            v
        };

        // macOS：没有窗口存活检测，改用会话进程存活来判断僵尸——hook 记录了承载会话的
        // 进程 owner_pid，若它已不存在，说明终端标签/窗口被直接关掉，剔除对应卡片。
        // 用进程存活而非超时，所以真在 waiting/idle 长时间挂着的会话不会被误删。
        #[cfg(target_os = "macos")]
        {
            if let Some(pid) = v.get("owner_pid").and_then(|x| x.as_i64()) {
                if pid > 1 && !process_alive_macos(pid) {
                    continue;
                }
            }
        }

        out.push(v);
    }
    out
}

/// 进程是否还存活（用于剔除终端已被关闭的僵尸会话）。
/// kill(pid, 0) 不发信号只做存在性探测：0 = 存在；EPERM = 存在但无权限（也算活）；
/// 仅 ESRCH 才是真的没了。
#[cfg(target_os = "macos")]
fn process_alive_macos(pid: i64) -> bool {
    unsafe {
        if libc::kill(pid as libc::pid_t, 0) == 0 {
            return true;
        }
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// 点击卡片 -> 把该会话所在的终端窗口切到前台
#[tauri::command]
fn focus_session(session_id: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let path = home
        .join(".claude")
        .join("monitor")
        .join(format!("{session_id}.json"));
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        let hwnd = v.get("win_hwnd").and_then(|x| x.as_i64()).unwrap_or(0);
        if hwnd == 0 {
            return Err("这个会话还没捕获到终端窗口（需重启该会话或先提交一次任务）".into());
        }
        focus_hwnd_windows(hwnd);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let title = v.get("window_title").and_then(|x| x.as_str()).unwrap_or("");
        let tty = v.get("tty").and_then(|x| x.as_str()).unwrap_or("");
        focus_macos(title, tty);
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(windows)]
fn focus_hwnd_windows(hwnd: i64) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };
    let hwnd = HWND(hwnd as *mut _);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        // 模拟一次 ALT 抬起，解除 Windows 的前台锁
        keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);

        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        let _ = AttachThreadInput(me, fg_thread, true);
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        let _ = AttachThreadInput(me, fg_thread, false);
    }
}

#[cfg(target_os = "macos")]
fn focus_macos(title: &str, tty: &str) {
    // ① 把 Ghostty 唤到最前；若该会话恰好在“独立窗口”里，还顺带按标题 AXRaise 提到最前。
    //    （Ghostty 的分屏 split 在辅助功能树里不是独立可寻址元素，也没有 IPC，无法从外部
    //     精确聚焦某一格——这一步只能保证把 Ghostty 应用本身带到前台。）
    let mut script = String::from("tell application \"Ghostty\" to activate\n");
    if !title.is_empty() {
        script.push_str(&format!(
            r#"try
  tell application "System Events" to tell process "Ghostty"
    repeat with w in windows
      if (title of w) contains "{title}" then
        perform action "AXRaise" of w
        exit repeat
      end if
    end repeat
  end tell
end try
"#
        ));
    }
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn();

    // ② 向该会话的 tty 写一个 BEL(0x07)：Ghostty 会在对应 tab/分屏上亮起提示、视觉闪一下，
    //    帮你一眼定位到具体是哪一格。BEL 不打印字符、不进程序 stdin，不会打乱正在跑的 TUI。
    //    只接受 /dev/tty* 路径，防止误写到别的文件。
    if tty.starts_with("/dev/tty") {
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(tty) {
            use std::io::Write;
            let _ = f.write_all(b"\x07");
        }
    }
}

/// 终端窗口是否还存在（用于剔除终端已被关闭的僵尸会话）
#[cfg(windows)]
fn window_alive_windows(hwnd: i64) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;
    let hwnd = HWND(hwnd as *mut _);
    unsafe { IsWindow(hwnd).as_bool() }
}

/// 返回当前拥有该 HWND 的进程 pid（0 = 取不到）。用于识别 HWND 被系统回收复用的僵尸会话。
#[cfg(windows)]
fn window_pid_windows(hwnd: i64) -> u32 {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let hwnd = HWND(hwnd as *mut _);
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid
}

#[cfg(windows)]
fn window_title_windows(hwnd: i64) -> String {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    let hwnd = HWND(hwnd as *mut _);
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

/// 清洗会话 id：只留 [A-Za-z0-9_-]，杜绝 ../ 路径穿越（与 hook 端规则一致）
fn sanitize_id(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(128)
        .collect();
    if cleaned.is_empty() {
        "unknown".into()
    } else {
        cleaned
    }
}

/// 右键“移除卡片” -> 删除该会话状态文件（清洗 id，杜绝路径穿越；文件已不存在也算成功）
#[tauri::command]
fn remove_session(session_id: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let path = home
        .join(".claude")
        .join("monitor")
        .join(format!("{}.json", sanitize_id(&session_id)));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 右键“打开项目目录” -> 用系统文件管理器打开会话 cwd
#[tauri::command]
fn open_dir(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("空路径".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 置顶开关（前端 📌 按钮调用）——作用于发起调用的那个窗口自身（固定看板 / 浮窗各管各的）
#[tauri::command]
fn set_pin(window: tauri::WebviewWindow, on: bool) {
    let _ = window.set_always_on_top(on);
}

/// 隐藏到托盘（前端 ▁ 按钮调用）——隐藏发起调用的那个窗口自身
#[tauri::command]
fn hide_win(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

/// 开机自启：查询当前状态（前端 ⏻ 按钮加载时读一次）
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// 开机自启：开/关（前端 ⏻ 按钮点击时调用）
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, on: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if on {
        let _ = m.enable();
    } else {
        let _ = m.disable();
    }
}

/// 自适应高度：前端按卡片数量算出所需逻辑高度，这里保持宽度只改高度。
/// 作用于发起调用的窗口自身——固定看板与浮窗各自伸缩，互不影响。
#[tauri::command]
fn set_win_height(window: tauri::WebviewWindow, height: f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let cur_w = window
        .inner_size()
        .map(|s| s.width as f64 / scale)
        .unwrap_or(300.0);
    let h = height.max(80.0);
    let _ = window.set_size(tauri::LogicalSize::new(cur_w, h));

    // 浮窗贴在屏角、从任务栏上方“长出来”：高度变了要保持**底边不动、往上长**，
    // 否则每次卡片增减都会把窗口往下顶进任务栏。用刚设定的新高度重新钉住屏角。
    #[cfg(windows)]
    if window.label() == "popover" {
        pin_popover_bottom(&window, h * scale);
    }
}

/// 前端每次 WAIT/RUN/DONE 计数变化时调用：把状态“上移”到托盘图标本身，
/// 这样面板收进托盘后，余光扫一眼图标就知道有没有会话在等你——状态栏模式的核心。
///   Windows：托盘不支持文字，改用图标——有人 WAIT 就换成红点告警图标，否则常规图标；
///            明细放 tooltip（悬停可见）。
///   macOS：菜单栏图标旁直接显示文字计数（set_title），一眼看数；没人等你时清空不占地方。
#[tauri::command]
fn set_tray_status(app: tauri::AppHandle, n_wait: u32, n_run: u32, n_done: u32) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };

    // tooltip 两平台都设，悬停看明细
    let tip = format!("Claude 看板  ⏸{n_wait} ▶{n_run} ✓{n_done}");
    let _ = tray.set_tooltip(Some(&tip));

    #[cfg(windows)]
    {
        if n_wait > 0 {
            let _ = tray.set_icon(Some(tauri::include_image!("icons/tray-alert.png")));
        } else if let Some(def) = app.default_window_icon() {
            // 常规态用回原图标，与初始完全一致
            let _ = tray.set_icon(Some(def.clone()));
        }
    }

    #[cfg(target_os = "macos")]
    {
        // 有人等你时显示 ⏸N，只在跑时显示 ▶N，其余清空
        let title = if n_wait > 0 {
            format!("⏸{n_wait}")
        } else if n_run > 0 {
            format!("▶{n_run}")
        } else {
            String::new()
        };
        let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
    }
}

/// 把窗口摆到「当前主屏」的右上角，并保证整块窗口都落在该屏可见范围内。
///
/// 之前是在 tauri.conf.json 里写死 x=1560/y=60，作者的单屏宽屏没问题，
/// 但换分辨率或多屏（尤其外接屏把坐标原点拉成负数）时，窗口会被丢到可见区
/// 之外，表现为「看板打开了但什么都看不到」。这里改成运行时按屏幕实测尺寸算，
/// 且全程用同一块显示器的物理坐标，跟 set_position 坐标系一致，绝不会跑到屏外。
fn place_window(w: &tauri::WebviewWindow) {
    use tauri::PhysicalPosition;
    // 拿主屏（菜单栏所在屏）的物理位置与尺寸；拿不到就退回居中，至少可见。
    let Ok(Some(monitor)) = w.primary_monitor() else {
        let _ = w.center();
        return;
    };
    let scale = monitor.scale_factor();
    let mpos = monitor.position(); // 物理像素，多屏下可能是负数
    let msize = monitor.size(); // 物理像素
    let win = w
        .outer_size()
        .unwrap_or(tauri::PhysicalSize::new(320, 280));

    let margin = (16.0 * scale) as i32; // 距屏幕边缘留白
    let top_gap = (36.0 * scale) as i32; // 顶部让开菜单栏

    let mut x = mpos.x + msize.width as i32 - win.width as i32 - margin;
    let mut y = mpos.y + top_gap;

    // 钳制：万一窗口比屏还宽/高，或算出来越界，都拉回屏内
    let min_x = mpos.x + margin;
    let max_x = mpos.x + msize.width as i32 - win.width as i32 - margin;
    let min_y = mpos.y + top_gap;
    let max_y = mpos.y + msize.height as i32 - win.height as i32 - margin;
    x = x.clamp(min_x, max_x.max(min_x));
    y = y.clamp(min_y, max_y.max(min_y));

    let _ = w.set_position(PhysicalPosition::new(x, y));
}

/// 唤出「固定看板」（dock）——全局快捷键 / 托盘菜单「显示」用。它是常驻桌面那块，
/// 位置由用户自己拖定，这里只负责显示+聚焦，不重新摆位。
fn show_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("dock") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 浮窗（popover）刚因失焦自动收起的时刻，用来挡住「点托盘那一下」引发的重复触发。
struct PopoverHidden(std::sync::Mutex<Option<std::time::Instant>>);

/// 托盘左键：开合「浮窗」（popover，CodexBar 式）——贴屏角弹出，再点一次收起。
/// anchor 是托盘图标的点击坐标（物理像素），用于把浮窗贴到最近的屏角。
fn toggle_window_at(app: &tauri::AppHandle, anchor_x: f64, anchor_y: f64) {
    let Some(w) = app.get_webview_window("popover") else {
        return;
    };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        return;
    }
    // 若浮窗刚因「点托盘」失焦而自动收起（<300ms），这一次点击就是要关它——别又弹回来。
    if let Some(state) = app.try_state::<PopoverHidden>() {
        if let Ok(guard) = state.0.lock() {
            if guard.map(|t| t.elapsed().as_millis() < 300).unwrap_or(false) {
                return;
            }
        }
    }
    place_window_near(&w, anchor_x, anchor_y);
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// 把面板贴到「离托盘图标最近的屏幕角」弹出——就是 Windows 原生托盘浮窗（音量/网络/Slack
/// 那种）的位置：紧贴工作区角、从任务栏上方升起，而不是浮在鼠标周围。
///
/// 关键：用**工作区**（rcWork，已排除任务栏）而非整块屏幕来贴边，这样面板不会压到任务栏，
/// 也永远从图标那一侧“长出来”。任务栏在哪条边都自适应（rcWork 已替我们算好）。
#[cfg(windows)]
fn place_window_near(w: &tauri::WebviewWindow, anchor_x: f64, anchor_y: f64) {
    use tauri::PhysicalPosition;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    let pt = POINT {
        x: anchor_x as i32,
        y: anchor_y as i32,
    };
    let hmon = unsafe { MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST) };
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(hmon, &mut mi) }.as_bool() {
        place_window(w);
        return;
    }
    let wr = mi.rcWork; // 工作区（物理像素、已排除任务栏），与 set_position 的物理坐标系一致
    let win = w.outer_size().unwrap_or(tauri::PhysicalSize::new(320, 280));
    let margin = 6;
    let (ax, ay) = (anchor_x as i32, anchor_y as i32);
    let cx = (wr.left + wr.right) / 2;
    let cy = (wr.top + wr.bottom) / 2;
    // 贴到锚点所在的那个工作区角：托盘在右下 → 贴右下、从上方升起
    let x = if ax >= cx {
        wr.right - win.width as i32 - margin
    } else {
        wr.left + margin
    };
    let y = if ay >= cy {
        wr.bottom - win.height as i32 - margin
    } else {
        wr.top + margin
    };
    let _ = w.set_position(PhysicalPosition::new(x.max(wr.left), y.max(wr.top)));
}

/// 浮窗高度变化后，保持底边贴住工作区底、往上长（宽度不变，只挪 y）。
/// 用刚设定的新物理高度算 y，不读可能还没刷新的 outer_size，避免钉偏一帧。
#[cfg(windows)]
fn pin_popover_bottom(w: &tauri::WebviewWindow, new_h_phys: f64) {
    use tauri::PhysicalPosition;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    let Ok(pos) = w.outer_position() else {
        return;
    };
    let win = w.outer_size().unwrap_or(tauri::PhysicalSize::new(320, 280));
    // 用窗口中心定位它当前所在的显示器
    let pt = POINT {
        x: pos.x + win.width as i32 / 2,
        y: pos.y + win.height as i32 / 2,
    };
    let hmon = unsafe { MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST) };
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(hmon, &mut mi) }.as_bool() {
        return;
    }
    let wr = mi.rcWork;
    let margin = 6;
    let new_h = new_h_phys.round() as i32;
    let cy = (wr.top + wr.bottom) / 2;
    // 窗口在工作区下半（任务栏在底、托盘浮窗贴底）→ 底边对齐；否则贴顶
    let y = if pt.y >= cy {
        wr.bottom - new_h - margin
    } else {
        wr.top + margin
    };
    let _ = w.set_position(PhysicalPosition::new(pos.x, y));
}

/// macOS：菜单栏在顶，从图标下方掉出来、右对齐贴近点击点。取不到显示器就退回主屏右上角。
#[cfg(not(windows))]
fn place_window_near(w: &tauri::WebviewWindow, anchor_x: f64, anchor_y: f64) {
    use tauri::PhysicalPosition;
    let Ok(Some(monitor)) = w.monitor_from_point(anchor_x, anchor_y) else {
        place_window(w);
        return;
    };
    let scale = monitor.scale_factor();
    let mpos = monitor.position();
    let msize = monitor.size();
    let win = w.outer_size().unwrap_or(tauri::PhysicalSize::new(320, 280));
    let margin = (6.0 * scale) as i32;
    let ax = anchor_x as i32;

    // 顶部菜单栏 → 往下掉；水平让面板右缘对齐图标（菜单栏图标偏右）
    let mut x = ax - win.width as i32 / 2;
    let mut y = mpos.y + (26.0 * scale) as i32; // 让开菜单栏高度

    let min_x = mpos.x + margin;
    let max_x = mpos.x + msize.width as i32 - win.width as i32 - margin;
    let min_y = mpos.y + margin;
    let max_y = mpos.y + msize.height as i32 - win.height as i32 - margin;
    x = x.clamp(min_x, max_x.max(min_x));
    y = y.clamp(min_y, max_y.max(min_y));
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 全局快捷键：唤出（若已可见则置顶聚焦）——永远能召回看板
                    if event.state() == ShortcutState::Pressed {
                        show_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            focus_session,
            remove_session,
            open_dir,
            set_pin,
            hide_win,
            set_win_height,
            set_tray_status,
            get_autostart,
            set_autostart
        ])
        .setup(|app| {
            // 浮窗失焦自动收起用的时间戳，供托盘点击守卫读取
            app.manage(PopoverHidden(std::sync::Mutex::new(None)));

            let show = MenuItem::with_id(app, "show", "显示固定看板", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏固定看板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Claude 看板（左键开合浮窗 / 右键菜单管固定看板 / Ctrl+Alt+C）")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "hide" => {
                        if let Some(w) = app.get_webview_window("dock") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 只在左键“抬起”时切换开合（Click 会在按下/抬起各触发一次，只认一次）。
                    // 用抬起坐标把面板就近弹到托盘旁。右键仍走系统菜单（show_menu_on_left_click=false）。
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        toggle_window_at(tray.app_handle(), position.x, position.y);
                    }
                })
                .build(app)?;

            // 注册全局快捷键 Ctrl+Alt+C 唤出看板
            let _ = app.global_shortcut().register("CmdOrControl+Alt+C");

            // 开机自启：仅首次运行默认开启；之后尊重用户在看板里 ⏻ 的开关
            if let Some(marker) =
                dirs::home_dir().map(|h| h.join(".claude").join("monitor").join(".autostart-init"))
            {
                if !marker.exists() {
                    let _ = app.autolaunch().enable();
                    if let Some(p) = marker.parent() {
                        let _ = std::fs::create_dir_all(p);
                    }
                    let _ = std::fs::write(&marker, "1");
                }
            }

            // 固定看板（dock）：常驻桌面。按当前主屏摆到右上角再显示，避免多屏下跑到屏外。
            if let Some(dock) = app.get_webview_window("dock") {
                place_window(&dock);
                let _ = dock.show();
            }

            // 浮窗（popover）：默认隐藏，托盘左键唤出；点到别处（失焦）就自动收起——CodexBar 式下拉。
            // 记下收起时刻，让托盘点击守卫能区分「点托盘关它」和「点托盘开它」，不会一点又弹回来。
            if let Some(popover) = app.get_webview_window("popover") {
                let handle = app.handle().clone();
                popover.on_window_event(move |ev| {
                    if let tauri::WindowEvent::Focused(false) = ev {
                        if let Some(w) = handle.get_webview_window("popover") {
                            let _ = w.hide();
                        }
                        if let Some(state) = handle.try_state::<PopoverHidden>() {
                            if let Ok(mut g) = state.0.lock() {
                                *g = Some(std::time::Instant::now());
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
