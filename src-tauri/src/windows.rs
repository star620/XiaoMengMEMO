//! 窗口管理：便签小窗（可多个）+ 面板 / 设置 / 提醒三个单例窗口。
//! 注意：Windows 上「创建窗口」不能在主线程的同步命令或事件回调里直接做（WebView2 会死锁），
//! 所以这些函数由 async 命令或后台线程调用；改名/移动/显示这类操作在主线程调用是安全的。

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window};

use crate::log_line;
use crate::model::{self, Note, WindowState};
use crate::store::Store;

/// 便签窗口标签前缀：note-{id}
pub const NOTE_PREFIX: &str = "note-";
/// 便签默认大小
pub const DEFAULT_WIDTH: f64 = 320.0;
pub const DEFAULT_HEIGHT: f64 = 380.0;
/// 展开时能接受的最小"正常高度"：低于这个值说明数据在动画中途被写过，直接回落 DEFAULT_HEIGHT
pub const MIN_EXPANDED_HEIGHT: f64 = 200.0;
/// 便签最小尺寸
pub const MIN_WIDTH: f64 = 180.0;
pub const MIN_HEIGHT: f64 = 120.0;
/// 便签收起（折叠成一条）后的窗口高度
pub const COLLAPSED_HEIGHT: f64 = 64.0;
/// 便签窗口自身允许的最小高度：比 MIN_HEIGHT 小，否则怎么也压不到 64px
const MIN_NOTE_HEIGHT: f64 = 56.0;

pub const PANEL_LABEL: &str = "panel";
pub const SETTINGS_LABEL: &str = "settings";
pub const REMINDER_LABEL: &str = "reminder";
/// 快速记录浮层窗口标签
pub const QUICK_LABEL: &str = "quick";

pub fn note_label(id: &str) -> String {
    format!("{NOTE_PREFIX}{id}")
}

pub fn note_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(NOTE_PREFIX)
}

pub fn is_note_window(label: &str) -> bool {
    label.starts_with(NOTE_PREFIX)
}

/// 把便签 id 安全地放进 URL 查询参数
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 某块屏幕的可用区域（逻辑像素）
#[derive(Clone, Copy)]
struct Area {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 每块屏幕的可用区域（逻辑像素）。
///
/// 每块显示器用自己的 scale_factor 换算：混合 DPI 场景（例如笔记本 150% + 外接屏 100%），
/// 拿主屏缩放比去折算另一块屏，坐标会偏几十到上百像素，窗口就会「跳」到错误的位置。
/// 口径与 note_window_rects 保持一致（那边也是按窗口自己所在屏的缩放比折算）。
fn screen_areas(app: &AppHandle) -> Vec<Area> {
    let mut areas = Vec::new();
    if let Ok(monitors) = app.available_monitors() {
        for monitor in monitors.iter() {
            let mut scale = monitor.scale_factor();
            if !scale.is_finite() || scale <= 0.0 {
                scale = 1.0;
            }
            let rect = monitor.work_area();
            areas.push(Area {
                x: rect.position.x as f64 / scale,
                y: rect.position.y as f64 / scale,
                w: rect.size.width as f64 / scale,
                h: rect.size.height as f64 / scale,
            });
        }
    }
    if areas.is_empty() {
        areas.push(Area {
            x: 0.0,
            y: 0.0,
            w: 1280.0,
            h: 800.0,
        });
    }
    areas
}

/// 新建便签的层叠错位：视觉上一格挪 26 逻辑像素
const CASCADE_STEP: f64 = 26.0;
/// 最多试探这么多个位置，都被占了就回到正中央
const CASCADE_TRIES: usize = 8;
/// 与已有便签窗口重叠超过这个比例就认为「盖住了」，换下一个位置
const MAX_OVERLAP_RATIO: f64 = 0.5;
/// 试探落点的间距：26px 的相邻错位在 320×380 窗下仍有约 86% 重叠，
/// 会被 50% 判定全部拒绝，所以按 4 格（约 1/3 个便签宽）为一步向外扩散
const CASCADE_CELL: f64 = CASCADE_STEP * 4.0;
/// 8 个试探落点（相对主屏中央的格数）：中央 → 四个对角 → 左右 → 下方。
/// 相邻落点至少错开一格，保证每张新便签都不会完全盖住已有便签。
const CASCADE_OFFSETS: [(f64, f64); CASCADE_TRIES] = [
    (0.0, 0.0),
    (1.0, 1.0),
    (-1.0, -1.0),
    (1.0, -1.0),
    (-1.0, 1.0),
    (2.0, 0.0),
    (-2.0, 0.0),
    (0.0, 2.0),
];

/// 一个矩形（逻辑像素），用于判断窗口之间是否重叠
#[derive(Clone, Copy, Debug)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 候选窗口被已有窗口盖住的比例：0 表示完全错开，1 表示完全重合
fn overlap_ratio(candidate: Rect, other: Rect) -> f64 {
    let width = (candidate.x + candidate.w).min(other.x + other.w) - candidate.x.max(other.x);
    let height = (candidate.y + candidate.h).min(other.y + other.h) - candidate.y.max(other.y);
    if width <= 0.0 || height <= 0.0 {
        return 0.0;
    }
    (width * height) / (candidate.w * candidate.h).max(1.0)
}

/// 取出当前所有便签窗口的实际位置/大小（逻辑像素）。
/// 用真实窗口而不是 notes.json 里的记忆值，因为拖动后的新位置可能还没写盘。
fn note_window_rects(app: &AppHandle) -> Vec<Rect> {
    let mut rects = Vec::new();
    for (label, window) in app.webview_windows() {
        if !is_note_window(&label) {
            continue;
        }
        let mut scale = window.scale_factor().unwrap_or(1.0);
        if !scale.is_finite() || scale <= 0.0 {
            scale = 1.0;
        }
        let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
            continue;
        };
        rects.push(Rect {
            x: position.x as f64 / scale,
            y: position.y as f64 / scale,
            w: size.width as f64 / scale,
            h: size.height as f64 / scale,
        });
    }
    rects
}

/// 给「全新便签」挑一个位置：以主屏中央为起点向右下层叠错位，
/// 选第一个与已有便签重叠面积不到一半的位置；全被占就回到中央。
/// 返回 (x, y, 试探序号)：序号 0 表示中央可直接用，CASCADE_TRIES 表示退回中央。
fn pick_new_position(primary: Rect, width: f64, height: f64, taken: &[Rect]) -> (f64, f64, usize) {
    let max_x = primary.x + (primary.w - width).max(0.0);
    let max_y = primary.y + (primary.h - height).max(0.0);
    let base_x = (primary.x + (primary.w - width) / 2.0).clamp(primary.x, max_x);
    let base_y = (primary.y + (primary.h - height) / 2.0).clamp(primary.y, max_y);

    for (attempt, (dx, dy)) in CASCADE_OFFSETS.iter().enumerate() {
        let x = (base_x + dx * CASCADE_CELL).clamp(primary.x, max_x);
        let y = (base_y + dy * CASCADE_CELL).clamp(primary.y, max_y);
        let candidate = Rect {
            x,
            y,
            w: width,
            h: height,
        };
        if taken
            .iter()
            .all(|other| overlap_ratio(candidate, *other) < MAX_OVERLAP_RATIO)
        {
            return (x, y, attempt);
        }
    }

    (base_x, base_y, CASCADE_TRIES)
}

