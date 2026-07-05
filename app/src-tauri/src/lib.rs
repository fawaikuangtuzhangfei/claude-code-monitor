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
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(mut v) = serde_json::from_str::<Value>(&text) {
                // 实时读取该会话终端窗口的标题（有则前端优先显示）
                #[cfg(windows)]
                {
                    if let Some(hwnd) = v.get("win_hwnd").and_then(|x| x.as_i64()) {
                        if hwnd != 0 {
                            let title = window_title_windows(hwnd);
                            if !title.is_empty() {
                                if let Some(obj) = v.as_object_mut() {
                                    obj.insert("term_title".into(), Value::String(title));
                                }
                            }
                        }
                    }
                }
                out.push(v);
            }
        }
    }
    out
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
        focus_macos(title);
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
fn focus_macos(title: &str) {
    // 先激活 Ghostty，再用 System Events 把标题匹配的窗口 AXRaise 到最前
    let script = format!(
        r#"
tell application "Ghostty" to activate
try
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
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
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

/// 置顶开关（前端 📌 按钮调用）
#[tauri::command]
fn set_pin(app: tauri::AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(on);
    }
}

/// 隐藏到托盘（前端 — 按钮调用）
#[tauri::command]
fn hide_win(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 自适应高度：前端按卡片数量算出所需逻辑高度，这里保持宽度只改高度
#[tauri::command]
fn set_win_height(app: tauri::AppHandle, height: f64) {
    if let Some(w) = app.get_webview_window("main") {
        let scale = w.scale_factor().unwrap_or(1.0);
        let cur_w = w
            .inner_size()
            .map(|s| s.width as f64 / scale)
            .unwrap_or(300.0);
        let h = height.max(80.0);
        let _ = w.set_size(tauri::LogicalSize::new(cur_w, h));
    }
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    tauri::Builder::default()
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
            set_pin,
            hide_win,
            set_win_height
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "显示看板", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏看板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Claude 看板（左键单击唤出 / Ctrl+Alt+C）")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 只在左键“抬起”时唤出（Click 会在按下/抬起各触发一次，否则一显一隐等于没反应）
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // 注册全局快捷键 Ctrl+Alt+C 唤出看板
            let _ = app.global_shortcut().register("CmdOrControl+Alt+C");

            // 开机自启（幂等；用户可后续在系统里关掉）
            let autostart = app.autolaunch();
            let _ = autostart.enable();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
