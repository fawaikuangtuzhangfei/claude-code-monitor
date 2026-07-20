use serde_json::Value;
use std::fs;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

mod install; // 看板自带的 hooks 安装/升级（hooks_status / install_hooks）

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

        // 跳过目录里的非会话 json（如 statusline 桥接写的 usage-limits.json）。
        // 会话文件必有 status 字段；缺了就不是会话，别渲染成一张 "unknown" 空卡。
        if v.get("status").and_then(|x| x.as_str()).is_none() {
            continue;
        }

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

/// 当前时间（Unix 毫秒）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把 ISO8601 UTC 时间串（如 2026-07-18T10:14:00.000Z）转成 Unix 毫秒。
/// transcript 里的 timestamp 都带 Z（UTC），所以按 UTC 解析即可；小数秒/时区后缀忽略，
/// 只取到秒——用于分桶对比阈值，精度足够。不引 chrono，用 days-from-civil 算历法。
fn iso8601_to_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    // 校验固定分隔符（'-' '-' 'T' ':' ':'），把「长度够但不是时间串」的行挡在外面，避免误解析
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    // Howard Hinnant days_from_civil
    let a = if mo <= 2 { 1 } else { 0 };
    let y2 = y - a;
    let era = (if y2 >= 0 { y2 } else { y2 - 399 }) / 400;
    let yoe = y2 - era * 400; // [0, 399]
    let m_adj = mo + 12 * a - 3; // [0, 11]
    let doy = (153 * m_adj + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + h * 3600 + mi * 60 + se;
    Some(secs * 1000)
}

/// 累加 Claude Code 本地 transcript 里的 token 用量，按滚动窗口（近 5 小时 / 近 24 小时）汇总。
///
/// 数据源：~/.claude/projects/<项目>/*.jsonl —— 每行一条事件，assistant 行带 message.usage
/// （input/output/cache_creation/cache_read 四类 token）。这是 Claude Code 自己落的本地日志，
/// **无需登录、不消耗 API、不调任何接口**，只读本机文件。
///
/// 关键处理：
///   - 按 message.id 去重：同一条 assistant 消息会因工具续写在多行重复出现，不去重会翻倍。
///   - mtime 门控：24 小时内没改动过的文件整体跳过，避免每次都全盘扫历史日志。
///   - 滚动窗口而非“本地今日”：规避本地时区/夏令时的 midnight 计算，也让深夜看数更直觉。
///   - 全量重扫（不缓存字节偏移）：文件被 /clear 换 inode 或截断都无所谓，天然无偏移量 bug。
/// Tauri 命令入口：把重活（扫目录 + 读大文件 + 解析）丢到阻塞线程池，绝不占主线程。
/// 同步命令在 Tauri v2 会跑在主线程上，扫到 28MB transcript 时足以卡住 UI；故这里用
/// async + spawn_blocking 把它挪走。
#[tauri::command]
async fn get_usage() -> Value {
    tauri::async_runtime::spawn_blocking(scan_usage)
        .await
        .unwrap_or_else(|_| serde_json::json!({ "last5h": 0, "last24h": 0, "updated_at": now_ms() }))
}

fn scan_usage() -> Value {
    use std::collections::HashSet;
    let now = now_ms();
    let t5 = now - 5 * 3600 * 1000;
    let t24 = now - 24 * 3600 * 1000;
    let mut u5: u64 = 0;
    let mut u24: u64 = 0;

    let result = |five: u64, day: u64| -> Value {
        serde_json::json!({ "last5h": five, "last24h": day, "updated_at": now })
    };

    let Some(home) = dirs::home_dir() else {
        return result(0, 0);
    };
    let root = home.join(".claude").join("projects");
    let Ok(projects) = fs::read_dir(&root) else {
        return result(0, 0);
    };

    let mut seen: HashSet<String> = HashSet::new(); // message.id 去重（滚动窗口内数量有限）
    for proj in projects.flatten() {
        let Ok(files) = fs::read_dir(proj.path()) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // mtime 门控：24h 内没动过的文件不可能有窗口内数据，整块跳过
            if let Ok(meta) = f.metadata() {
                if let Ok(m) = meta.modified() {
                    let mms = m
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    if mms < t24 {
                        continue;
                    }
                }
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            for line in text.lines() {
                // 快路径：不含 usage / 不是 assistant 的行（工具/元数据，约占多数）直接跳过，免 JSON 解析
                if !line.contains("\"usage\"") || !line.contains("assistant") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if v.get("type").and_then(|x| x.as_str()) != Some("assistant") {
                    continue;
                }
                let ts = v
                    .get("timestamp")
                    .and_then(|x| x.as_str())
                    .and_then(iso8601_to_ms);
                let Some(ts) = ts else { continue };
                if ts < t24 {
                    continue;
                }
                let Some(msg) = v.get("message") else { continue };
                // 去重：按 message.id，避免续写多行重复计数
                if let Some(id) = msg.get("id").and_then(|x| x.as_str()) {
                    if !seen.insert(id.to_string()) {
                        continue;
                    }
                }
                let Some(usage) = msg.get("usage") else { continue };
                let tok = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let total = tok("input_tokens")
                    + tok("output_tokens")
                    + tok("cache_creation_input_tokens")
                    + tok("cache_read_input_tokens");
                u24 += total;
                if ts >= t5 {
                    u5 += total;
                }
            }
        }
    }
    result(u5, u24)
}

