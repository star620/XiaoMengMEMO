//! 同一 WebView 内的尺寸动画。HWND 保持容量不变，数据仍记可见便签的矩形。
//! 原生 region 只在起止时更新，空白承载区在静止时不接收桌面点击。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewWindow};

use crate::model::{Note, WindowState};
use crate::store::Store;
use crate::windows::{self, COLLAPSED_HEIGHT, DEFAULT_HEIGHT, DEFAULT_WIDTH};

pub fn enabled() -> bool {
    cfg!(windows)
        && windows::size_feel_mode(std::env::var("XM_SIZE_FEEL").ok().as_deref()) == "smooth"
}

pub fn visible_size(note: &Note) -> (f64, f64) {
    let width = note.width.unwrap_or(DEFAULT_WIDTH).max(windows::MIN_WIDTH);
    let height = if note.collapsed {
        COLLAPSED_HEIGHT
    } else {
        note.height
            .unwrap_or(DEFAULT_HEIGHT)
            .max(windows::MIN_HEIGHT)
    };
    (width, height)
}

/// 输入必须是原生窗口矩形，输出是纸面的逻辑矩形。不能对输出再次归一化。
pub fn visual_rect(note: &Note, raw: WindowState) -> WindowState {
    let (width, height) = visible_size(note);
    WindowState {
        x: raw.x + raw.width - width,
        y: raw.y,
        width,
        height,
    }
}

pub fn normalize(note: &Note, raw: WindowState) -> WindowState {
    if enabled() {
        visual_rect(note, raw)
    } else {
        raw
    }
}

pub fn resized_x(x: Option<f64>, old_width: f64, new_width: f64) -> Option<f64> {
    x.map(|x| x + old_width - new_width)
}

#[derive(Clone)]
struct Pending {
    revision: u64,
    goal: Goal,
    host: WindowState,
    started: Instant,
    epoch: f64,
    probe: Option<std::sync::Arc<crate::size_probe::SizeProbe>>,
}

#[derive(Clone, Copy, Serialize)]
struct Goal {
    width: f64,
    height: f64,
    revision: u64,
}

static NEXT: AtomicU64 = AtomicU64::new(1);
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn active(label: &str) -> bool {
    enabled()
        && pending()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(label)
}

fn current(label: &str, revision: u64) -> bool {
    pending()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(label)
        .is_some_and(|p| p.revision == revision)
}

fn raw_rect(window: &WebviewWindow) -> Result<WindowState, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(WindowState {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    })
}

/// 起止均在窗口所属线程执行。不要在调用 Win32 时持有 Store / PENDING 锁。
pub fn region(
    window: &WebviewWindow,
    size: Option<(f64, f64)>,
    revision: Option<u64>,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let host = window.outer_size().map_err(|e| e.to_string())?;
        let label = window.label().to_string();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                if revision.is_some_and(|r| !current(&label, r)) {
                    let _ = tx.send(Ok(false));
                    return;
                }
                let result = unsafe {
                    #[link(name = "gdi32")]
                    extern "system" {
                        fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> isize;
                        fn DeleteObject(object: isize) -> i32;
                    }
                    #[link(name = "user32")]
                    extern "system" {
                        fn SetWindowRgn(hwnd: isize, region: isize, redraw: i32) -> i32;
                    }
                    let (left, bottom) =
                        region_bounds(host.width as i32, host.height as i32, scale, size);
                    let rgn = CreateRectRgn(left, 0, host.width as i32, bottom);
                    if rgn == 0 {
                        Err(std::io::Error::last_os_error().to_string())
                    } else if SetWindowRgn(hwnd, rgn, 1) == 0 {
                        let error = std::io::Error::last_os_error().to_string();
                        DeleteObject(rgn); // 只有失败时仍由调用者持有。
                        Err(error)
                    } else {
                        Ok(true)
                    } // 成功后 region 归系统所有。
                };
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, size, revision);
        Ok(false)
    }
}

fn region_bounds(
    host_width: i32,
    host_height: i32,
    scale: f64,
    size: Option<(f64, f64)>,
) -> (i32, i32) {
    size.map(|(w, h)| {
        (
            (host_width - (w * scale).round() as i32).max(0),
            ((h * scale).round() as i32).min(host_height),
        )
    })
    .unwrap_or((0, host_height))
}

