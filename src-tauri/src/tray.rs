//! 系统托盘：常驻图标 + 菜单，左键单击打开管理面板。
//! 菜单顶部显示「今天 N 条待办」，下面「最近便签」子菜单可直接点开；
//! 便签一变（notes-changed）就节流 500ms 重建菜单，保证数字和列表是新的。

use std::time::Duration;

use chrono::{Datelike, Local, TimeZone};
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Listener, Manager, Wry};

use crate::commands;
use crate::log_line;
use crate::model::{Note, NoteKind};
use crate::store::Store;
use crate::windows;

pub const TRAY_ID: &str = "main-tray";

/// 创建托盘（应用启动时调用一次），并开始监听 notes-changed 以刷新菜单
pub fn create(app: &AppHandle) -> Result<(), String> {
    let menu = build_menu(app)?;
    let tooltip = tooltip_text(app);

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(tooltip)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_icon_event);

    // 优先用 app 默认图标；万一拿不到（开发模式/配置异常）就用打包内置的 32px 图标，别让托盘变成空白
    let icon =
        app.default_window_icon().cloned().or_else(|| {
            match tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")) {
                Ok(icon) => Some(icon),
                Err(err) => {
                    log_line(format!("读取内置托盘图标失败：{err}"));
                    None
                }
            }
        });
    match icon {
        Some(icon) => builder = builder.icon(icon),
        None => log_line("没有可用的托盘图标，托盘可能不可见"),
    }

    builder
        .build(app)
        .map_err(|err| format!("创建托盘图标失败：{err}"))?;
    spawn_menu_updater(app);
    Ok(())
}

/// 菜单里「今天 N 条待办」：只统计今天到期且还没完成的待办项
fn today_todo_count(notes: &[Note]) -> usize {
    let (start, end) = today_range_ms();
    notes
        .iter()
        .flat_map(|note| note.todos.iter())
        .filter(|todo| !todo.done && todo.due_at.is_some_and(|at| at >= start && at < end))
        .count()
}

/// 本地时区「今天 0 点」到「明天 0 点」的毫秒时间戳。
///
/// 「明天 0 点」要按日历真实算（日期 +1 天再取 0 点），不能简单 start + 24h：
/// 夏令时切换那天只有 23 或 25 小时，写死 24h 会把边界算偏一小时。
fn today_range_ms() -> (i64, i64) {
    let now = Local::now();
    let today = now.date_naive();
    let start = local_midnight(today);
    let end = local_midnight(today + chrono::Days::new(1));
    match (start, end) {
        (Some(start), Some(end)) => (start, end),
        // 取不到「明天 0 点」的极端情况（时区数据异常）：退回今天 0 点 +24h
        (Some(start), None) => (start, start + 24 * 60 * 60 * 1000),
        // 连今天 0 点都取不到：退化成「从现在起 24 小时」，宁可数字不准也别 panic
        _ => {
            let now_ms = now.timestamp_millis();
            (now_ms, now_ms + 24 * 60 * 60 * 1000)
        }
    }
}

/// 某个日期在本地时区 0 点的毫秒时间戳（夏令时把 0 点跳过时取靠近 0 点的那一份）
fn local_midnight(date: chrono::NaiveDate) -> Option<i64> {
    match Local.with_ymd_and_hms(date.year(), date.month(), date.day(), 0, 0, 0) {
        chrono::LocalResult::Single(at) => Some(at.timestamp_millis()),
        chrono::LocalResult::Ambiguous(earliest, _) => Some(earliest.timestamp_millis()),
        chrono::LocalResult::None => None,
    }
}

/// 托盘里显示的便签标题：最多 18 个字，超出用省略号
fn short_title(note: &Note) -> String {
    let full = note.window_title();
    let mut chars: Vec<char> = full.chars().collect();
    if chars.len() <= 18 {
        return full;
    }
    chars.truncate(17);
    let mut text: String = chars.into_iter().collect();
    text.push('…');
    text
}

fn tooltip_text(app: &AppHandle) -> String {
    let notes = app.state::<Store>().all_notes();
    format!("小梦备忘录 · 今天 {} 条", today_todo_count(&notes))
}

/// 生成菜单：今天待办数（禁用项）+ 最近便签子菜单 + 原有操作项
fn build_menu(app: &AppHandle) -> Result<Menu<Wry>, String> {
    let notes = app.state::<Store>().all_notes();
    let today = today_todo_count(&notes);
    let today_text = if today == 0 {
        "今天没有待办".to_string()
    } else {
        format!("今天 {today} 条待办")
    };
    let today_item = MenuItemBuilder::new(today_text)
        .id("today_count")
        .enabled(false)
        .build(app)
        .map_err(|err| format!("创建「今天待办」菜单项失败：{err}"))?;

    let mut recent_builder = SubmenuBuilder::new(app, "最近便签");
    let mut recent = notes;
    recent.sort_by_key(|note| std::cmp::Reverse(note.updated_at));
    if recent.is_empty() {
        let empty = MenuItemBuilder::new("（还没有便签）")
            .id("recent_none")
            .enabled(false)
            .build(app)
            .map_err(|err| format!("创建「最近便签」占位项失败：{err}"))?;
        recent_builder = recent_builder.item(&empty);
    } else {
        for note in recent.iter().take(5) {
            let item = MenuItemBuilder::new(short_title(note))
                .id(format!("recent:{}", note.id))
                .build(app)
                .map_err(|err| format!("创建「最近便签」菜单项失败：{err}"))?;
            recent_builder = recent_builder.item(&item);
        }
    }
    let recent_menu = recent_builder
        .build()
        .map_err(|err| format!("创建「最近便签」子菜单失败：{err}"))?;

    MenuBuilder::new(app)
        .item(&today_item)
        .item(&recent_menu)
        .separator()
        .text("new_memo", "新建备忘")
        .text("new_todo", "新建待办")
        .separator()
        .text("show_all", "显示全部便签")
        .text("hide_all", "隐藏全部便签")
        .separator()
        .text("panel", "管理面板")
        .text("settings", "设置")
        .separator()
        .text("quit", "退出小梦备忘录")
        .build()
        .map_err(|err| format!("创建托盘菜单失败：{err}"))
}