/// 读取 statusline 桥接抓到的限额数据（~/.claude/monitor/usage-limits.json）。
/// 里面是 Claude Code 递给 statusline 的 rate_limits / context_window / cost（见 statusline-bridge.mjs）。
/// 这是**唯一**能拿到「占限额百分比」的本地来源：hook 收不到、也没有别的缓存文件。
/// 文件不存在（没装桥接）或读失败时返回空对象，前端据此退回 token 累加显示。
#[tauri::command]
fn get_rate_limits() -> Value {
    let Some(home) = dirs::home_dir() else {
        return serde_json::json!({});
    };
    let path = home
        .join(".claude")
        .join("monitor")
        .join("usage-limits.json");
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Value>(&text).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
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
        let cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("");
        focus_macos(title, tty, cwd);
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
fn focus_macos(title: &str, tty: &str, cwd: &str) {
    // Ghostty 1.3+ 自带 AppleScript 字典，每个分屏 split 都是一个可寻址的 `terminal`，
    // 且 `focus` 命令会「聚焦该 terminal 并把它所在窗口提到最前」——所以能精确定位到某一格。
    // 难点：AppleScript 读不到 split 的 tty，只暴露 id/name/working directory。我们利用看板
    // 手里已有的 tty，在点击这一刻往该 tty 写一个唯一标记当标题(OSC 2)，再让 AppleScript 去
    // focus「标题带这个标记」的那个 terminal，事后再把标题还原。
    if tty.starts_with("/dev/tty") {
        // 这条链有先后依赖(打标记→等 AppleScript 读→还原)，且首次会弹 TCC 授权框把
        // osascript 卡住，所以整段放进分离线程跑，命令立即返回、看板 UI 永不阻塞。
        let tty = tty.to_string();
        let restore = std::path::Path::new(cwd)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        std::thread::spawn(move || {
            let marker = focus_marker();
            // ① 打标记：OSC 2 只改这一个 surface 的标题，不打印字符、不进 stdin、不扰乱正在跑的 TUI。
            write_tty(&tty, &format!("\x1b]2;{marker}\x07"));

            // ② activate + 精确 focus 带标记的那一格。用同步(.status)等它读完标记再往下走，
            //    否则③的还原会抢在 AppleScript 读取之前把标记覆盖掉。none 匹配时 try 吞掉，
            //    但 activate 已经先执行——至少把 Ghostty 带到前台。
            let script = format!(
                r#"tell application "Ghostty"
  activate
  try
    focus (first terminal whose name contains "{marker}")
  end try
end tell"#
            );
            let _ = std::process::Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .status();

            // ③ 还原标题：否则这个临时标记会一直挂在 tab 上，直到 shell/Claude 下次重绘——而一个
            //    正等你输入的会话短期内并不会重绘。还原成 cwd 的目录名，跟 shell 集成给的标题一致。
            if !restore.is_empty() {
                write_tty(&tty, &format!("\x1b]2;{restore}\x07"));
            }

            // ④ 兜底：再写一个 BEL(0x07)，Ghostty 会在这一格亮起铃铛提示、视觉闪一下——万一
            //    AppleScript 被 TCC 拒了(没给自动化权限)、或 Ghostty 版本过老，这一步仍能帮你定位。
            write_tty(&tty, "\x07");
        });
        return;
    }

    // 没抓到 tty(会话还没提交过任务)：退化成「按持久化标题把整个窗口 AXRaise 提前」，
    // 粒度粗、选不到具体某一格，但聊胜于无。此路径依赖辅助功能权限。
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
}

/// 生成一次点击专属的唯一标记（纳秒时间戳，字符集仅 [A-Za-z0-9_]，塞进 AppleScript/OSC 都安全）。
#[cfg(target_os = "macos")]
fn focus_marker() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("__CCMON_{n}")
}

/// 向 tty 写一小段控制序列。只认 /dev/tty* 路径，防止误写到别的文件。
#[cfg(target_os = "macos")]
fn write_tty(tty: &str, s: &str) {
    if !tty.starts_with("/dev/tty") {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(tty) {
        use std::io::Write;
        let _ = f.write_all(s.as_bytes());
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
            get_usage,
            get_rate_limits,
            focus_session,
            remove_session,
            open_dir,
            set_pin,
            hide_win,
            set_win_height,
            set_tray_status,
            get_autostart,
            set_autostart,
            install::hooks_status,
            install::install_hooks
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