fn overlap_area(x: f64, y: f64, w: f64, h: f64, area: Area) -> f64 {
    let left = x.max(area.x);
    let top = y.max(area.y);
    let right = (x + w).min(area.x + area.w);
    let bottom = (y + h).min(area.y + area.h);
    if right <= left || bottom <= top {
        0.0
    } else {
        (right - left) * (bottom - top)
    }
}

/// 计算窗口该出现的位置与大小：恢复记忆位置，并保证窗口不会跑到屏幕外
fn note_geometry(app: &AppHandle, note: &Note) -> (f64, f64, f64, f64) {
    let areas = screen_areas(app);
    let primary = areas[0];
    let width = note
        .width
        .filter(|value| value.is_finite())
        .unwrap_or(DEFAULT_WIDTH)
        .max(MIN_WIDTH);
    let height = if note.collapsed {
        COLLAPSED_HEIGHT
    } else {
        note.height
            .filter(|value| value.is_finite())
            .unwrap_or(DEFAULT_HEIGHT)
            .max(MIN_HEIGHT)
    };

    // 别让窗口比最大的那块屏幕还大（换了小显示器 / 记忆了异常尺寸时兜底）
    let max_width = areas.iter().map(|area| area.w).fold(0.0, f64::max);
    let max_height = areas.iter().map(|area| area.h).fold(0.0, f64::max);
    let width = width.min(max_width.max(MIN_WIDTH));
    let height = height.min(max_height.max(MIN_HEIGHT));

    let (mut x, mut y) = match (note.x, note.y) {
        // 有记忆位置的便签（恢复/拖动过）完全按原样恢复
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => (x, y),
        // 全新便签从主屏中央开始层叠错位，避免一张张全叠在同一位置像「没加上」
        _ => {
            let primary_rect = Rect {
                x: primary.x,
                y: primary.y,
                w: primary.w,
                h: primary.h,
            };
            let taken = note_window_rects(app);
            let (x, y, attempt) = pick_new_position(primary_rect, width, height, &taken);
            crate::boot_log(&format!(
                "new note placed at ({x:.0}, {y:.0}) attempt={attempt}"
            ));
            (x, y)
        }
    };

    // 选重叠面积最大的那块屏幕；完全在屏幕外（比如显示器拔了）就回到主屏
    let mut target = primary;
    let mut best_overlap = 0.0;
    for area in areas.iter() {
        let overlap = overlap_area(x, y, width, height, *area);
        if overlap > best_overlap {
            best_overlap = overlap;
            target = *area;
        }
    }
    if best_overlap <= 0.0 {
        x = target.x + (target.w - width) / 2.0;
        y = target.y + (target.h - height) / 2.0;
    }

    let max_x = target.x + (target.w - width).max(0.0);
    let max_y = target.y + (target.h - height).max(0.0);
    (
        x.clamp(target.x, max_x),
        y.clamp(target.y, max_y),
        width,
        height,
    )
}

/// 把已存在但可能被最小化 / 隐藏的窗口重新露出来：
/// 只 show() 不会把最小化的窗口恢复（HWND 还是 iconic，坐标是 -32000 那一带的哨兵值），
/// 必须先 unminimize 再 show，否则用户点了热键/托盘也觉得「面板打不开」。
fn restore_and_focus(window: &WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    show_window(window);
    focus_window(window);
}

/// 把窗口真正提到最前面来。
///
/// 只调用 set_focus() 在 Windows 上并不可靠：系统的前台锁（foreground lock）
/// 会直接吞掉 SetForegroundWindow，窗口虽然 show() 了，却仍压在原来那个窗口后面，
/// 用户看到的就是「点了打开面板，什么也没发生」。
/// 先置顶再取消置顶能强制重排 z 序；最后再请求一次焦点。
fn raise_to_front(window: &WebviewWindow, keep_on_top: bool) {
    let before = (
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
        window.is_focused().unwrap_or(false),
    );
    let _ = window.set_always_on_top(true);
    show_window(window);
    let _ = window.unminimize();
    focus_window(window);
    let after = (
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
        window.is_focused().unwrap_or(false),
    );
    crate::boot_log(&format!(
        "raise {}: before(vis,min,focus)={before:?} after={after:?} keep_on_top={keep_on_top}",
        window.label()
    ));
    if !keep_on_top {
        // 置顶只借一会儿：等窗口真正排到最前、用户看见之后再放回普通层。
        // 立刻还原的话，Windows 有时会把 z 序重排回原来的位置，看起来就是"点了没反应"。
        let handle = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            // 用户可能已在这 700ms 内点了图钉，不能把新的置顶状态撤销。
            let pinned_now = note_id_from_label(handle.label())
                .and_then(|id| handle.app_handle().try_state::<Store>()?.note(id))
                .is_some_and(|note| note.pinned);
            if pinned_now {
                return;
            }
            let _ = handle.set_always_on_top(false);
            crate::boot_log(&format!(
                "raise {}: released topmost, focus={:?}",
                handle.label(),
                handle.is_focused().unwrap_or(false)
            ));
        });
    }
}

/// 显示窗口；失败只记日志（一个窗口显示失败不该让整个动作失败，但也不能静默吞掉）
fn show_window(window: &WebviewWindow) {
    if let Err(err) = window.show() {
        log_line(format!("显示窗口 {} 失败：{err}", window.label()));
    }
}

/// 聚焦窗口；失败只记日志（Windows 的前台锁常常让 set_focus 失败，这是常态，记一笔便于排查）
fn focus_window(window: &WebviewWindow) {
    if let Err(err) = window.set_focus() {
        log_line(format!("聚焦窗口 {} 失败：{err}", window.label()));
    }
}

/// 销毁窗口；失败只记日志（窗口可能已经自己关掉了）
fn destroy_window(window: &WebviewWindow) {
    if let Err(err) = window.destroy() {
        log_line(format!("销毁窗口 {} 失败：{err}", window.label()));
    }
}

/// 把窗口从"被遮挡后停画"的状态里拽回来。
///
/// 即使关掉了 Chromium 的遮挡检测，仍有少数路径（显示器休眠唤醒、DWM 会话切换、
/// 最小化再恢复）会让 WebView2 的合成器停在暂停状态。这里做两件事兜底：
/// 1. 让页面做一次极小改动触发重新合成（纯透明窗口内容不变时不会被重画）；
/// 2. 用 +1px 再还原的尺寸微调，从系统层触发一次 WM_SIZE，逼 WebView2 重建绘制表面。
fn force_repaint(window: &WebviewWindow) {
    let _ = window.eval(
        "(function(){var r=document.documentElement;if(!r)return;r.style.opacity='0.999';         requestAnimationFrame(function(){r.style.opacity='';});})()",
    );
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    if scale <= 0.0 {
        return;
    }
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    let _ = window.set_size(tauri::LogicalSize::new(width, height + 1.0));
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
}

