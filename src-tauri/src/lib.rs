//! 小梦备忘录 · Rust 后端入口。
//! 这里只做「装配」：初始化数据仓库、托盘、快捷键、提醒线程，并把全部命令和窗口事件接好。
//! 具体实现分在 model / store / windows / tray / hotkey / reminder / commands 七个模块里。

pub mod commands;
pub mod hotkey;
pub mod model;
pub mod reminder;
mod size_probe;
pub mod startup;
pub mod store;
pub mod tray;
pub mod windows;

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::store::Store;

/// 事件名（和前端约定，不能改）
pub const EVENT_NOTES_CHANGED: &str = "notes-changed";
pub const EVENT_SETTINGS_CHANGED: &str = "settings-changed";
pub const EVENT_REMINDER_DUE: &str = "reminder-due";
pub const EVENT_NOTE_FOCUS: &str = "note-focus";

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static BOOT_LOG_PATHS: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// 启动日志的候选路径：exe 同目录 / %TEMP% / %APPDATA%\XiaoMengMemo。
/// 刻意不写桌面：桌面是用户自己的地方，程序往那儿丢日志既脏又容易被当成可疑文件。
/// 不同启动方式（资源管理器、计划任务、WMI）环境变量残缺，只有 exe 同目录几乎总是可写，
/// 所以这里同时写多处，任一成功即可诊断启动卡在哪一步。
fn boot_log_paths() -> &'static Vec<PathBuf> {
    BOOT_LOG_PATHS.get_or_init(|| {
        let mut paths: Vec<PathBuf> = Vec::new();
        if let Some(path) = exe_boot_log_path() {
            paths.push(path);
        }
        paths.push(std::env::temp_dir().join("xiaomeng-boot.log"));
        if let Ok(appdata) = std::env::var("APPDATA") {
            paths.push(PathBuf::from(appdata).join("XiaoMengMemo").join("boot.log"));
        }
        paths
    })
}

/// 启动阶段诊断日志：同时写 exe 同目录、%TEMP%、%APPDATA%\XiaoMengMemo。
/// 启动卡住/闪退时，这是唯一能看到进度的地方（用户在普通桌面双击时看不到控制台）。
pub fn boot_log(message: &str) {
    for path in boot_log_paths() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        rotate_log_if_large(path);
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "[{}] {}", crate::model::now_ms(), message);
            let _ = file.flush();
        }
    }
}

/// 统一日志：控制台 + 数据目录下的 app.log。
/// 出错只记录、不 panic，保证用户（编程小白）不会看到崩溃。
pub fn log_line(message: impl AsRef<str>) {
    let message = message.as_ref();
    eprintln!("[小梦备忘录] {message}");
    // 启动阶段的错误也要进启动日志：用户从桌面双击时看不到控制台，否则失败了像"没反应"
    boot_log(&format!("log: {message}"));
    let path = LOG_PATH.get_or_init(|| store::data_dir().join("app.log"));
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    rotate_log_if_large(path);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "[{stamp}] {message}");
    }
}

/// app.log 超过 1MB 就改名成 app.log.old（只留一份旧的），避免日志无限长下去。
/// 轮转失败无所谓，下次写日志时还会再试。
fn rotate_log_if_large(path: &std::path::Path) {
    const MAX_LOG_BYTES: u64 = 1024 * 1024;
    let too_big = std::fs::metadata(path)
        .map(|meta| meta.len() > MAX_LOG_BYTES)
        .unwrap_or(false);
    if !too_big {
        return;
    }
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "app.log".to_string());
    let old = path.with_file_name(format!("{file_name}.old"));
    let _ = std::fs::remove_file(&old);
    let _ = std::fs::rename(path, &old);
}

/// exe 同目录的启动日志：用户最容易找到、也几乎总能写成功的一份
fn exe_boot_log_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("xiaomeng-boot.log")))
}

/// 启动后一个窗口都没能创建出来时的兜底提示。
/// 桌面双击运行时没有控制台，静默失败用户只会觉得「点了没反应」，所以这里弹一个原生中文消息框。
fn show_startup_failure(app: &AppHandle, data_dir: &std::path::Path) {
    let data_dir = data_dir.display().to_string();
    let log_path = exe_boot_log_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "（找不到启动日志，试试 %TEMP%\\xiaomeng-boot.log）".to_string());
    boot_log(&format!(
        "setup: 没有任何窗口创建成功，弹出提示框 data_dir={data_dir} log={log_path}"
    ));
    let text = format!(
        "小梦备忘录没能打开任何窗口。\n\n数据目录：{data_dir}\n启动日志：{log_path}\n\n关闭此提示后程序会退出。请将发布包完整解压到普通应用目录，再使用随附启动脚本重试；如果仍然失败，请保留启动日志。"
    );
    // 放到独立线程：消息框是阻塞的，别卡住主事件循环和托盘
    let app = app.clone();
    std::thread::spawn(move || {
        native_message_box("小梦备忘录 · 启动失败", &text);
        boot_log("setup: 启动失败提示框已关闭，退出以释放单实例和快捷键");
        app.exit(1);
    });
}

