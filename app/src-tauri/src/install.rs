// install.rs — 由看板 App 自己把「状态采集 hooks + statusline 桥接」装/升进 ~/.claude/。
//
// 为什么放在 App 里：以前升级要两步——① 下 .dmg 换看板 ② 终端里 `node install-hooks.mjs`
// 换采集端。用户常忘第 ②步，导致看板是新的、hooks 是旧的（比如缺 statusline 桥接就只能退回
// token 累加，显示不了限额%）。这里让 App 在启动时探测版本，缺/旧就弹窗一键补上。
//
// 两个刻意的设计：
//   1) hook 脚本用 include_str! **编译进二进制**，安装时直接落盘——不走 Tauri 资源打包
//      （跨平台路径解析很坑），也不依赖运行时能找到源文件。
//   2) 安装这一步**全程 Rust、不 spawn node**——macOS 上从访达/Dock 启动的 GUI App PATH 极简、
//      带不到 nvm 的 node，若 shell out 装会失败。hook 命令本身仍是 `node "..."`，那是 Claude Code
//      在用户 shell 环境里调的，不受影响。
//
// 逻辑与 install/install-hooks.mjs 对齐（先删后加=幂等升级、备份 settings.json、包裹 statusLine
// 并存原命令以便卸载还原），改用 serde_json 操作。

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

// —— hook 脚本：编译期内嵌（路径相对本文件：src-tauri/src → 仓库根 hooks/）——
const EMIT_STATUS: &str = include_str!("../../../hooks/emit-status.mjs");
const STATUS_LOGIC: &str = include_str!("../../../hooks/status-logic.mjs");
const STATUSLINE_BRIDGE: &str = include_str!("../../../hooks/statusline-bridge.mjs");
const WIN_CAPTURE: &str = include_str!("../../../hooks/win-capture.ps1");

const MARK: &str = "emit-status.mjs"; // 识别「是我们装的采集钩子」
const BRIDGE_MARK: &str = "statusline-bridge.mjs"; // 识别「statusLine 已被桥接包住」
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

// 事件 -> settings.json 里的 hook 事件名 + 传给发射器的参数（与 install-hooks.mjs 的 MAP 一致）
const MAP: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "prompt"),
    ("PreToolUse", "pretool"),
    ("PostToolUse", "posttool"),
    ("Notification", "notification"),
    ("PermissionRequest", "permission"),
    ("Stop", "stop"),
    ("SubagentStop", "subagent-stop"),
    ("SessionEnd", "session-end"),
];