/// 关掉 Chromium 的原生窗口遮挡检测。
///
/// Windows 上它会把"被别的窗口盖住"的 WebView2 判成不可见、暂停合成；等窗口重新回到
/// 前台时又不会主动恢复绘制。我们的窗口全是 transparent 的纸窗，一停渲染就一个像素都
/// 画不出来——用户看到的就是「面板明明打开了，屏幕上却什么都没有」。
/// 省那点电不值得，直接关掉这个特性。
const WEBVIEW_ARGS: &str = "--disable-features=CalculateNativeWinOcclusion";

// ---------- 尺寸切换 ----------
//
// 同步 SetWindowPos 本身可能耗时几十毫秒，不再尝试逐帧变形。
// 每个窗口只有一个目标槽和一个驱动线程；正常切换一次提交，
// 提交期间的新请求覆盖目标，返回后只补交最新值，不排队。

/// 一个窗口当前的尺寸目标（逻辑像素）
#[derive(Clone, Copy, Debug, PartialEq)]
struct SizeGoal {
    width: f64,
    height: f64,
}

#[derive(Default)]
struct SizeState {
    goal: Option<SizeGoal>,
    running: bool,
    pending: usize,
}

impl SizeState {
    /// 返回 true 的请求负责启动驱动，其余请求只覆盖目标槽。
    fn request(&mut self, goal: SizeGoal) -> bool {
        self.goal = Some(goal);
        if self.running {
            return false;
        }
        self.running = true;
        true
    }

    /// 与 request 共用注册表锁；校验期间到达的新目标不能被收尾清掉。
    fn complete(&mut self, submitted: SizeGoal, failed: bool) -> bool {
        if !failed && self.goal != Some(submitted) {
            return false;
        }
        self.running = false;
        self.goal = None;
        true
    }
}

/// 同一把锁管理目标、运行状态和落盘前的保护，收尾不会丢掉刚更新的目标。
static SIZE_STATES: OnceLock<Mutex<HashMap<String, SizeState>>> = OnceLock::new();

fn size_states() -> &'static Mutex<HashMap<String, SizeState>> {
    SIZE_STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct SizeChangeGuard {
    label: String,
    was_changing: bool,
}

impl SizeChangeGuard {
    pub fn was_changing(&self) -> bool {
        self.was_changing
    }
}

impl Drop for SizeChangeGuard {
    fn drop(&mut self) {
        let mut states = size_states().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(state) = states.get_mut(&self.label) {
            state.pending -= 1;
            if state.pending == 0 && !state.running {
                states.remove(&self.label);
            }
        }
    }
}

/// 在写入目标尺寸前就开始保护；命令失败时 Drop 会自动解除，避免遗留禁写状态。
pub fn begin_size_change(label: &str) -> SizeChangeGuard {
    let mut states = size_states().lock().unwrap_or_else(|p| p.into_inner());
    let state = states.entry(label.to_string()).or_default();
    let was_changing = state.running || state.pending != 0;
    state.pending += 1;
    SizeChangeGuard {
        label: label.to_string(),
        was_changing,
    }
}

pub fn is_size_changing(label: &str) -> bool {
    size_states()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(label)
        .is_some_and(|state| state.running || state.pending != 0)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SizeRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Clone, Copy, Debug)]
struct SizeGeometry {
    scale: f64,
    rect: SizeRect,
}

impl SizeGeometry {
    fn rect_for(&self, goal: SizeGoal) -> SizeRect {
        let width = (goal.width * self.scale).round() as i32;
        SizeRect {
            x: self.rect.x + self.rect.width - width,
            y: self.rect.y,
            width,
            height: (goal.height * self.scale).round() as i32,
        }
    }
}

/// 仅在驱动开始和结束校验时调用；便签为无边框窗口，outer rect 即窗口目标。
fn read_size_geometry(window: &WebviewWindow) -> Result<SizeGeometry, String> {
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err("窗口缩放比例无效".to_string());
    }
    let size = window.outer_size().map_err(|err| err.to_string())?;
    let position = window.outer_position().map_err(|err| err.to_string())?;
    Ok(SizeGeometry {
        scale,
        rect: SizeRect {
            x: position.x,
            y: position.y,
            width: size.width as i32,
            height: size.height as i32,
        },
    })
}

struct SizeWindow {
    probe: Option<std::sync::Arc<crate::size_probe::SizeProbe>>,
    #[cfg(windows)]
    hwnd: isize,
    #[cfg(not(windows))]
    window: WebviewWindow,
}

impl SizeWindow {
    fn new(window: &WebviewWindow) -> Result<Self, String> {
        #[cfg(windows)]
        {
            Ok(Self {
                probe: crate::size_probe::active(window.label()),
                hwnd: window.hwnd().map_err(|err| err.to_string())?.0 as isize,
            })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                probe: crate::size_probe::active(window.label()),
                window: window.clone(),
            })
        }
    }
}

/// 用一次 Win32 SetWindowPos 原子地完成「移动 + 改尺寸」。
/// 返回 false 表示系统调用失败，调用方应结束动画。
#[cfg(windows)]
fn set_window_rect(window: &SizeWindow, rect: SizeRect) -> bool {
    // SWP_NOZORDER：不动 z 序（置顶由 always_on_top 管，别在这里改）
    // SWP_NOACTIVATE：不抢焦点，用户正在别处打字时不能被尺寸动画打断
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    let measured = Instant::now();
    let ok = unsafe {
        SetWindowPos(
            window.hwnd,
            0,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
    let measured_us = measured.elapsed().as_micros();
    if let Some(probe) = &window.probe {
        probe.set_rect(measured_us, ok != 0);
    }
    ok != 0
}

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    /// after=0 且带 SWP_NOZORDER 时忽略；cx/cy 是物理像素
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32)
        -> i32;
}

/// 非 Windows 平台（只用于开发调试）退化成两次原生调用
#[cfg(not(windows))]
fn set_window_rect(window: &SizeWindow, rect: SizeRect) -> bool {
    let measured = Instant::now();
    let size_ok = window
        .window
        .set_size(tauri::PhysicalSize::new(
            rect.width as u32,
            rect.height as u32,
        ))
        .is_ok();
    let pos_ok = window
        .window
        .set_position(tauri::PhysicalPosition::new(rect.x, rect.y))
        .is_ok();
    let ok = size_ok && pos_ok;
    if let Some(probe) = &window.probe {
        probe.set_rect(measured.elapsed().as_micros(), ok);
    }
    ok
}