/// 重建菜单（在主线程调用）
fn rebuild_menu(app: &AppHandle) -> Result<(), String> {
    let menu = build_menu(app)?;
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    tray.set_menu(Some(menu))
        .map_err(|err| format!("更新托盘菜单失败：{err}"))?;
    tray.set_tooltip(Some(tooltip_text(app)))
        .map_err(|err| format!("更新托盘提示文字失败：{err}"))?;
    Ok(())
}

/// 监听 notes-changed，节流 500ms 后重建托盘菜单。
/// 监听和节流都放在独立线程：菜单必须在主线程改，用 run_on_main_thread 派回去。
pub fn spawn_menu_updater(app: &AppHandle) {
    let listen_app = app.clone();
    let rebuild_app = app.clone();
    std::thread::spawn(move || {
        let (sender, receiver) = std::sync::mpsc::channel::<()>();
        listen_app.listen(crate::EVENT_NOTES_CHANGED, move |_event| {
            let _ = sender.send(());
        });
        while receiver.recv().is_ok() {
            // 500ms 内的多次变化合并成一次重建
            std::thread::sleep(Duration::from_millis(500));
            while receiver.try_recv().is_ok() {}
            let app = rebuild_app.clone();
            if let Err(err) = rebuild_app.run_on_main_thread(move || {
                if let Err(err) = rebuild_menu(&app) {
                    log_line(format!("重建托盘菜单失败：{err}"));
                }
            }) {
                log_line(format!("派发托盘菜单重建失败：{err}"));
            }
        }
    });
}

/// 托盘菜单点击。回调在主线程，所以建窗/改窗放到后台线程做。
fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let menu_id: &str = event.id().as_ref();
    let action = menu_id.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        // 「最近便签」的 id 形如 recent:note-xxx，先处理
        if let Some(id) = action.strip_prefix("recent:") {
            let id = id.to_string();
            let store = app.state::<Store>();
            if let Err(err) = store.set_hidden(&app, std::slice::from_ref(&id), false) {
                log_line(format!("显示最近便签失败：{err}"));
            }
            match store.note(&id) {
                Some(note) => {
                    if let Err(err) = windows::open_note_window(&app, &note, true) {
                        log_line(format!("打开最近便签失败：{err}"));
                    }
                }
                None => log_line(format!("最近便签已不存在：{id}")),
            }
            return;
        }
        match action.as_str() {
            "new_memo" => {
                let _ = create_and_open(&app, NoteKind::Memo);
            }
            "new_todo" => {
                let _ = create_and_open(&app, NoteKind::Todo);
            }
            "show_all" => windows::show_all_notes(&app),
            "hide_all" => windows::hide_all_notes(&app),
            "panel" => {
                if let Err(err) = windows::open_panel(&app) {
                    log_line(format!("打开面板失败：{err}"));
                }
            }
            "settings" => {
                if let Err(err) = windows::open_settings(&app) {
                    log_line(format!("打开设置失败：{err}"));
                }
            }
            "quit" => {
                // 退出前写盘失败时取消退出：宁可多点一次，也别把用户刚写的东西弄丢
                if let Err(err) = commands::quit_now(&app) {
                    log_line(format!("退出失败：{err}"));
                }
            }
            other => log_line(format!("未知托盘菜单项：{other}")),
        }
    });
}

/// 托盘里「新建」：建一条并打开窗口、聚焦，方便马上打字
fn create_and_open(app: &AppHandle, kind: NoteKind) -> Result<(), String> {
    let store = app.state::<Store>();
    let note = store.create_note(app, kind, None)?;
    windows::open_note_window(app, &note, true)?;
    Ok(())
}

/// 托盘图标点击：左键单击打开面板
fn on_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        let app = tray.app_handle().clone();
        std::thread::spawn(move || {
            if let Err(err) = windows::open_panel(&app) {
                log_line(format!("打开面板失败：{err}"));
            }
        });
    }
}

/// 按设置显示/隐藏托盘图标
pub fn set_visible(app: &AppHandle, visible: bool) {
    match app.tray_by_id(TRAY_ID) {
        Some(tray) => {
            if let Err(err) = tray.set_visible(visible) {
                log_line(format!("切换托盘图标显示失败：{err}"));
            }
        }
        None => log_line("托盘图标尚未创建，忽略显示/隐藏请求"),
    }
}