/// 调用系统原生消息框（不引新依赖，直接调 user32 的 MessageBoxW）
#[cfg(windows)]
fn native_message_box(caption: &str, text: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            utype: u32,
        ) -> i32;
    }

    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;
    const MB_TOPMOST: u32 = 0x0004_0000;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;

    // UTF-16 + 结尾 0（Windows API 要的是以 0 结尾的宽字符串）
    fn to_wide(value: &str) -> Vec<u16> {
        let mut wide: Vec<u16> = value.encode_utf16().collect();
        wide.push(0);
        wide
    }

    let text = to_wide(text);
    let caption = to_wide(caption);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR | MB_TOPMOST | MB_SETFOREGROUND,
        );
    }
}

#[cfg(not(windows))]
fn native_message_box(caption: &str, text: &str) {
    eprintln!("[{caption}] {text}");
}

pub fn run() {
    // panic 也要留痕：tray 常驻应用没有控制台，panic 信息否则彻底丢失
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        boot_log(&format!("PANIC: {info}"));
        previous_hook(info);
    }));
    boot_log("run: enter");
    // 环境快照：不同启动方式（双击 exe / .cmd / 计划任务）拿到的账户、权限、环境变量完全不同，
    // 用户报"打不开"时，这一行能立刻分辨是环境问题还是代码问题。
    // 环境快照里刻意不写用户名等个人信息：日志可能被用户发给别人排错，只留排障必需的路径
    boot_log(&format!(
        "env: pid={} exe={} appdata={} temp={}",
        std::process::id(),
        std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "?".into()),
        std::env::var("APPDATA").unwrap_or_else(|_| "?".into()),
        std::env::temp_dir().display()
    ));
    if let Some(message) = startup::launch_restriction() {
        boot_log("startup: 受限启动，拒绝切换数据目录或进入常驻状态");
        native_message_box("小梦备忘录 · 启动方式受限", message);
        std::process::exit(1);
    }
    let app = tauri::Builder::default()
        // 单实例必须第一个注册：第二次双击图标时唤起已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(err) = windows::open_panel(&app) {
                    log_line(format!("单实例唤起面板失败：{err}"));
                    hotkey::show_failure(
                        &app,
                        "程序已经在运行，但这次没能显示管理面板。\n请从托盘退出后，用随程序提供的启动脚本重新打开。具体原因已记入日志。",
                    );
                }
            });
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    hotkey::on_hotkey_state(app, shortcut, event.state());
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // 提醒兜底：Windows 系统通知（通知中心里也能回看）
        .plugin(tauri_plugin_notification::init())
        // 导入备份：系统「打开文件」对话框
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            boot_log("setup: enter");
            let handle = app.handle().clone();

            // 数据仓库：读盘 → 首次运行写默认数据
            boot_log("setup: opening store");
            let store = Store::open();
            let settings = store.settings();
            let notes = store.restore_notes();
            boot_log(&format!(
                "setup: store ready, notes={}, first_run_done={}",
                notes.len(),
                settings.first_run_done
            ));
            app.manage(store);

            if let Err(err) = tray::create(&handle) {
                log_line(format!("托盘创建失败：{err}"));
            }
            boot_log("setup: tray done");
            if settings.launch_on_startup {
                if let Err(err) = commands::apply_autostart(&handle, true) {
                    log_line(format!("同步开机自启失败：{err}"));
                }
            }
            tray::set_visible(&handle, settings.show_tray);

            // 恢复上次没关掉的便签窗口（这里在 setup 里建窗是官方推荐做法）
            // 同时数一下到底有几个窗口真的起来了：一个都没有就是致命失败，后面要告诉用户
            let mut visible_windows = 0usize;
            for note in notes.iter() {
                match windows::open_note_window(&handle, note, false) {
                    Ok(_) => visible_windows += 1,
                    Err(err) => log_line(format!("恢复便签窗口失败（{}）：{err}", note.id)),
                }
            }

            if !settings.first_run_done {
                // 首次启动：给一张欢迎便签 + 面板，让用户一打开就知道怎么用（不再先弹设置表单）
                let mut welcome = None;
                if notes.is_empty() {
                    match handle.state::<Store>().seed_welcome_note(&handle) {
                        Ok(note) => welcome = Some(note),
                        Err(err) => log_line(format!("创建欢迎便签失败：{err}")),
                    }
                }
                // 先开面板垫在下面，再开欢迎便签并聚焦：用户第一眼看到的是便签
                match windows::open_panel(&handle) {
                    Ok(_) => visible_windows += 1,
                    Err(err) => log_line(format!("打开管理面板失败：{err}")),
                }
                if let Some(note) = welcome.as_ref() {
                    match windows::open_note_window(&handle, note, true) {
                        Ok(_) => visible_windows += 1,
                        Err(err) => log_line(format!("打开欢迎便签窗口失败：{err}")),
                    }
                }
                // 首启标记立刻写回：设置页不再自动弹，用户需要时自己从托盘/面板打开
                if visible_windows > 0 {
                    let mut updated = settings.clone();
                    updated.first_run_done = true;
                    if let Err(err) = handle.state::<Store>().save_settings(&handle, updated) {
                        log_line(format!("写入首启标记失败：{err}"));
                    }
                }
            } else if notes.is_empty() {
                // 老用户把便签都删光了：给个面板，别让屏幕上什么都没有
                match windows::open_panel(&handle) {
                    Ok(_) => visible_windows += 1,
                    Err(err) => log_line(format!("打开管理面板失败：{err}")),
                }
            }

            // 一个窗口都没起来 = 用户屏幕上什么都没有，只能弹消息框（日志、数据目录一起给）
            if visible_windows == 0 {
                show_startup_failure(&handle, &store::data_dir());
                return Ok(());
            }

            // 窗口可用后再注册；启动失败的后台实例不能占住快捷键。
            if let Err(err) = hotkey::apply_all(&handle, &settings) {
                hotkey::report_registration_failure(&handle, &err);
            }

            reminder::spawn(&handle);
            // 吸边对齐的轮询线程：便签被拖动后静默 120ms 再吸附
            windows::spawn_snap_worker(&handle);
            boot_log("setup: done");
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let label = window.label().to_string();
            match event {
                WindowEvent::Moved(_) => {
                    size_probe::window_event(&label, "moved");
                    if windows::is_note_window(&label) {
                        if let Some(store) = app.try_state::<Store>() {
                            windows::capture_geometry(window, &store);
                        }
                        // 只记「刚动过」，真正的吸附由工作线程等 120ms 静默后做
                        windows::mark_moved(&label);
                    }
                }
                WindowEvent::Resized(_) => {
                    size_probe::window_event(&label, "resized");
                    if windows::is_note_window(&label) {
                        if let Some(store) = app.try_state::<Store>() {
                            windows::capture_geometry(window, &store);
                        }
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // 关闭窗口 ≠ 退出应用：便签/面板/设置都是隐藏，托盘常驻
                    api.prevent_close();
                    if windows::is_note_window(&label) {
                        if let Some(store) = app.try_state::<Store>() {
                            windows::capture_geometry(window, &store);
                        }
                        if let Some(id) = windows::note_id_from_label(&label) {
                            if let Err(err) = windows::hide_note_window(app, id) {
                                log_line(format!("隐藏便签失败：{err}"));
                            }
                        }
                    } else {
                        let _ = window.hide();
                        if label == windows::REMINDER_LABEL {
                            reminder::on_window_closed(app);
                        }
                    }
                }
                WindowEvent::Focused(true) if windows::is_note_window(&label) => {
                    if let (Some(store), Some(id)) = (
                        app.try_state::<Store>(),
                        windows::note_id_from_label(&label),
                    ) {
                        store.emit_note_focus(app, id);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::save_note,
            commands::delete_note,
            commands::list_trash,
            commands::restore_note,
            commands::empty_trash,
            commands::create_note,
            commands::open_note_window,
            commands::close_note_window,
            commands::save_window_state,
            commands::set_pinned,
            commands::set_note_collapsed,
            commands::set_note_size,
            commands::set_note_locked,
            commands::export_notes,
            commands::restore_from_backup,
            commands::list_note_versions,
            commands::get_note_version,
            commands::restore_note_version,
            commands::open_panel,
            commands::open_settings,
            commands::open_quick,
            commands::close_quick,
            commands::import_notes_file,
            commands::set_reminder,
            commands::snooze_reminder,
            commands::dismiss_reminder,
            commands::save_settings,
            commands::get_autostart,
            commands::set_autostart,
            commands::open_data_folder,
            commands::quit_app
        ])
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => {
            boot_log("build: ok, entering event loop");
            app
        }
        Err(err) => {
            boot_log(&format!("build: FAILED {err}"));
            panic!("启动小梦备忘录失败: {err}");
        }
    };

    app.run(|app_handle: &AppHandle, event: RunEvent| match event {
        // 用户关掉所有窗口时不退出，交给托盘常驻（app.exit(code) 带 code，不会被拦）
        RunEvent::ExitRequested { code, api, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        // 真正退出前最后写一次盘
        RunEvent::Exit => {
            if let Some(store) = app_handle.try_state::<Store>() {
                if let Err(err) = store.flush() {
                    log_line(format!("退出时写盘失败：{err}"));
                }
            }
        }
        _ => {}
    });
}
