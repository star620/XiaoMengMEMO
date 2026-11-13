//! 给前端的命令（名字与参数必须和 src/shared/api.ts 完全一致）。
//! 会创建窗口的命令用 async：Tauri 会把它放到工作线程，避免和 WebView2 抢主线程。

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::hotkey;
use crate::log_line;
use crate::model::{Note, NoteKind, Point, Settings, Snapshot, TrashItem, WindowState};
use crate::reminder;
use crate::store::{ImportResult, Store, VersionDetail, VersionMeta};
use crate::tray;
use crate::windows;

// ---------- 数据 ----------

#[tauri::command]
pub fn get_snapshot(app: AppHandle) -> Snapshot {
    app.state::<Store>().snapshot()
}

#[tauri::command]
pub fn save_note(app: AppHandle, note: Note) -> Result<Note, String> {
    app.state::<Store>().save_note(&app, note)
}

#[tauri::command]
pub async fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    reminder::clear_if_showing(&app, &id);
    let store = app.state::<Store>();
    let removed = store.delete_note(&app, &id)?;
    if removed {
        windows::destroy_note_window(&app, &id);
    }
    Ok(())
}

#[tauri::command]
pub async fn create_note(
    app: AppHandle,
    kind: NoteKind,
    at: Option<Point>,
) -> Result<Note, String> {
    let store = app.state::<Store>();
    let point = at.map(|point| (point.x, point.y));
    let note = store.create_note(&app, kind, point)?;
    windows::open_note_window(&app, &note, true)?;
    Ok(note)
}

// ---------- 回收站 ----------

#[tauri::command]
pub fn list_trash(app: AppHandle) -> Vec<TrashItem> {
    app.state::<Store>().list_trash()
}

#[tauri::command]
pub fn restore_note(app: AppHandle, id: String) -> Result<Note, String> {
    app.state::<Store>().restore_note(&app, &id)
}

#[tauri::command]
pub fn empty_trash(app: AppHandle) -> Result<usize, String> {
    app.state::<Store>().empty_trash()
}

// ---------- 窗口 ----------

#[tauri::command]
pub async fn open_note_window(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Store>();
    let note = store.note(&id).ok_or_else(|| format!("便签不存在：{id}"))?;
    windows::open_note_window(&app, &note, true)?;
    Ok(())
}

#[tauri::command]
pub fn close_note_window(app: AppHandle, id: String) -> Result<(), String> {
    windows::hide_note_window(&app, &id)
}

#[tauri::command]
pub fn save_window_state(app: AppHandle, id: String, state: WindowState) -> Result<(), String> {
    app.state::<Store>().save_window_state(&app, &id, state)
}

#[tauri::command]
pub fn set_pinned(app: AppHandle, id: String, pinned: bool) -> Result<(), String> {
    let store = app.state::<Store>();
    store.set_pinned(&app, &id, pinned)?;
    if let Some(window) = app.get_webview_window(&windows::note_label(&id)) {
        if let Err(err) = window.set_always_on_top(pinned) {
            log_line(format!("设置窗口置顶失败：{err}"));
        }
    }
    Ok(())
}

/// 折叠 / 展开便签：数据落库 + 立刻调整窗口高度
#[tauri::command]
pub async fn set_note_collapsed(
    app: AppHandle,
    id: String,
    collapsed: bool,
) -> Result<Note, String> {
    let store = app.state::<Store>();
    let window = app.get_webview_window(&windows::note_label(&id));
    let change = window
        .as_ref()
        .map(|window| windows::begin_size_change(window.label()));
    // 只有稳定窗口能提供展开高度；动画中连点时以 Store 中的目标尺寸为准。
    let expanded_height = window
        .as_ref()
        .filter(|_| change.as_ref().is_some_and(|change| !change.was_changing()))
        .and_then(|window| {
            let scale = window
                .scale_factor()
                .ok()
                .filter(|s| *s > 0.0)
                .unwrap_or(1.0);
            window
                .inner_size()
                .ok()
                .map(|size| size.height as f64 / scale)
        });
    let note = store.set_collapsed(&app, &id, collapsed, expanded_height)?;
    if let Some(window) = window {
        let width = note.width.unwrap_or(windows::DEFAULT_WIDTH);
        let height = note
            .height
            .unwrap_or(windows::DEFAULT_HEIGHT)
            .max(windows::MIN_HEIGHT);
        windows::apply_collapsed(&window, collapsed, width, height);
    }
    Ok(note)
}