fn claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}
fn hooks_dir() -> Option<PathBuf> {
    claude_dir().map(|d| d.join("monitor-hooks"))
}
// hook 命令里的路径统一用正斜杠：Node 在 Windows 上也认，免去 JSON 里反斜杠转义
fn slash(p: &PathBuf) -> String {
    p.to_string_lossy().replace('\\', "/")
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 探测：采集端是否需要安装/升级。前端启动时据此决定是否弹窗。
/// needs_install = 发射器或桥接缺失 || 已装版本 != App 版本。
#[tauri::command]
pub fn hooks_status() -> Value {
    let Some(hd) = hooks_dir() else {
        return json!({ "needs_install": false, "app_version": APP_VERSION });
    };
    let emit_exists = hd.join("emit-status.mjs").exists();
    let bridge_exists = hd.join("statusline-bridge.mjs").exists();
    let installed_version = fs::read_to_string(hd.join(".installed-version"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // statusLine 当前是否已被桥接接管（决定弹窗文案，也用于判断要不要提示接管）
    let statusline_wrapped = claude_dir()
        .and_then(|d| fs::read_to_string(d.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| {
            v.get("statusLine")
                .and_then(|s| s.get("command"))
                .and_then(|c| c.as_str())
                .map(|c| c.contains(BRIDGE_MARK))
        })
        .unwrap_or(false);

    let up_to_date = installed_version.as_deref() == Some(APP_VERSION);
    let needs_install = !emit_exists || !bridge_exists || !up_to_date;

    json!({
        "needs_install": needs_install,
        "first_time": !emit_exists,           // 从没装过 → 文案说“安装”，否则“更新”
        "app_version": APP_VERSION,
        "installed_version": installed_version,
        "bridge_exists": bridge_exists,
        "statusline_wrapped": statusline_wrapped,
    })
}

/// 执行安装/升级。with_statusline=true 时接管 statusLine 以显示限额%（默认）。
/// 返回结果说明；解析用户 settings.json 失败时**绝不覆盖**，另存后报错。
#[tauri::command]
pub fn install_hooks(with_statusline: bool) -> Result<Value, String> {
    let claude = claude_dir().ok_or("找不到 home 目录")?;
    let hd = claude.join("monitor-hooks");
    fs::create_dir_all(&hd).map_err(|e| e.to_string())?;

    // 1) 铺 hook 脚本（编译期内嵌 → 直接落盘）
    fs::write(hd.join("emit-status.mjs"), EMIT_STATUS).map_err(|e| e.to_string())?;
    fs::write(hd.join("status-logic.mjs"), STATUS_LOGIC).map_err(|e| e.to_string())?;
    fs::write(hd.join("statusline-bridge.mjs"), STATUSLINE_BRIDGE).map_err(|e| e.to_string())?;
    fs::write(hd.join("win-capture.ps1"), WIN_CAPTURE).map_err(|e| e.to_string())?;

    let settings_path = claude.join("settings.json");

    // 2) 读 settings.json —— 解析失败绝不覆盖：另存坏文件后中止，让用户自己修
    let mut settings: Value = if settings_path.exists() {
        let raw = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        match serde_json::from_str::<Value>(&raw) {
            Ok(v) => {
                // 解析成功才备份（备份的是好文件）
                let _ = fs::copy(&settings_path, claude.join("settings.json.bak-monitor"));
                v
            }
            Err(e) => {
                let bad = claude.join(format!("settings.json.unparsable-{}", now_ms()));
                let _ = fs::write(&bad, &raw);
                return Err(format!(
                    "settings.json 解析失败（未做任何改动），已另存到 {}。请修好后重试：{}",
                    bad.display(),
                    e
                ));
            }
        }
    } else {
        json!({})
    };
    if !settings.is_object() {
        return Err("settings.json 顶层不是对象，已中止（未改动）".into());
    }

    // 3) 合并 hooks：先删后加=幂等升级（把我们旧钩子按 MARK 删掉再补最新，用户自己的钩子保留）
    let emit_path = slash(&hd.join("emit-status.mjs"));
    {
        let obj = settings.as_object_mut().unwrap();
        let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
        let hooks_obj = hooks
            .as_object_mut()
            .ok_or("settings.json 里 hooks 不是对象")?;
        for (event, arg) in MAP {
            let cmd = format!("node \"{emit_path}\" {arg}");
            let groups = hooks_obj
                .entry((*event).to_string())
                .or_insert_with(|| json!([]));
            let arr = groups.as_array_mut().ok_or("hook 事件值不是数组")?;
            arr.retain(|g| !group_has_our_hook(g)); // 删掉我们之前装的
            arr.push(json!({ "hooks": [{ "type": "command", "command": cmd }] }));
        }
    }

    // 4) statusLine 桥接（拿限额%的唯一途径）——可选
    let mut statusline_msg = String::from("未接管状态栏（按你的选择）");
    if with_statusline {
        let bridge_cmd = format!("node \"{}\"", slash(&hd.join("statusline-bridge.mjs")));
        let cur = settings.get("statusLine").cloned();
        let already = cur
            .as_ref()
            .and_then(|c| c.get("command"))
            .and_then(|c| c.as_str())
            .map(|c| c.contains(BRIDGE_MARK))
            .unwrap_or(false);
        if already {
            // 已是桥接：只刷新路径
            if let Some(sl) = settings.get_mut("statusLine") {
                sl["type"] = json!("command");
                sl["command"] = json!(bridge_cmd);
            }
            statusline_msg = "statusLine 已是桥接，已刷新".into();
        } else {
            // 首次包裹：把原 statusLine 原样存起来（卸载据此还原），再改指向桥接
            let wrapped = cur.clone().unwrap_or_else(|| json!({}));
            let _ = fs::write(
                hd.join("wrapped-statusline.json"),
                serde_json::to_string_pretty(&wrapped).unwrap_or_else(|_| "{}".into()),
            );
            let mut sl = cur.unwrap_or_else(|| json!({}));
            if !sl.is_object() {
                sl = json!({});
            }
            sl["type"] = json!("command");
            sl["command"] = json!(bridge_cmd);
            settings["statusLine"] = sl;
            statusline_msg = "已接管 statusLine（原命令已存，卸载可还原）".into();
        }
    }

    // 5) 写回 settings.json + 版本标记
    let out = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, out).map_err(|e| e.to_string())?;
    let _ = fs::write(hd.join(".installed-version"), APP_VERSION);

    Ok(json!({
        "ok": true,
        "app_version": APP_VERSION,
        "statusline": statusline_msg,
    }))
}

// 某 hook group 里是否含我们装的钩子（按 emit-status.mjs 标记识别）
fn group_has_our_hook(g: &Value) -> bool {
    g.get("hooks")
        .and_then(|h| h.as_array())
        .map(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(MARK))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}
