//! 全局快捷键：Ctrl+Alt+N 新建备忘、Ctrl+Alt+M 打开管理面板、Ctrl+Alt+Space 快速记录
//! （三个都能在设置里改，改成空串表示不启用）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::log_line;
use crate::model::{NoteKind, Settings};
use crate::store::Store;
use crate::windows;

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
static FAILURE_VISIBLE: AtomicBool = AtomicBool::new(false);
// 三个动作各自去重，不能让「打开面板」吞掉紧接着的「新建」。
static LAST_PRESS: Mutex<[Option<Instant>; 3]> = Mutex::new([None; 3]);
const DEDUPE_WINDOW: Duration = Duration::from_millis(300);

fn accept_press(last: &mut Option<Instant>, received: Instant) -> Result<(), Duration> {
    if let Some(previous) = *last {
        let elapsed = received.saturating_duration_since(previous);
        if elapsed < DEDUPE_WINDOW {
            // 忽略的按键不延长窗口，300ms 从上次接受的请求开始算。
            return Err(elapsed);
        }
    }
    *last = Some(received);
    Ok(())
}

struct HotkeyTrace {
    request: u64,
    started: Instant,
}

impl HotkeyTrace {
    fn log(&self, stage: impl AsRef<str>) {
        crate::boot_log(&format!(
            "hotkey req={} elapsed_ms={} {}",
            self.request,
            self.started.elapsed().as_millis(),
            stage.as_ref()
        ));
    }
}

pub(crate) fn show_failure(app: &AppHandle, message: &str) {
    if FAILURE_VISIBLE.swap(true, Ordering::Relaxed) {
        return;
    }
    app.dialog()
        .message(message)
        .title("小梦备忘录")
        .kind(MessageDialogKind::Error)
        .show(|_| FAILURE_VISIBLE.store(false, Ordering::Relaxed));
}

pub fn report_registration_failure(app: &AppHandle, error: &str) {
    log_line(format!("默认快捷键注册失败：{error}"));
    show_failure(
        app,
        "有些快捷键暂时没能启用，可能正被其他程序使用。\n可以从托盘打开设置，换一个组合再试。",
    );
}