/// 把窗口尺寸驱动到指定逻辑大小（宽、高）。
/// 可以随便连续调用：只有最后一次的目标生效，重复调用会立即返回。
pub fn drive_size(window: &WebviewWindow, to_width: f64, to_height: f64) {
    if !to_width.is_finite() || !to_height.is_finite() {
        log_line(format!("尺寸切换：目标尺寸无效（{}）", window.label()));
        return;
    }
    // 宽度不能小于 MIN_WIDTH；高度用 MIN_NOTE_HEIGHT(56)，
    // 这样折叠目标 64 才不会被普通便签的 MIN_HEIGHT(120) 夹回去。
    let goal = SizeGoal {
        width: to_width.max(MIN_WIDTH),
        height: to_height.max(MIN_NOTE_HEIGHT),
    };
    let label = window.label().to_string();

    let mut states = size_states().lock().unwrap_or_else(|p| p.into_inner());
    let state = states.entry(label.clone()).or_default();
    if !state.request(goal) {
        return;
    }
    let probe = crate::size_probe::begin(&label);
    drop(states);

    let window = window.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let prepared = read_size_geometry(&window)
            .and_then(|geometry| SizeWindow::new(&window).map(|native| (geometry, native)));
        let setup_us = started.elapsed().as_micros();
        let mut submissions = 0;
        let mut submit_started = None;
        // 只有目标被新请求覆盖时才再提交；没有逐帧 tick、插值或补跑队列。
        loop {
            let goal = {
                let states = size_states().lock().unwrap_or_else(|p| p.into_inner());
                match states.get(&label).and_then(|state| state.goal) {
                    Some(goal) => goal,
                    None => break,
                }
            };
            let target_rect = prepared.as_ref().ok().map(|(g, _)| g.rect_for(goal));
            let result = prepared
                .as_ref()
                .map_err(Clone::clone)
                .and_then(|(geometry, native)| {
                    submissions += 1;
                    if let Some(probe) = &probe {
                        // 沿用探针的 frame 字段，TASK-4 中它是提交序号，不是动画帧。
                        probe.set_frame(submissions);
                    }
                    submit_started.get_or_insert_with(Instant::now);
                    if set_window_rect(native, geometry.rect_for(goal)) {
                        Ok(())
                    } else {
                        Err(format!(
                            "SetWindowPos 失败：{}",
                            std::io::Error::last_os_error()
                        ))
                    }
                });
            if result.is_ok()
                && size_states()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&label)
                    .and_then(|state| state.goal)
                    != Some(goal)
            {
                continue;
            }
            let verify_started = Instant::now();
            let final_geometry = read_size_geometry(&window);
            let final_read_us = verify_started.elapsed().as_micros();
            let final_match = final_geometry
                .as_ref()
                .is_ok_and(|g| Some(g.rect) == target_rect);
            let mut states = size_states().lock().unwrap_or_else(|p| p.into_inner());
            let state = states.get_mut(&label).expect("运行中的尺寸状态存在");
            if !state.complete(goal, result.is_err()) {
                continue;
            }
            crate::size_probe::end(&label);
            if state.pending == 0 {
                states.remove(&label);
            }
            // 注册表锁内不能调用窗口或 Store，窗口事件会反向查询动画状态。
            drop(states);
            if let Err(err) = &result {
                log_line(format!("尺寸切换失败（{label}）：{err}"));
            }
            let app = window.app_handle();
            if let (Some(store), Ok(geometry), Some(id)) = (
                app.try_state::<Store>(),
                &final_geometry,
                note_id_from_label(&label),
            ) {
                store.update_window_geometry(
                    id,
                    WindowState {
                        x: geometry.rect.x as f64 / geometry.scale,
                        y: geometry.rect.y as f64 / geometry.scale,
                        width: geometry.rect.width as f64 / geometry.scale,
                        height: geometry.rect.height as f64 / geometry.scale,
                    },
                );
            }
            let elapsed_us = started.elapsed().as_micros();
            let submit_complete_us = submit_started.map(|t| t.elapsed().as_micros()).unwrap_or(0);
            // 先停表，再汇总日志；elapsed 包含 setup，submit_complete 从第一次原生提交计到收尾。
            crate::boot_log(&format!(
                "size_snap {label}: goal={goal:?} elapsed_ms={} submissions={submissions} submit_complete_us={submit_complete_us} ok={} setup_us={setup_us} final_read_us={final_read_us} final_match={final_match} target_rect={target_rect:?} final_geometry={final_geometry:?}",
                elapsed_us / 1000,
                result.is_ok(),
            ));
            if let Some(probe) = &probe {
                probe.emit(crate::size_probe::SizeCompletion {
                    elapsed_us,
                    setup_us,
                    final_read_us,
                    submit_complete_us,
                    submissions,
                    final_match,
                });
            }
            break;
        }
    });
}

/// 按折叠状态一次提交窗口高度（宽度不变）
pub fn apply_collapsed(window: &WebviewWindow, collapsed: bool, width: f64, height: f64) {
    let to = if collapsed { COLLAPSED_HEIGHT } else { height };
    drive_size(window, width, to);
}

/// 按「紧凑 / 标准 / 大」三档设置便签尺寸（逻辑像素）
pub fn apply_size(window: &WebviewWindow, width: f64, height: f64) {
    drive_size(window, width, height);
}

/// 打开便签窗口：已存在就显示（可选聚焦），不存在就按记忆的几何信息新建
pub fn open_note_window(
    app: &AppHandle,
    note: &Note,
    focus: bool,
) -> Result<WebviewWindow, String> {
    let started = Instant::now();
    let label = note_label(&note.id);
    crate::boot_log(&format!(
        "open_note_window {label}: begin focus={focus} pinned={}",
        note.pinned
    ));

    if let Some(window) = app.get_webview_window(&label) {
        crate::boot_log(&format!("open_note_window {label}: reuse"));
        let _ = window.set_always_on_top(note.pinned);
        if focus {
            restore_and_focus(&window);
            raise_to_front(&window, note.pinned);
        } else if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        window
            .show()
            .map_err(|err| format!("显示便签窗口失败：{err}"))?;
        if let Some(store) = app.try_state::<Store>() {
            store.emit_note_focus(app, &note.id);
        }
        crate::boot_log(&format!(
            "open_note_window {label}: shown elapsed_ms={} visible={:?} minimized={:?}",
            started.elapsed().as_millis(),
            window.is_visible(),
            window.is_minimized()
        ));
        return Ok(window);
    }

    let (x, y, width, height) = note_geometry(app, note);
    crate::boot_log(&format!(
        "open_note_window {label}: build begin x={x} y={y} width={width} height={height}"
    ));
    let url = format!("index.html?surface=sticky&id={}", encode(&note.id));
    let builder = WebviewWindowBuilder::new(app, label.as_str(), WebviewUrl::App(url.into()))
        .title(note.window_title())
        .inner_size(width, height)
        .min_inner_size(MIN_WIDTH, MIN_NOTE_HEIGHT)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        // 尺寸只能从菜单里选三档（紧凑/标准/大），不允许拖边框：
        // 一旦可拖，Windows 11 的「拖到屏幕顶部自动贴靠放大」也会生效，
        // 便签被系统摆来摆去很难受，这里索性关掉缩放和最大化。
        .resizable(false)
        .maximizable(false)
        .always_on_top(note.pinned)
        .visible(false)
        .focused(focus)
        .on_page_load(|window, payload| {
            crate::boot_log(&format!(
                "note_page {}: event={:?}",
                window.label(),
                payload.event()
            ));
        })
        .additional_browser_args(WEBVIEW_ARGS);

    let window = builder
        .build()
        .map_err(|err| format!("创建便签窗口失败：{err}"))?;
    crate::boot_log(&format!(
        "open_note_window {label}: build done elapsed_ms={}",
        started.elapsed().as_millis()
    ));
    window
        .show()
        .map_err(|err| format!("显示便签窗口失败：{err}"))?;
    if focus {
        raise_to_front(&window, note.pinned);
    }
    crate::boot_log(&format!(
        "open_note_window {label}: shown elapsed_ms={} visible={:?} minimized={:?}",
        started.elapsed().as_millis(),
        window.is_visible(),
        window.is_minimized()
    ));
    Ok(window)
}