/// 三档尺寸：数据落库 + 立刻调整窗口大小
#[tauri::command]
pub async fn set_note_size(
    app: AppHandle,
    id: String,
    width: f64,
    height: f64,
) -> Result<Note, String> {
    let store = app.state::<Store>();
    let window = app.get_webview_window(&windows::note_label(&id));
    let _change = window
        .as_ref()
        .map(|window| windows::begin_size_change(window.label()));
    let note = store.set_note_size(&app, &id, width, height)?;
    if let Some(window) = window {
        let visible_height = if note.collapsed {
            windows::COLLAPSED_HEIGHT
        } else {
            height
        };
        windows::apply_size(&window, width, visible_height);
    }
    Ok(note)
}

/// 锁定 / 解锁便签：数据落库（正文保护在 store::save_note 里做）
#[tauri::command]
pub async fn set_note_locked(app: AppHandle, id: String, locked: bool) -> Result<Note, String> {
    let store = app.state::<Store>();
    store.set_locked(&app, &id, locked)
}

/// 导出全部便签到桌面（.md + .json），返回 .md 文件路径
#[tauri::command]
pub async fn export_notes(app: AppHandle) -> Result<String, String> {
    app.state::<Store>().export_notes()
}

/// 用每日备份整体恢复便签列表，返回恢复条数
#[tauri::command]
pub fn restore_from_backup(app: AppHandle) -> Result<usize, String> {
    app.state::<Store>().restore_from_backup(&app)
}

// ---------- 修改记录（版本历史） ----------

/// 某张便签的历史版本摘要（最新在前）
#[tauri::command]
pub fn list_note_versions(app: AppHandle, id: String) -> Result<Vec<VersionMeta>, String> {
    app.state::<Store>().list_note_versions(&id)
}

/// 读某个历史版本的完整内容（前端点开某一版时用）
#[tauri::command]
pub fn get_note_version(app: AppHandle, id: String, ts: i64) -> Result<VersionDetail, String> {
    app.state::<Store>().get_note_version(&id, ts)
}

/// 把便签恢复到某个历史版本，返回恢复后的便签
#[tauri::command]
pub fn restore_note_version(app: AppHandle, id: String, ts: i64) -> Result<Note, String> {
    app.state::<Store>().restore_note_version(&app, &id, ts)
}

/// 导入备份文件：弹系统「打开文件」框挑一个 .json，合并导入（同 id 跳过）
/// 返回 None 表示用户取消了选择，前端静默处理即可
#[tauri::command]
pub async fn import_notes_file(app: AppHandle) -> Result<Option<ImportResult>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .set_title("导入小梦备忘录备份")
        .add_filter("小梦备忘录备份", &["json"])
        .blocking_pick_file();
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|err| format!("读不到这个文件：{err}"))?;
    let text = std::fs::read_to_string(&path).map_err(|err| format!("读不到这个文件：{err}"))?;
    let result = app.state::<Store>().import_notes(&app, &text)?;
    Ok(Some(result))
}

#[tauri::command]
pub async fn open_panel(app: AppHandle) -> Result<(), String> {
    windows::open_panel(&app).map(|_| ())
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    windows::open_settings(&app).map(|_| ())
}

#[tauri::command]
pub async fn open_quick(app: AppHandle) -> Result<(), String> {
    windows::open_quick(&app).map(|_| ())
}

#[tauri::command]
pub fn close_quick(app: AppHandle) -> Result<(), String> {
    windows::close_quick(&app);
    Ok(())
}

// ---------- 提醒 ----------

#[tauri::command]
pub fn set_reminder(app: AppHandle, id: String, at: Option<i64>) -> Result<(), String> {
    reminder::clear_if_showing(&app, &id);
    app.state::<Store>().set_reminder(&app, &id, at)
}

#[tauri::command]
pub fn snooze_reminder(app: AppHandle, id: String, minutes: i64) -> Result<(), String> {
    reminder::clear_if_showing(&app, &id);
    app.state::<Store>().snooze_reminder(&app, &id, minutes)
}

