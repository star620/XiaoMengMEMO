// 小梦备忘录 · 程序入口（正式逻辑都在 lib.rs，方便将来加测试）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    xiaomeng_memo_lib::run()
}