/// 把窗口当前的位置/大小记进内存（拖动、缩放时调用，不频繁写盘）
pub fn capture_geometry(window: &Window, store: &Store) {
    let Some(id) = note_id_from_label(window.label()) else {
        return;
    };
    let probe = crate::size_probe::active(window.label());
    if let Some(probe) = &probe {
        probe.capture_begin();
    }
    let mut sample = crate::size_probe::CaptureSample {
        frame: probe.as_ref().map(|p| p.frame()).unwrap_or(0),
        scale_us: 0,
        position_us: 0,
        inner_us: 0,
        ok: false,
    };
    let measured = Instant::now();
    let mut scale = window.scale_factor().unwrap_or(1.0);
    sample.scale_us = measured.elapsed().as_micros();
    if !scale.is_finite() || scale <= 0.0 {
        scale = 1.0;
    }
    let measured = Instant::now();
    let position = window.outer_position();
    sample.position_us = measured.elapsed().as_micros();
    let (x, y) = match position {
        Ok(position) => (position.x as f64 / scale, position.y as f64 / scale),
        Err(_) => {
            if let Some(probe) = &probe {
                probe.capture(sample);
            }
            return;
        }
    };
    let measured = Instant::now();
    let size = window.inner_size();
    sample.inner_us = measured.elapsed().as_micros();
    let (width, height) = match size {
        Ok(size) => (size.width as f64 / scale, size.height as f64 / scale),
        Err(_) => {
            if let Some(probe) = &probe {
                probe.capture(sample);
            }
            return;
        }
    };
    sample.ok = true;
    if let Some(probe) = &probe {
        probe.capture(sample);
    }
    store.update_window_geometry(
        id,
        WindowState {
            x,
            y,
            width,
            height,
        },
    );
}

/// 隐藏便签窗口（关闭按钮走这里：不退出、不删数据）
pub fn hide_note_window(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&note_label(id)) {
        let _ = window.hide();
    }
    let store = app.state::<Store>();
    store.set_hidden(app, &[id.to_string()], true)
}

/// 彻底销毁便签窗口（删除便签时用）
pub fn destroy_note_window(app: &AppHandle, id: &str) {
    let label = note_label(id);
    if let Some(window) = app.get_webview_window(&label) {
        destroy_window(&window);
    }
    // 窗口没了，这个标签的吸边记录也就没用了：不清掉状态表会越积越多
    forget_snap_state(&label);
}

/// 托盘「显示全部便签」
pub fn show_all_notes(app: &AppHandle) {
    let store = app.state::<Store>();
    let notes = store.all_notes();
    if notes.is_empty() {
        return;
    }
    let ids: Vec<String> = notes.iter().map(|note| note.id.clone()).collect();
    if let Err(err) = store.set_hidden(app, &ids, false) {
        log_line(format!("显示全部便签失败：{err}"));
    }
    for note in notes.iter() {
        if let Err(err) = open_note_window(app, note, false) {
            log_line(format!("打开便签窗口失败（{}）：{err}", note.id));
        }
    }
}

/// 托盘「隐藏全部便签」
pub fn hide_all_notes(app: &AppHandle) {
    let store = app.state::<Store>();
    let notes = store.all_notes();
    if notes.is_empty() {
        return;
    }
    for note in notes.iter() {
        if let Some(window) = app.get_webview_window(&note_label(&note.id)) {
            let _ = window.hide();
        }
    }
    let ids: Vec<String> = notes.iter().map(|note| note.id.clone()).collect();
    if let Err(err) = store.set_hidden(app, &ids, true) {
        log_line(format!("隐藏全部便签失败：{err}"));
    }
}

/// 面板 / 设置：单例无边框透明纸窗，已存在就显示并聚焦
/// （圆角、纸边和关闭/最小化按钮由前端自绘；拖动区由前端补 data-tauri-drag-region）
fn open_aux(
    app: &AppHandle,
    label: &str,
    title: &str,
    width: f64,
    height: f64,
) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(label) {
        // 最小化过的窗口只 show() 是回不来的（HWND 仍 iconic），必须 unminimize 再显示；
        // 再 raise 一次，避免它只是"显示"了却还压在别的窗口后面
        crate::boot_log(&format!(
            "open_aux {label}: exists vis={:?} min={:?} pos={:?}",
            window.is_visible().unwrap_or(false),
            window.is_minimized().unwrap_or(false),
            window.outer_position().ok()
        ));
        restore_and_focus(&window);
        raise_to_front(&window, false);
        // 面板每次被叫出来都回到列表（离开时可能停在"修改记录/回收站"里）
        if label == PANEL_LABEL {
            let _ = window.eval("window.dispatchEvent(new Event('xm-panel-open'))");
        }
        force_repaint(&window);
        return Ok(window);
    }
    crate::boot_log(&format!("open_aux {label}: creating new window"));
    let url = format!("index.html?surface={}", encode(label));
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(360.0, 420.0)
        // 和便签一致的无边框纸窗：圆角、纸边、阴影都交给前端自绘，和暖黄纸感统一
        .decorations(false)
        .transparent(true)
        // shadow(false)：Windows 上给无边框窗口开原生阴影会额外留一圈透明边，
        // 在浅色壁纸上看起来就是"窗口外面还有一圈透明框"。纸边和阴影都由前端自绘。
        .shadow(false)
        .skip_taskbar(false)
        // 固定尺寸：面板/设置也是纸窗，放大后排版会乱
        .resizable(false)
        .center()
        .visible(false)
        .focused(true)
        .additional_browser_args(WEBVIEW_ARGS)
        .build()
        .map_err(|err| format!("创建窗口失败：{err}"))?;
    window
        .show()
        .map_err(|err| format!("显示窗口失败：{err}"))?;
    // 新建的面板/设置窗口也要抢到前台，否则会安静地开在别的窗口后面
    raise_to_front(&window, false);
    if label == PANEL_LABEL {
        let _ = window.eval("window.dispatchEvent(new Event('xm-panel-open'))");
    }
    force_repaint(&window);
    Ok(window)
}

/// 打开管理面板
pub fn open_panel(app: &AppHandle) -> Result<WebviewWindow, String> {
    open_aux(app, PANEL_LABEL, "小梦备忘录", 420.0, 620.0)
}

/// 打开设置
pub fn open_settings(app: &AppHandle) -> Result<WebviewWindow, String> {
    open_aux(app, SETTINGS_LABEL, "设置 · 小梦备忘录", 480.0, 640.0)
}