/// 启动失败的后台实例把快捷键还回去，别让下一次正常启动注册不上。
pub fn release_all(app: &AppHandle) {
    if let Err(err) = app.global_shortcut().unregister_all() {
        log_line(format!("释放快捷键失败：{err}"));
    }
}

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
    let mut errors = Vec::new();
    let entries = [
        (settings.hotkey_new_note.trim(), "新建便签"),
        (settings.hotkey_show_panel.trim(), "打开面板"),
        (settings.hotkey_quick.trim(), "快速记录"),
    ];
    for (accel, what) in entries {
        if accel.is_empty() || seen.iter().any(|registered| registered.as_str() == accel) {
            continue;
        }
        seen.push(accel.to_string());
        if let Err(err) = register_one(app, accel, what) {
            errors.push(err);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
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
        .map_err(|err| format!("{what}快捷键「{accel}」注册失败，可能被其他软件占用：{err}"))?;
    crate::boot_log(&format!("hotkey registered action={what} shortcut={accel}"));
    Ok(())
}

/// 插件回调：先认出按下的是哪个快捷键，再分发；只响应按下（不是松开）
pub fn on_hotkey_state(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let trace = HotkeyTrace {
        request: NEXT_REQUEST.fetch_add(1, Ordering::Relaxed),
        started: Instant::now(),
    };
    // 必须先于 settings() 的 Store 锁：没有后续记录时才能区分等锁和没收到按键。
    trace.log(format!("received shortcut={shortcut:?}"));
    let settings = app.state::<Store>().settings();
    trace.log("settings_loaded");
    let note: Option<Shortcut> = settings.hotkey_new_note.trim().parse().ok();
    let panel: Option<Shortcut> = settings.hotkey_show_panel.trim().parse().ok();
    let quick: Option<Shortcut> = settings.hotkey_quick.trim().parse().ok();
    let action = if note.as_ref() == Some(shortcut) {
        0
    } else if panel.as_ref() == Some(shortcut) {
        1
    } else if quick.as_ref() == Some(shortcut) {
        2
    } else {
        trace.log("ignored: shortcut does not match current settings");
        return;
    };
    let accepted = {
        let mut last = LAST_PRESS.lock().unwrap_or_else(|p| p.into_inner());
        accept_press(&mut last[action], trace.started)
    };
    if let Err(elapsed) = accepted {
        trace.log(format!(
            "dedupe: ignore action={action} since_accepted_ms={}",
            elapsed.as_millis()
        ));
        return;
    }
    if action == 0 {
        trace.log("dispatch=new_note");
        on_hotkey_pressed(app, trace);
    } else if action == 1 {
        on_panel_pressed(app);
    } else {
        on_quick_pressed(app);
    }
}

/// 用户主动按「新建」快捷键：新建后提到前台，方便马上开始写。
fn on_hotkey_pressed(app: &AppHandle, trace: HotkeyTrace) {
    let app = app.clone();
    std::thread::spawn(move || {
        trace.log("worker_started");
        let store = app.state::<Store>();
        let at = cursor_logical(&app);
        trace.log(format!("create_note begin at={at:?}"));
        let note = match store.create_note(&app, NoteKind::Memo, at) {
            Ok(note) => note,
            Err(err) => {
                trace.log(format!("create_note failed: {err}"));
                log_line(format!(
                    "快捷键新建便签失败（req={}）：{err}",
                    trace.request
                ));
                show_failure(&app, "这次没能保存便签，请稍后再试。\n具体原因已记入日志。");
                return;
            }
        };
        trace.log(format!("create_note done note={}", note.id));
        match windows::open_note_window(&app, &note, true) {
            Ok(window) => trace.log(format!(
                "open_note done note={} visible={:?} minimized={:?} focused={:?} pos={:?} size={:?}",
                note.id,
                window.is_visible(),
                window.is_minimized(),
                window.is_focused(),
                window.outer_position(),
                window.inner_size()
            )),
            Err(err) => {
                trace.log(format!("open_note failed note={}: {err}", note.id));
                log_line(format!("快捷键打开便签窗口失败（req={}）：{err}", trace.request));
                show_failure(
                    &app,
                    "便签已经记下了，这次没能显示出来。\n可以从托盘打开管理面板，找到刚才的便签。",
                );
            }
        }
    });
}

/// 按「面板」快捷键：打开管理面板并聚焦。
/// 用户主动打开的窗口需要提到前台。
pub fn on_panel_pressed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = windows::open_panel(&app) {
            log_line(format!("快捷键打开面板失败：{err}"));
            show_failure(
                &app,
                "这次没能打开管理面板，请从托盘再试一次。\n具体原因已记入日志。",
            );
        }
    });
}

/// 按「快速记录」快捷键：弹出置顶小条，用户打字回车就存成便签
pub fn on_quick_pressed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = windows::open_quick(&app) {
            log_line(format!("快捷键打开快速记录失败：{err}"));
            show_failure(
                &app,
                "这次没能打开快速记录，请稍后再试。\n具体原因已记入日志。",
            );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn notes_from_presses(offsets_ms: &[u64]) -> Vec<crate::model::Note> {
        let start = Instant::now();
        let mut last = None;
        offsets_ms
            .iter()
            .filter_map(|ms| {
                accept_press(&mut last, start + Duration::from_millis(*ms))
                    .ok()
                    .map(|()| crate::model::Note::new(NoteKind::Memo, "yellow", 1.0, None))
            })
            .collect()
    }

    #[test]
    fn 双按只新建一张而四百毫秒后可再建() {
        assert_eq!(notes_from_presses(&[0, 100]).len(), 1);
        assert_eq!(notes_from_presses(&[0, 400]).len(), 2);
    }

    #[test]
    fn 忽略请求不延长窗口且三百毫秒边界接受() {
        assert_eq!(notes_from_presses(&[0, 100, 200, 299, 300]).len(), 2);
    }

    #[test]
    fn 不同动作交替按各自去重() {
        let start = Instant::now();
        let mut last = [None; 3];
        assert!(accept_press(&mut last[0], start).is_ok());
        assert!(accept_press(&mut last[1], start + Duration::from_millis(50)).is_ok());
        assert!(accept_press(&mut last[2], start + Duration::from_millis(75)).is_ok());
        assert!(accept_press(&mut last[0], start + Duration::from_millis(100)).is_err());
    }
}
