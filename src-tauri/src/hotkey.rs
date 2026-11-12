//! 全局快捷键：Ctrl+Alt+N 新建备忘、Ctrl+Alt+M 打开管理面板、Ctrl+Alt+Space 快速记录
//! （三个都能在设置里改，改成空串表示不启用）。

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::log_line;
use crate::model::{NoteKind, Settings};
use crate::store::Store;
use crate::windows;

/// 注册（或重新注册）全部全局快捷键：先全部注销，再按设置逐个注册。
/// 空字符串表示「这个快捷键不启用」。
pub fn apply_all(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let manager = app.global_shortcut();
    if let Err(err) = manager.unregister_all() {
        // 注销失败不致命，继续尝试注册
        log_line(format!("注销旧快捷键失败：{err}"));
    }
    // 三个快捷键如果被写成同一个组合，只注册一次，否则后面的必定注册失败
    let mut seen: Vec<String> = Vec::new();
    let entries = [
        (settings.hotkey_new_note.trim(), "新建便签"),
        (settings.hotkey_show_panel.trim(), "打开面板"),
        (settings.hotkey_quick.trim(), "快速记录"),
    ];
    for (accel, what) in entries {
        if accel.is_empty() || seen.iter().any(|registered| registered.as_str() == accel) {
            continue;
        }
        register_one(app, accel, what)?;
        seen.push(accel.to_string());
    }
    Ok(())
}

fn register_one(app: &AppHandle, accel: &str, what: &str) -> Result<(), String> {
    let accel = accel.trim();
    if accel.is_empty() {
        return Ok(());
    }
    // 先解析一次：写法不对的组合同样在这里就报给用户，别让人按了没反应
    accel
        .parse::<Shortcut>()
        .map_err(|err| format!("{what}快捷键「{accel}」写法不对：{err}"))?;
    app.global_shortcut()
        .register(accel)
        .map_err(|err| format!("{what}快捷键「{accel}」注册失败，可能被其他软件占用：{err}"))
}

/// 插件回调：先认出按下的是哪个快捷键，再分发；只响应按下（不是松开）
pub fn on_hotkey_state(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let settings = app.state::<Store>().settings();
    let note: Option<Shortcut> = settings.hotkey_new_note.trim().parse().ok();
    let panel: Option<Shortcut> = settings.hotkey_show_panel.trim().parse().ok();
    let quick: Option<Shortcut> = settings.hotkey_quick.trim().parse().ok();
    if note.as_ref() == Some(shortcut) {
        on_hotkey_pressed(app);
    } else if panel.as_ref() == Some(shortcut) {
        on_panel_pressed(app);
    } else if quick.as_ref() == Some(shortcut) {
        on_quick_pressed(app);
    }
}

/// 按「新建」快捷键：在鼠标所在位置新建备忘并显示（不抢焦点，避免打断当前工作）
pub fn on_hotkey_pressed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let store = app.state::<Store>();
        let at = cursor_logical(&app);
        let note = match store.create_note(&app, NoteKind::Memo, at) {
            Ok(note) => note,
            Err(err) => {
                log_line(format!("快捷键新建便签失败：{err}"));
                return;
            }
        };
        if let Err(err) = windows::open_note_window(&app, &note, false) {
            log_line(format!("快捷键打开便签窗口失败：{err}"));
        }
    });
}

/// 按「面板」快捷键：打开管理面板并聚焦。
/// 用户是按快捷键主动要它，所以这一次要抢焦点（和便签的「不抢焦点」相反）。
pub fn on_panel_pressed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = windows::open_panel(&app) {
            log_line(format!("快捷键打开面板失败：{err}"));
        }
    });
}

/// 按「快速记录」快捷键：弹出置顶小条，用户打字回车就存成便签
pub fn on_quick_pressed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = windows::open_quick(&app) {
            log_line(format!("快捷键打开快速记录失败：{err}"));
        }
    });
}

/// 鼠标位置换算成逻辑坐标（多显示器 / 高 DPI 下也能落对位置）
fn cursor_logical(app: &AppHandle) -> Option<(f64, f64)> {
    let cursor = app.cursor_position().ok()?;
    let mut scale = 1.0;
    if let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) {
        let factor = monitor.scale_factor();
        if factor > 0.0 {
            scale = factor;
        }
    }
    Some((cursor.x / scale, cursor.y / scale))
}