/// 打开（或叫回）快速记录浮层：按 Ctrl+Alt+Space 弹出来的小条。
/// 无边框透明、置顶、跳过任务栏；已有窗口就复用（保存后只是隐藏，不销毁）。
pub fn open_quick(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(QUICK_LABEL) {
        restore_and_focus(&window);
        raise_to_front(&window, true);
        // 通知前端「又被叫出来了」，好把输入框清空/重新聚焦（前端可监听，不监听也无害）
        let _ = window.eval("window.dispatchEvent(new Event('xm-quick-open'))");
        force_repaint(&window);
        return Ok(window);
    }

    let url = format!("index.html?surface={}", encode(QUICK_LABEL));
    let window = WebviewWindowBuilder::new(app, QUICK_LABEL, WebviewUrl::App(url.into()))
        .title("快速记录 · 小梦备忘录")
        .inner_size(520.0, 150.0)
        .min_inner_size(320.0, 120.0)
        .decorations(false)
        .transparent(true)
        // shadow(false)：Windows 上给无边框窗口开原生阴影会额外留一圈透明边，
        // 在浅色壁纸上看起来就是"窗口外面还有一圈透明框"。纸边和阴影都由前端自绘。
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .always_on_top(true)
        .center()
        .visible(false)
        .focused(true)
        .additional_browser_args(WEBVIEW_ARGS)
        .build()
        .map_err(|err| format!("创建快速记录窗口失败：{err}"))?;
    window
        .show()
        .map_err(|err| format!("显示快速记录窗口失败：{err}"))?;
    raise_to_front(&window, true);
    focus_window(&window);
    Ok(window)
}

/// 关闭快速记录浮层（保存成功 / 按 Esc / 点关闭都只隐藏，下次还能秒开）
pub fn close_quick(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICK_LABEL) {
        let _ = window.hide();
    }
}

/// 提醒窗口地址（相对当前页面）
fn reminder_url(window: &WebviewWindow, id: &str) -> Option<tauri::Url> {
    // 带一个变化的时间戳：提醒窗口是单例，重复提醒（每天/每周）第二次会导航到
    // 和上次完全相同的地址，WebView2 不会重新加载，页面会停在上一轮"按钮已禁用"
    // 的死状态。加 ts 让每次都是新地址，保证页面重新挂载。
    let stamp = model::now_ms();
    let target = format!("index.html?surface=reminder&id={}&ts={}", encode(id), stamp);
    match window.url() {
        Ok(base) => base.join(&target).ok(),
        Err(_) => None,
    }
}

/// 打开（或切到）提醒窗口。
/// 窗口是单例：已经有窗口就导航到新的便签，避免销毁重建时标签冲突。
pub fn open_reminder(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(REMINDER_LABEL) {
        let nav_error = match reminder_url(&window, id) {
            Some(url) => window.navigate(url).err().map(|err| err.to_string()),
            None => Some("提醒窗口地址解析不出来".to_string()),
        };
        match nav_error {
            // 导航成功：叫到最前（老窗口可能压在别的窗口后面，否则用户看不见）
            None => {
                restore_and_focus(&window);
                raise_to_front(&window, true);
                return Ok(());
            }
            // 导航失败（页面崩了 / 地址不可用）：销毁重建，让下一次循环能正常弹出。
            // 以前这里只打日志就 return Ok，提醒窗口会一直停在旧便签上。
            Some(err) => {
                log_line(format!("提醒窗口切换失败，改为销毁重建：{err}"));
                destroy_window(&window);
                // 等系统真正销毁掉，否则同名的 label 立刻重建会冲突
                std::thread::sleep(Duration::from_millis(120));
            }
        }
    }

    let url = format!("index.html?surface=reminder&id={}", encode(id));
    let window = WebviewWindowBuilder::new(app, REMINDER_LABEL, WebviewUrl::App(url.into()))
        .title("提醒 · 小梦备忘录")
        .inner_size(360.0, 240.0)
        .min_inner_size(320.0, 200.0)
        .decorations(false)
        .transparent(true)
        // shadow(false)：Windows 上给无边框窗口开原生阴影会额外留一圈透明边，
        // 在浅色壁纸上看起来就是"窗口外面还有一圈透明框"。纸边和阴影都由前端自绘。
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        .always_on_top(true)
        .center()
        .visible(false)
        .focused(true)
        .additional_browser_args(WEBVIEW_ARGS)
        .build()
        .map_err(|err| format!("创建提醒窗口失败：{err}"))?;
    window
        .show()
        .map_err(|err| format!("显示提醒窗口失败：{err}"))?;
    focus_window(&window);
    Ok(())
}

/// 隐藏提醒窗口（点了「知道了」/「稍后」之后）
pub fn hide_reminder(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(REMINDER_LABEL) {
        let _ = window.hide();
    }
}

/// 让提醒窗口少一点打扰：延时一点点再隐藏，给前端播放动画留时间
pub fn hide_reminder_later(app: &AppHandle, delay_ms: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay_ms));
        hide_reminder(&app);
    });
}

// ---------- 吸边与对齐 ----------

/// 距工作区边缘多近就吸附（逻辑像素）
const SNAP_EDGE: f64 = 14.0;
/// 与其它便签的边/中线多近就对齐（逻辑像素）
const SNAP_ALIGN: f64 = 8.0;
/// 拖动停下多久后才吸附（毫秒）：太短会边拖边吸、手感发黏
const SNAP_QUIET_MS: i64 = 120;
/// 吸附检查线程的轮询间隔（毫秒）
const SNAP_POLL_MS: u64 = 50;

/// 一个便签窗最近一次移动的时间与序号
#[derive(Clone, Copy)]
struct MovedState {
    last_ms: i64,
    generation: u64,
}

static SNAP_MOVED: OnceLock<Mutex<HashMap<String, MovedState>>> = OnceLock::new();
static SNAP_DONE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn snap_moved() -> &'static Mutex<HashMap<String, MovedState>> {
    SNAP_MOVED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn snap_done() -> &'static Mutex<HashMap<String, u64>> {
    SNAP_DONE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 便签窗刚被移动过：记下时间与序号，等它安静 120ms 再考虑吸边
pub fn mark_moved(label: &str) {
    if !is_note_window(label) {
        return;
    }
    let mut moved = snap_moved()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let entry = moved.entry(label.to_string()).or_insert(MovedState {
        last_ms: 0,
        generation: 0,
    });
    entry.last_ms = model::now_ms();
    entry.generation = entry.generation.wrapping_add(1);
}

/// 便签窗口销毁时清掉它的吸边记录（状态表只增不减会一直涨）
fn forget_snap_state(label: &str) {
    snap_moved()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .remove(label);
    snap_done()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .remove(label);
}

/// 清理已经不存在的窗口的吸边记录：多一层保险，
/// 万一有路径没走到 forget_snap_state（比如窗口被系统关掉），也不会让表无限增长。
fn prune_snap_state(app: &AppHandle) {
    let alive: HashSet<String> = app.webview_windows().into_keys().collect();
    snap_moved()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .retain(|label, _| alive.contains(label));
    snap_done()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .retain(|label, _| alive.contains(label));
}