pub fn prepare(window: &WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let label = window.label().to_string();
    let host = raw_rect(window)?;
    if width > host.width + 1.0 || height > host.height + 1.0 {
        return Err("尺寸超过动画承载范围，请重新打开便签".into());
    }
    let revision = NEXT.fetch_add(1, Ordering::Relaxed);
    let goal = Goal {
        width,
        height,
        revision,
    };
    let p = Pending {
        revision,
        goal,
        host,
        started: Instant::now(),
        epoch: crate::size_probe::epoch_ms(),
        probe: crate::size_probe::begin(&label),
    };
    pending()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(label.clone(), p);
    let result = region(window, None, Some(revision)).and_then(|applied| {
        if applied {
            window
                .emit_to(window.label(), "note-size-goal", goal)
                .map_err(|e| e.to_string())
        } else {
            Ok(())
        }
    });
    if result.is_err() {
        pending()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&label);
        crate::size_probe::end(&label);
    }
    result
}

pub fn finish(
    window: &WebviewWindow,
    revision: u64,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    let label = window.label();
    let Some(p) = pending()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(label)
        .filter(|p| p.revision == revision)
        .cloned()
    else {
        return Ok(false);
    };
    if !width.is_finite()
        || !height.is_finite()
        || (width - p.goal.width).abs() > 1.0
        || (height - p.goal.height).abs() > 1.0
    {
        return Err("尺寸动画尚未达到目标".into());
    }
    if !region(window, Some((p.goal.width, p.goal.height)), Some(revision))? {
        return Ok(false);
    }
    let read = Instant::now();
    let raw = raw_rect(window)?;
    let final_read_us = read.elapsed().as_micros();
    let host_fixed =
        (raw.width - p.host.width).abs() < 1.0 && (raw.height - p.host.height).abs() < 1.0;
    let mut states = pending().lock().unwrap_or_else(|p| p.into_inner());
    if !states.get(label).is_some_and(|p| p.revision == revision) {
        return Ok(false);
    }
    states.remove(label);
    crate::size_probe::end(label);
    drop(states);
    let app = window.app_handle();
    if let Some(id) = windows::note_id_from_label(label) {
        // save_window_state 在同一 Store 锁中归一化，永远写当前目标，不能写回中途尺寸。
        app.state::<Store>().save_window_state(app, id, raw)?;
    }
    crate::boot_log(&format!("size_host {label}: revision={revision} goal={}x{} host_fixed={host_fixed} visual_match=true submissions=0", p.goal.width, p.goal.height));
    if let Some(probe) = p.probe {
        probe.emit(crate::size_probe::SizeCompletion {
            worker_epoch_ms: p.epoch,
            native_return_epoch_ms: None,
            elapsed_us: p.started.elapsed().as_micros(),
            setup_us: 0,
            final_read_us,
            submit_complete_us: 0,
            submissions: 0,
            final_match: host_fixed,
        });
    }
    Ok(host_fixed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn right_edge_and_fractional_negative_position_survive_host_conversion() {
        let mut note = Note::new(crate::model::NoteKind::Memo, "butter", 1.0, None);
        note.width = Some(280.0);
        note.height = Some(330.0);
        let raw = WindowState {
            x: -120.6666667,
            y: 20.0,
            width: 400.0,
            height: 500.0,
        };
        let visual = visual_rect(&note, raw);
        assert!((visual.x + visual.width - (raw.x + raw.width)).abs() < 1e-8);
        assert_eq!(visual.height, 330.0);
        note.collapsed = true;
        assert_eq!(visual_rect(&note, raw).height, COLLAPSED_HEIGHT);
        assert_eq!(note.height, Some(330.0));
        assert_eq!(resized_x(Some(840.0), 320.0, 400.0), Some(760.0));
        assert_eq!(resized_x(None, 320.0, 400.0), None);
    }
    #[test]
    fn native_region_uses_physical_pixels_and_does_not_cover_empty_host() {
        assert_eq!(
            region_bounds(600, 750, 1.5, Some((280.0, 330.0))),
            (180, 495)
        );
        assert_eq!(region_bounds(600, 750, 1.5, Some((320.0, 64.0))), (120, 96));
        assert_eq!(region_bounds(600, 750, 1.5, None), (0, 750));
    }
}
