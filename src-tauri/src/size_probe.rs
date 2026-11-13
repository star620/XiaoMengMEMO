//! TASK-3 临时测量。仅 XM_SIZE_MEASURE=1 开启，不改变动画或 Store 决策。
//! 动画期间只记录内存；在 running 结束、最终几何收尾后统一写启动日志。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;

static ENABLED: OnceLock<bool> = OnceLock::new();
static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<SizeProbe>>>> = OnceLock::new();
static NEXT_PROBE: AtomicU64 = AtomicU64::new(1);
static NEXT_WRITE: AtomicU64 = AtomicU64::new(1);

fn enabled() -> bool {
    *ENABLED.get_or_init(|| std::env::var("XM_SIZE_MEASURE").as_deref() == Ok("1"))
}

fn registry() -> &'static Mutex<HashMap<String, Arc<SizeProbe>>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
pub(crate) struct CaptureSample {
    pub frame: u64,
    pub scale_us: u128,
    pub position_us: u128,
    pub inner_us: u128,
    pub ok: bool,
}

#[derive(Default, Serialize)]
struct ProbeData {
    captures: Vec<CaptureSample>,
    waits: Vec<(u64, u128)>,
    sets: Vec<(u64, u128, bool)>,
    events: Vec<(u64, &'static str)>,
    writes: Vec<WriteSample>,
}

#[derive(Serialize)]
struct WriteSample {
    id: u64,
    file: String,
    stage: &'static str,
    success: Option<bool>,
    elapsed_us: u128,
    started_running: bool,
    finished_running: bool,
}

pub(crate) struct SizeProbe {
    id: u64,
    label: String,
    started: Instant,
    epoch_ms: i64,
    frame: AtomicU64,
    capture_calls: AtomicU64,
    data: Mutex<ProbeData>,
}

impl SizeProbe {
    pub fn set_frame(&self, frame: u64) {
        self.frame.store(frame, Ordering::Relaxed);
    }

    pub fn frame(&self) -> u64 {
        self.frame.load(Ordering::Relaxed)
    }

    pub fn capture_begin(&self) {
        self.capture_calls.fetch_add(1, Ordering::Relaxed);
    }

    pub fn capture(&self, sample: CaptureSample) {
        self.data
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .captures
            .push(sample);
    }

    pub fn store_wait(&self, micros: u128) {
        self.data
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .waits
            .push((self.frame(), micros));
    }

    pub fn set_rect(&self, micros: u128, ok: bool) {
        self.data
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sets
            .push((self.frame(), micros, ok));
    }

    pub fn emit(&self) {
        let data = self.data.lock().unwrap_or_else(|p| p.into_inner());
        let value = serde_json::json!({
            "id": self.id, "label": self.label, "begin_epoch_ms": self.epoch_ms,
            "elapsed_us": self.started.elapsed().as_micros(),
            "capture_calls": self.capture_calls.load(Ordering::Relaxed), "data": &*data,
        });
        drop(data);
        crate::boot_log(&format!("size_probe {value}"));
    }
}

pub(crate) fn begin(label: &str) -> Option<Arc<SizeProbe>> {
    if !enabled() {
        return None;
    }
    let probe = Arc::new(SizeProbe {
        id: NEXT_PROBE.fetch_add(1, Ordering::Relaxed),
        label: label.to_string(),
        started: Instant::now(),
        epoch_ms: crate::model::now_ms(),
        frame: AtomicU64::new(0),
        capture_calls: AtomicU64::new(0),
        data: Mutex::new(ProbeData::default()),
    });
    registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(label.to_string(), probe.clone());
    Some(probe)
}

pub(crate) fn active(label: &str) -> Option<Arc<SizeProbe>> {
    if !enabled() {
        return None;
    }
    registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(label)
        .cloned()
}

pub(crate) fn end(label: &str) {
    if enabled() {
        registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(label);
    }
}

pub(crate) fn window_event(label: &str, kind: &'static str) {
    if let Some(probe) = active(label) {
        probe
            .data
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .events
            .push((probe.frame(), kind));
    }
}

fn all_active() -> Vec<Arc<SizeProbe>> {
    registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .values()
        .cloned()
        .collect()
}

pub(crate) struct WriteProbe {
    id: u64,
    file: String,
    started: Instant,
    initial: Vec<Arc<SizeProbe>>,
}

pub(crate) fn write_begin(path: &Path) -> Option<WriteProbe> {
    if !enabled() {
        return None;
    }
    let ticket = WriteProbe {
        id: NEXT_WRITE.fetch_add(1, Ordering::Relaxed),
        file: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        started: Instant::now(),
        initial: all_active(),
    };
    for probe in &ticket.initial {
        probe
            .data
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .writes
            .push(WriteSample {
                id: ticket.id,
                file: ticket.file.clone(),
                stage: "begin",
                success: None,
                elapsed_us: 0,
                started_running: true,
                finished_running: false,
            });
    }
    Some(ticket)
}

pub(crate) fn write_end(ticket: Option<WriteProbe>, success: bool) {
    let Some(ticket) = ticket else {
        return;
    };
    let current = all_active();
    let mut probes = ticket.initial.clone();
    for probe in &current {
        if !probes.iter().any(|p| p.id == probe.id) {
            probes.push(probe.clone());
        }
    }
    for probe in probes {
        probe
            .data
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .writes
            .push(WriteSample {
                id: ticket.id,
                file: ticket.file.clone(),
                stage: "end",
                success: Some(success),
                elapsed_us: ticket.started.elapsed().as_micros(),
                started_running: ticket.initial.iter().any(|p| p.id == probe.id),
                finished_running: current.iter().any(|p| p.id == probe.id),
            });
    }
}