/// 启动吸边检查线程：所有便签共用一条后台线程，每 50ms 看一次谁刚停下、该不该吸
pub fn spawn_snap_worker(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut ticks: u64 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(SNAP_POLL_MS));
            // 每 200 次（约 10 秒）清一次失效记录，开销很小
            ticks = ticks.wrapping_add(1);
            if ticks % 200 == 0 {
                prune_snap_state(&app);
            }
            let now = model::now_ms();
            let ready: Vec<(String, u64)> = {
                let moved = snap_moved()
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                let done = snap_done()
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                moved
                    .iter()
                    .filter(|(label, state)| {
                        state.generation != done.get(*label).copied().unwrap_or(0)
                            && now.saturating_sub(state.last_ms) >= SNAP_QUIET_MS
                    })
                    .map(|(label, state)| (label.clone(), state.generation))
                    .collect()
            };
            for (label, generation) in ready {
                snap_done()
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .insert(label.clone(), generation);
                snap_one(&app, &label);
            }
        }
    });
}

/// 当前所有可见便签窗口的矩形（逻辑像素），用于对齐时当参照物
fn visible_note_rects(app: &AppHandle, exclude: &str) -> Vec<Rect> {
    let mut rects = Vec::new();
    for (label, window) in app.webview_windows() {
        if label == exclude || !is_note_window(&label) {
            continue;
        }
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        let mut scale = window.scale_factor().unwrap_or(1.0);
        if !scale.is_finite() || scale <= 0.0 {
            scale = 1.0;
        }
        let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
            continue;
        };
        rects.push(Rect {
            x: position.x as f64 / scale,
            y: position.y as f64 / scale,
            w: size.width as f64 / scale,
            h: size.height as f64 / scale,
        });
    }
    rects
}

/// 找一条可以对齐的竖线：其它便签的左/右/中线和自己的左/右/中线差值 ≤8px 时，
/// 返回吸附后的新左边 x；没有合适的就返回 None。多个候选取差值最小的。
fn aligned_x(rect: Rect, others: &[Rect]) -> Option<f64> {
    let mut best: Option<(f64, f64)> = None;
    for other in others {
        let lines = [other.x, other.x + other.w, other.x + other.w / 2.0];
        for line in lines {
            let candidates = [
                ((rect.x - line).abs(), line),
                (((rect.x + rect.w) - line).abs(), line - rect.w),
                (((rect.x + rect.w / 2.0) - line).abs(), line - rect.w / 2.0),
            ];
            for (delta, target) in candidates {
                if delta <= SNAP_ALIGN && best.map_or(true, |(best_delta, _)| delta < best_delta) {
                    best = Some((delta, target));
                }
            }
        }
    }
    best.map(|(_, x)| x)
}

/// 与 aligned_x 同理，横向对齐（上/下/水平中线）
fn aligned_y(rect: Rect, others: &[Rect]) -> Option<f64> {
    let mut best: Option<(f64, f64)> = None;
    for other in others {
        let lines = [other.y, other.y + other.h, other.y + other.h / 2.0];
        for line in lines {
            let candidates = [
                ((rect.y - line).abs(), line),
                (((rect.y + rect.h) - line).abs(), line - rect.h),
                (((rect.y + rect.h / 2.0) - line).abs(), line - rect.h / 2.0),
            ];
            for (delta, target) in candidates {
                if delta <= SNAP_ALIGN && best.map_or(true, |(best_delta, _)| delta < best_delta) {
                    best = Some((delta, target));
                }
            }
        }
    }
    best.map(|(_, y)| y)
}

