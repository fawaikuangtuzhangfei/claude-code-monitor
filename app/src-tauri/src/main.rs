// 生产构建下隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    claude_monitor_lib::run()
}