#[tauri::command]
pub fn dismiss_reminder(app: AppHandle, id: String) -> Result<(), String> {
    reminder::clear_if_showing(&app, &id);
    app.state::<Store>().dismiss_reminder(&app, &id)
}

// ---------- 设置 / 开机自启 / 数据目录 / 退出 ----------

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let store = app.state::<Store>();
    let previous = store.settings();
    // 先校验纸色，避免因为一个非法值把快捷键重新注册一遍
    let theme = settings.theme_mode.trim().to_ascii_lowercase();
    if !theme.is_empty() && !matches!(theme.as_str(), "auto" | "day" | "night") {
        return Err("纸色设置只能是 auto / day / night（跟随时间 / 浅色 / 深色）".to_string());
    }
    // 三个快捷键一起重新注册：任何注册失败就整单拒绝，别出现「一半改了、一半没改」
    if let Err(err) = hotkey::apply_all(&app, &settings) {
        if let Err(restore_err) = hotkey::apply_all(&app, &previous) {
            log_line(format!("恢复旧快捷键失败：{restore_err}"));
        }
        return Err(err);
    }
    let saved = match store.save_settings(&app, settings) {
        Ok(saved) => saved,
        Err(err) => {
            if let Err(restore_err) = hotkey::apply_all(&app, &previous) {
                log_line(format!("恢复旧快捷键失败：{restore_err}"));
            }
            return Err(err);
        }
    };
    // 自启状态以设置页为准，这里同步给系统
    if saved.launch_on_startup != previous.launch_on_startup {
        if let Err(err) = apply_autostart(&app, saved.launch_on_startup) {
            log_line(format!("同步开机自启失败：{err}"));
        }
    }
    tray::set_visible(&app, saved.show_tray);
    Ok(saved)
}

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> bool {
    match app.autolaunch().is_enabled() {
        Ok(enabled) => enabled,
        Err(err) => {
            log_line(format!("读取开机自启状态失败：{err}"));
            false
        }
    }
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let enabled = apply_autostart(&app, enabled)?;
    // 顺手同步到设置里，避免设置页和系统状态不一致
    let store = app.state::<Store>();
    let mut settings = store.settings();
    if settings.launch_on_startup != enabled {
        settings.launch_on_startup = enabled;
        if let Err(err) = store.save_settings(&app, settings) {
            log_line(format!("保存开机自启设置失败：{err}"));
        }
    }
    Ok(enabled)
}

/// 真正去改系统里的开机自启，返回改完之后的实际状态
pub fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|err| format!("开启开机自启失败：{err}"))?;
    } else {
        manager
            .disable()
            .map_err(|err| format!("关闭开机自启失败：{err}"))?;
    }
    manager
        .is_enabled()
        .map_err(|err| format!("读取开机自启状态失败：{err}"))
}

#[tauri::command]
pub fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let dir = app.state::<Store>().dir().to_path_buf();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        log_line(format!("创建数据目录失败：{err}"));
    }
    std::process::Command::new("explorer.exe")
        .arg(&dir)
        .spawn()
        .map_err(|err| format!("打开数据目录失败：{err}"))?;
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), String> {
    quit_now(&app)
}

/// 退出应用：先把内存里的改动写盘，写不进去就**不退出**，把错误交给前端提示。
///
/// 以前这里写盘失败只打日志、照样 exit(0)，用户最后几分钟的改动会悄悄丢掉；
/// 现在失败会重试一次，还失败就返回 Err（前端弹个提示），数据比"关得爽快"重要。
pub fn quit_now(app: &AppHandle) -> Result<(), String> {
    if let Some(store) = app.try_state::<Store>() {
        if let Err(first_err) = store.flush() {
            log_line(format!("退出前写盘失败，稍后重试一次：{first_err}"));
            // 给占用文件的程序（杀毒/索引）一点时间松手，再试一次
            std::thread::sleep(std::time::Duration::from_millis(120));
            if let Err(second_err) = store.flush() {
                log_line(format!("退出前写盘再次失败，已取消退出：{second_err}"));
                return Err(format!("保存失败，先不退出，免得丢数据：{second_err}"));
            }
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // 留一点时间让前端把未发完的保存请求发过来
        std::thread::sleep(std::time::Duration::from_millis(150));
        app.exit(0);
    });
    Ok(())
}