/// 对一张便签做一次吸边/对齐；真的移动了才写盘（不抖动）
fn snap_one(app: &AppHandle, label: &str) {
    let Some(id) = note_id_from_label(label) else {
        return;
    };
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    // 只处理正在屏幕上、刚被用户碰过的便签：避免和新建落点、折叠动画抢位置
    if !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false) {
        return;
    }
    let mut scale = window.scale_factor().unwrap_or(1.0);
    if !scale.is_finite() || scale <= 0.0 {
        scale = 1.0;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let rect = Rect {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        w: size.width as f64 / scale,
        h: size.height as f64 / scale,
    };
    if rect.w <= 0.0 || rect.h <= 0.0 {
        return;
    }

    // 取与它重叠面积最大的那块屏的可用工作区（多显示器时不会吸到别的屏上）
    let areas = screen_areas(app);
    let Some(area) = areas.iter().copied().max_by(|a, b| {
        let left = overlap_area(rect.x, rect.y, rect.w, rect.h, *a);
        let right = overlap_area(rect.x, rect.y, rect.w, rect.h, *b);
        left.partial_cmp(&right)
            .unwrap_or(std::cmp::Ordering::Equal)
    }) else {
        return;
    };

    let mut target_x = rect.x;
    let mut target_y = rect.y;
    // 1) 先吸工作区四边（≤14px）
    if (rect.x - area.x).abs() <= SNAP_EDGE {
        target_x = area.x;
    } else if ((area.x + area.w) - (rect.x + rect.w)).abs() <= SNAP_EDGE {
        target_x = area.x + area.w - rect.w;
    }
    if (rect.y - area.y).abs() <= SNAP_EDGE {
        target_y = area.y;
    } else if ((area.y + area.h) - (rect.y + rect.h)).abs() <= SNAP_EDGE {
        target_y = area.y + area.h - rect.h;
    }

    // 2) 没吸到边的那一维，再看能不能和其它便签的边/中线对齐（≤8px）
    let others = visible_note_rects(app, label);
    if (target_x - rect.x).abs() < 0.5 {
        if let Some(x) = aligned_x(rect, &others) {
            target_x = x;
        }
    }
    if (target_y - rect.y).abs() < 0.5 {
        if let Some(y) = aligned_y(rect, &others) {
            target_y = y;
        }
    }

    // 对齐可能把便签推出工作区：能塞下时才夹回边界
    let min_x = area.x;
    let max_x = area.x + area.w - rect.w;
    if max_x >= min_x {
        target_x = target_x.clamp(min_x, max_x);
    }
    let min_y = area.y;
    let max_y = area.y + area.h - rect.h;
    if max_y >= min_y {
        target_y = target_y.clamp(min_y, max_y);
    }

    if (target_x - rect.x).abs() < 0.5 && (target_y - rect.y).abs() < 0.5 {
        return;
    }
    let target = tauri::PhysicalPosition::new(
        (target_x * scale).round() as i32,
        (target_y * scale).round() as i32,
    );
    if let Err(err) = window.set_position(target) {
        log_line(format!("吸边移动窗口失败：{err}"));
        return;
    }
    // 契约要求：吸附后立即把这个位置写盘
    let store = app.state::<Store>();
    let state = WindowState {
        x: target_x.round(),
        y: target_y.round(),
        width: rect.w.round(),
        height: rect.h.round(),
    };
    if let Err(err) = store.save_window_state(app, id, state) {
        log_line(format!("吸边后保存窗口位置失败：{err}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn primary() -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            w: 1440.0,
            h: 900.0,
        }
    }

    #[test]
    fn 单次目标矩形在负坐标和非整数缩放下保持右上角() {
        let geometry = SizeGeometry {
            scale: 1.25,
            rect: SizeRect {
                x: -1600,
                y: 50,
                width: 400,
                height: 475,
            },
        };
        for (width, height) in [
            (280.0, 330.0),
            (320.0, 380.0),
            (400.0, 500.0),
            (320.0, 64.0),
        ] {
            let rect = geometry.rect_for(SizeGoal { width, height });
            assert_eq!(rect.x + rect.width, -1200);
            assert_eq!(rect.y, 50);
            assert_eq!(rect.width, (width * 1.25).round() as i32);
            assert_eq!(rect.height, (height * 1.25).round() as i32);
        }
    }

    #[test]
    fn 提交期间五次改目标只保留最新值且收尾不丢新请求() {
        let first = SizeGoal {
            width: 400.0,
            height: 500.0,
        };
        let mut state = SizeState::default();
        assert!(state.request(first));
        let mut latest = first;
        // 模拟一次原生提交尚未返回：新请求不能启动五个驱动或形成目标队列。
        for width in [280.0, 320.0, 400.0, 320.0, 280.0] {
            latest = SizeGoal {
                width,
                height: 330.0,
            };
            assert!(!state.request(latest));
        }
        assert_eq!(state.goal, Some(latest));
        assert!(!state.complete(first, false));
        assert!(state.running);
        // 与运行时相同：第一次提交完成后，接着提交的只有最后那个目标。
        assert!(state.complete(latest, false));
        assert!(!state.running);
        assert_eq!(state.goal, None);
        // 收尾已完成后到达的请求必须能重新启动驱动。
        assert!(state.request(first));
    }

    #[test]
    fn 吸边对齐_边和中线在阈值内能吸住() {
        let other = Rect {
            x: 300.0,
            y: 200.0,
            w: 320.0,
            h: 380.0,
        };
        // 左边差 5px → 吸附到对方的左边
        let near = Rect {
            x: 305.0,
            y: 600.0,
            w: 320.0,
            h: 380.0,
        };
        assert_eq!(aligned_x(near, &[other]), Some(300.0));
        // 上边差 4px → 吸附到对方的上边
        let near_y = Rect {
            x: 900.0,
            y: 204.0,
            w: 320.0,
            h: 380.0,
        };
        assert_eq!(aligned_y(near_y, &[other]), Some(200.0));
    }

    #[test]
    fn 吸边对齐_超出阈值不动() {
        let other = Rect {
            x: 300.0,
            y: 200.0,
            w: 320.0,
            h: 380.0,
        };
        let far = Rect {
            x: 500.0,
            y: 700.0,
            w: 320.0,
            h: 380.0,
        };
        assert_eq!(aligned_x(far, &[other]), None);
        assert_eq!(aligned_y(far, &[other]), None);
    }

    #[test]
    fn 第一张新便签落在主屏中央() {
        let (x, y, attempt) = pick_new_position(primary(), 320.0, 380.0, &[]);
        assert_eq!(attempt, 0);
        assert!((x - 560.0).abs() < 0.01);
        assert!((y - 260.0).abs() < 0.01);
    }

    #[test]
    fn 连续新建的便签互相错开而不是完全重叠() {
        let mut taken: Vec<Rect> = Vec::new();
        for index in 0..4 {
            let (x, y, _attempt) = pick_new_position(primary(), 320.0, 380.0, &taken);
            let rect = Rect {
                x,
                y,
                w: 320.0,
                h: 380.0,
            };
            for other in taken.iter() {
                let ratio = overlap_ratio(rect, *other);
                assert!(
                    ratio < MAX_OVERLAP_RATIO,
                    "第 {} 张和已有便签重叠了 {:.0}%",
                    index + 1,
                    ratio * 100.0
                );
            }
            // 新便签不能跑到屏幕外
            assert!(x >= 0.0 && x + 320.0 <= 1440.0, "x 越界：{x}");
            assert!(y >= 0.0 && y + 380.0 <= 900.0, "y 越界：{y}");
            taken.push(rect);
        }
        assert_eq!(taken.len(), 4);
    }

    #[test]
    fn 位置全被占满时退回正中央() {
        // 把 8 个试探落点都用同尺寸窗口盖住
        let mut taken = Vec::new();
        for (dx, dy) in CASCADE_OFFSETS.iter() {
            taken.push(Rect {
                x: 560.0 + dx * CASCADE_CELL,
                y: 260.0 + dy * CASCADE_CELL,
                w: 320.0,
                h: 380.0,
            });
        }
        let (x, y, attempt) = pick_new_position(primary(), 320.0, 380.0, &taken);
        assert_eq!(attempt, CASCADE_TRIES);
        assert!((x - 560.0).abs() < 0.01);
        assert!((y - 260.0).abs() < 0.01);
    }

    #[test]
    fn 屏幕比便签还小时不会算出屏幕外的位置() {
        let small = Rect {
            x: 100.0,
            y: 50.0,
            w: 400.0,
            h: 300.0,
        };
        // 窗口比屏幕还高：只能贴在屏幕左上角，但不能跑到外面
        let (x, y, _attempt) = pick_new_position(small, 320.0, 380.0, &[]);
        assert!(x >= 100.0 && x + 320.0 <= 500.0, "x 越界：{x}");
        assert_eq!(y, 50.0);

        let taken = vec![Rect {
            x,
            y,
            w: 320.0,
            h: 380.0,
        }];
        // 屏幕太小，8 个试探点全部被夹到同一处，只能退回中央（仍不会跑到屏幕外）
        let (x2, y2, attempt2) = pick_new_position(small, 320.0, 380.0, &taken);
        assert!(x2 >= 100.0 && x2 + 320.0 <= 500.0, "x 越界：{x2}");
        assert_eq!(y2, 50.0);
        assert_eq!(attempt2, CASCADE_TRIES);
    }

    #[test]
    fn 原生提交失败会释放运行状态允许重试() {
        let goal = SizeGoal {
            width: 320.0,
            height: 380.0,
        };
        let mut state = SizeState::default();
        assert!(state.request(goal));
        assert!(state.complete(goal, true));
        assert_eq!(state.goal, None);
        assert!(state.request(goal));
    }

    #[test]
    fn 重复目标在原生提交中合并不再补交() {
        let goal = SizeGoal {
            width: 320.0,
            height: 64.0,
        };
        let mut state = SizeState::default();
        assert!(state.request(goal));
        for _ in 0..5 {
            assert!(!state.request(goal));
        }
        assert!(state.complete(goal, false));
        assert!(!state.running);
    }

    #[test]
    fn 重叠尺寸命令在最后一个保护释放后才允许记录宽高() {
        let label = model::new_id("size-guard-test");
        let first = begin_size_change(&label);
        assert!(!first.was_changing());
        let second = begin_size_change(&label);
        assert!(second.was_changing());
        drop(first);
        assert!(is_size_changing(&label));
        drop(second);
        assert!(!is_size_changing(&label));
    }
}
