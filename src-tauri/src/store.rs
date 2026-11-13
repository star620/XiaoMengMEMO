//! 数据存储：内存状态 + notes.json / trash.json 的读写。
//! - 位置：%APPDATA%\XiaoMengMemo\（不可写时按 data_dir 的级联顺序兜底；notes.json 每日备份到 notes.bak.json）
//! - 删除的便签进回收站（trash.json），保留 30 天，可随时恢复
//! - 写盘采用「临时文件 + rename」原子替换，避免崩溃/断电留下半个 JSON
//! - 数据变化后 emit "notes-changed"，前端据此刷新

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use chrono::{Datelike, Days, Local, LocalResult, TimeZone, Timelike, Weekday};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::model::{
    self, Note, NoteKind, Settings, Snapshot, TodoItem, TrashEntry, TrashFile, TrashItem,
    VaultItem, WindowState,
};
use crate::{
    log_line, EVENT_NOTES_CHANGED, EVENT_NOTE_FOCUS, EVENT_REMINDER_DUE, EVENT_SETTINGS_CHANGED,
};

/// 只带一个便签 id 的事件负载（reminder-due / note-focus）
#[derive(Debug, Clone, Serialize)]
pub struct IdPayload {
    pub id: String,
}

/// 每张便签最多保留多少条修改记录
const HISTORY_KEEP: usize = 60;

/// 历史文件 history/<id>.json 的结构
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct HistoryFile {
    #[serde(default)]
    versions: Vec<NoteVersion>,
}

/// 一版历史：只存会被修改的正文部分，窗口几何/颜色等不进历史
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteVersion {
    pub ts: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub todos: Vec<TodoItem>,
    /// 随身笔记的条目也要进历史（旧历史文件没有这个字段，读出来是空）
    #[serde(default)]
    pub items: Vec<VaultItem>,
}

/// 给前端的版本摘要（列表里只显示这些，不传整篇正文）
#[derive(Debug, Clone, Serialize)]
pub struct VersionMeta {
    pub ts: i64,
    pub title: String,
    pub chars: usize,
    pub preview: String,
}

/// 单个历史版本的完整内容：列表只给摘要，用户点开某一版时才拉全文
#[derive(Debug, Clone, Serialize)]
pub struct VersionDetail {
    pub ts: i64,
    pub title: String,
    pub content: String,
    pub todos: Vec<TodoItem>,
    pub items: Vec<VaultItem>,
    pub chars: usize,
}

/// 导入备份文件的结果：成功导入多少条、因 id 重复跳过多少条
#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
}

/// 上一次写滚动快照的 Unix 秒（内存记录）：避免每次保存都扫一遍 backups 目录
static LAST_SNAPSHOT_SECS: AtomicU64 = AtomicU64::new(0);

/// 回收站保留 30 天（毫秒），过期条目在启动时清理
const TRASH_KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// 首次启动欢迎便签的正文：只讲三个最常用的操作，别吓到编程小白
fn welcome_text(hotkey: &str) -> String {
    let action = if hotkey.trim().is_empty() {
        "右键托盘图标选择新建便签，就能开始记下一件事".to_string()
    } else {
        format!("任何时候按 {}，都能在鼠标位置新建一张便签", hotkey.trim())
    };
    format!(
        "欢迎来到小梦备忘录！

1. 直接在这里写字，按 Ctrl+S 保存（每次改动也会自动保存）
2. 内容写长了，直接在正文里滚鼠标滚轮，纸边会淡出去
3. {action}

关掉便签不会丢数据，右键托盘上的小图标就能找回来。"
    )
}

/// 全部内存状态，统一放在一把锁后面
pub struct AppState {
    pub notes: Vec<Note>,
    pub settings: Settings,
    /// 有未落盘的内存改动（主要是窗口移动/缩放，等定时线程或退出时统一写盘）
    pub dirty: bool,
    /// 本次运行已经弹过提醒的便签 id，避免同一条提醒反复弹
    pub reminded: HashSet<String>,
    /// 提醒窗口当前展示的便签 id
    pub current_reminder: Option<String>,
}

/// 数据仓库。用 Mutex 保护，锁中毒时继续用内部数据（不让一次 panic 毁掉整个应用）
pub struct Store {
    state: Mutex<AppState>,
    dir: PathBuf,
    notes_path: PathBuf,
    bak_path: PathBuf,
    /// 回收站（单独存 trash.json，和便签列表互不影响）
    trash: Mutex<Vec<TrashEntry>>,
    trash_path: PathBuf,
}

/// 应用数据目录，按优先级挑第一个「真的能写」的：
/// 1. %APPDATA%\XiaoMengMemo（正常情况，随用户漫游）
/// 2. %LOCALAPPDATA%\XiaoMengMemo（漫游目录不可写时的本机目录）
/// 3. exe 同目录\data\XiaoMengMemo（便携/受限账号兜底）
/// 4. 当前目录\XiaoMengMemo（最后兜底）
///
/// 结果缓存一次；每个候选失败的原因都写进启动日志，方便排查。
pub fn data_dir() -> PathBuf {
    static CHOSEN: OnceLock<PathBuf> = OnceLock::new();
    CHOSEN
        .get_or_init(|| {
            let mut candidates: Vec<PathBuf> = Vec::new();
            if let Ok(appdata) = std::env::var("APPDATA") {
                if !appdata.trim().is_empty() {
                    candidates.push(PathBuf::from(appdata).join("XiaoMengMemo"));
                }
            }
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                if !local.trim().is_empty() {
                    candidates.push(PathBuf::from(local).join("XiaoMengMemo"));
                }
            }
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    candidates.push(dir.join("data").join("XiaoMengMemo"));
                }
            }
            if let Ok(cwd) = std::env::current_dir() {
                candidates.push(cwd.join("XiaoMengMemo"));
            }

            for candidate in candidates.iter() {
                match probe_writable(candidate) {
                    Ok(()) => {
                        crate::boot_log(&format!("data_dir: 选用 {}", candidate.display()));
                        return candidate.clone();
                    }
                    Err(err) => {
                        crate::boot_log(&format!(
                            "data_dir: 候选不可写 {}（{err}）",
                            candidate.display()
                        ));
                    }
                }
            }

            // 全部不可写：仍返回首选路径，让上层照常报错（日志里已经写明每个候选为什么失败）
            let fallback = candidates
                .first()
                .cloned()
                .unwrap_or_else(|| PathBuf::from("XiaoMengMemo"));
            crate::boot_log(&format!(
                "data_dir: 所有候选都不可写，退回 {}",
                fallback.display()
            ));
            fallback
        })
        .clone()
}

/// 目录可用判定：不只看能不能建目录，还要真的写一个探针文件再删掉
fn probe_writable(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| format!("创建目录失败：{err}"))?;
    let probe = dir.join(format!(".write-probe-{}", std::process::id()));
    let mut file = fs::File::create(&probe).map_err(|err| format!("创建探针文件失败：{err}"))?;
    file.write_all(b"xiaomeng")
        .map_err(|err| format!("写探针文件失败：{err}"))?;
    drop(file);
    fs::remove_file(&probe).map_err(|err| format!("删除探针文件失败：{err}"))?;
    Ok(())
}

impl Store {
    /// 打开数据仓库：读盘 → 校验 → 首次运行写一份默认数据
    pub fn open() -> Store {
        let dir = data_dir();
        if let Err(err) = fs::create_dir_all(&dir) {
            log_line(format!("创建数据目录失败（{}）：{err}", dir.display()));
        }
        let notes_path = dir.join("notes.json");
        let bak_path = dir.join("notes.bak.json");
        let trash_path = dir.join("trash.json");
        let (notes, settings, fresh) = load_data(&notes_path, &bak_path);
        let mut trash = load_trash(&trash_path);
        // 回收站只保留最近 30 天：太久没恢复的条目在启动时清掉
        let before = trash.len();
        let cutoff = model::now_ms() - TRASH_KEEP_MS;
        trash.retain(|entry| entry.deleted_at > cutoff);
        let pruned = trash.len() != before;
        let store = Store {
            state: Mutex::new(AppState {
                notes,
                settings,
                dirty: false,
                reminded: HashSet::new(),
                current_reminder: None,
            }),
            dir,
            notes_path,
            bak_path,
            trash: Mutex::new(trash),
            trash_path,
        };
        store.init_snapshot_clock();
        if fresh {
            let state = store.lock();
            if let Err(err) = store.persist(&state) {
                log_line(format!("写入初始数据失败：{err}"));
            }
        }
        if pruned {
            let trash = store.lock_trash();
            if let Err(err) = store.persist_trash(trash.as_slice()) {
                log_line(format!("清理过期回收站失败：{err}"));
            }
            log_line("回收站里超过 30 天的条目已清理");
        }
        store
    }

    /// 数据目录
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn lock(&self) -> MutexGuard<'_, AppState> {
        match self.state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                // 上一次持锁的线程 panic 了：数据可能处于中间状态，但继续用总比整个应用崩掉好
                log_line("便签数据锁被上次的异常污染，正在恢复（数据可能不是最新的）");
                poisoned.into_inner()
            }
        }
    }

    fn lock_trash(&self) -> MutexGuard<'_, Vec<TrashEntry>> {
        match self.trash.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log_line("回收站数据锁被上次的异常污染，正在恢复");
                poisoned.into_inner()
            }
        }
    }

    /// 给前端的完整快照
    pub fn snapshot(&self) -> Snapshot {
        let state = self.lock();
        Snapshot {
            notes: state.notes.clone(),
            settings: state.settings.clone(),
        }
    }

    pub fn settings(&self) -> Settings {
        self.lock().settings.clone()
    }

    pub fn note(&self, id: &str) -> Option<Note> {
        self.lock().notes.iter().find(|note| note.id == id).cloned()
    }

    /// 全部便签（含已隐藏的，托盘「显示全部」用）
    pub fn all_notes(&self) -> Vec<Note> {
        self.lock().notes.clone()
    }

    /// 启动时要恢复窗口的便签（跳过硬隐藏的）
    pub fn restore_notes(&self) -> Vec<Note> {
        self.lock()
            .notes
            .iter()
            .filter(|note| !note.hidden)
            .cloned()
            .collect()
    }

    pub fn emit_notes_changed(&self, app: &AppHandle) {
        let _ = app.emit(EVENT_NOTES_CHANGED, ());
    }

    pub fn emit_note_focus(&self, app: &AppHandle, id: &str) {
        let _ = app.emit(EVENT_NOTE_FOCUS, IdPayload { id: id.to_string() });
    }

    pub fn emit_reminder_due(&self, app: &AppHandle, id: &str) {
        let _ = app.emit(EVENT_REMINDER_DUE, IdPayload { id: id.to_string() });
    }

    // ---------- 便签增删改 ----------

    /// 新建便签（at 是逻辑像素坐标，None 时由窗口层居中）
    pub fn create_note(
        &self,
        app: &AppHandle,
        kind: NoteKind,
        at: Option<(f64, f64)>,
    ) -> Result<Note, String> {
        let note = {
            let mut state = self.lock();
            let settings = state.settings.clone();
            let note = Note::new(
                kind,
                &settings.default_color,
                settings.default_font_scale,
                at,
            );
            state.notes.push(note.clone());
            self.persist_then_clean(&mut state)?;
            note
        };
        self.emit_notes_changed(app);
        Ok(note)
    }

    /// 首次启动的欢迎便签：快捷键、颜色和字号跟当前设置走，不改已有正文。
    pub fn seed_welcome_note(&self, app: &AppHandle) -> Result<Note, String> {
        let note = {
            let mut state = self.lock();
            let settings = state.settings.clone();
            let mut note = Note::new(
                NoteKind::Memo,
                &settings.default_color,
                settings.default_font_scale,
                None,
            );
            note.title = "你好，我是小梦".to_string();
            note.content = welcome_text(&settings.hotkey_new_note);
            state.notes.push(note.clone());
            self.persist_then_clean(&mut state)?;
            note
        };
        self.emit_notes_changed(app);
        Ok(note)
    }

    /// 保存便签：存在则覆盖，不存在则追加
    pub fn save_note(&self, app: &AppHandle, note: Note) -> Result<Note, String> {
        let saved = self.save_note_core(note)?;
        self.emit_notes_changed(app);
        Ok(saved)
    }

    /// 保存的核心逻辑（不 emit 事件，方便单测直接调用）
    fn save_note_core(&self, mut note: Note) -> Result<Note, String> {
        if note.content.chars().count() > 200_000 {
            return Err("便签内容太长啦（最多 20 万字）".to_string());
        }
        if note.todos.len() > 1000 {
            return Err("待办条目太多啦（最多 1000 条）".to_string());
        }
        if note.items.len() > 1000 {
            return Err("随身笔记条目太多啦（最多 1000 条）".to_string());
        }
        note.updated_at = model::now_ms();
        note.font_scale = model::clamp_font_scale(note.font_scale);
        // 只做合法性归一化，不再因为「还没定提醒时间」把 repeat 清掉：
        // 用户可能先选「每天」再由前端补上起点时间，中间任何一次保存都不该丢掉这个选择。
        note.repeat = model::normalize_repeat(&note.repeat);
        if note.color.trim().is_empty() {
            note.color = "yellow".to_string();
        }
        if note.title.chars().count() > 200 {
            note.title = note.title.chars().take(200).collect();
        }
        if note.id.trim().is_empty() {
            note.id = model::new_id("note");
        }
        {
            let mut state = self.lock();
            // 先把旧状态克隆出来：历史记录要用，而且后面会改 state.notes
            let previous = state.notes.iter().find(|item| item.id == note.id).cloned();
            // 创建时间、窗口位置大小、是否隐藏都由后端维护：
            // 前端只是保存正文，可能传来旧的 / 空的几何信息，不能让它覆盖真实状态
            if let Some(existing) = previous.as_ref() {
                note.x = existing.x;
                note.y = existing.y;
                note.width = existing.width;
                note.height = existing.height;
                note.collapsed = existing.collapsed;
                note.hidden = existing.hidden;
                note.created_at = existing.created_at;
                // 锁定状态也由后端说了算（前端可能传来旧快照里的 false）
                note.locked = existing.locked;
                if existing.locked {
                    // 锁定便签只允许改外观/位置/提醒，正文一律沿用后端已有的内容
                    note.title = existing.title.clone();
                    note.content = existing.content.clone();
                    note.todos = existing.todos.clone();
                    // 随身笔记的条目也算正文；眼睛的开合（reveal）只是显示方式，跟随前端
                    note.items = existing.items.clone();
                }
            } else if note.created_at <= 0 {
                note.created_at = model::now_ms();
            }
            // 写新值之前，把「旧状态」记进修改记录（内容没变会自动跳过，失败也不影响保存）
            if let Some(previous) = previous.as_ref() {
                self.record_version(previous, &note);
            }
            let index = state
                .notes
                .iter()
                .position(|existing| existing.id == note.id);
            match index {
                Some(index) => state.notes[index] = note.clone(),
                None => state.notes.push(note.clone()),
            }
            self.persist_then_clean(&mut state)?;
        }
        Ok(note)
    }

    // ---------- 修改记录（版本历史） ----------

    /// 单张便签的历史文件路径：history/<id>.json。
    /// id 只保留安全字符，避免任何路径穿越。
    fn history_path(&self, id: &str) -> PathBuf {
        let safe: String = id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                    ch
                } else {
                    '_'
                }
            })
            .take(80)
            .collect();
        let safe = if safe.is_empty() {
            "unknown".to_string()
        } else {
            safe
        };
        self.dir.join("history").join(format!("{safe}.json"))
    }

    /// 读历史；文件不存在或坏了都当成没有历史（坏文件保留不动，只写日志）
    fn load_versions(&self, id: &str) -> Vec<NoteVersion> {
        let path = self.history_path(id);
        let Ok(text) = fs::read_to_string(&path) else {
            return Vec::new();
        };
        match serde_json::from_str::<HistoryFile>(&text) {
            Ok(file) => file.versions,
            Err(err) => {
                log_line(format!("历史文件读不出来（{}）：{err}", path.display()));
                Vec::new()
            }
        }
    }

    fn save_versions(&self, id: &str, versions: &[NoteVersion]) -> Result<(), String> {
        let path = self.history_path(id);
        let data = serde_json::to_vec_pretty(&HistoryFile {
            versions: versions.to_vec(),
        })
        .map_err(|err| format!("历史序列化失败：{err}"))?;
        write_atomic(&path, &data).map_err(|err| format!("写历史文件失败：{err}"))
    }

    /// 记录一版旧状态：内容没变跳过，与最新一版相同跳过，最多 60 版；失败只写日志
    fn record_version(&self, previous: &Note, next: &Note) {
        // 正文完全没变（只是拖了窗口 / 改了颜色）就不算一次修改
        if same_note_content(previous, next) {
            return;
        }
        let mut versions = self.load_versions(&previous.id);
        let same_as_latest = versions.last().is_some_and(|latest| {
            latest.title == previous.title
                && latest.content == previous.content
                && latest.items == previous.items
                && latest.todos.len() == previous.todos.len()
                && todos_json(&latest.todos) == todos_json(&previous.todos)
        });
        if same_as_latest {
            return;
        }
        let mut ts = model::now_ms();
        if let Some(latest) = versions.last() {
            // 同一毫秒里连续保存两次时，保证 ts 严格递增，前端按 ts 恢复不会撞车
            if latest.ts >= ts {
                ts = latest.ts + 1;
            }
        }
        versions.push(NoteVersion {
            ts,
            title: previous.title.clone(),
            content: previous.content.clone(),
            todos: previous.todos.clone(),
            items: previous.items.clone(),
        });
        if versions.len() > HISTORY_KEEP {
            let drop_count = versions.len() - HISTORY_KEEP;
            versions.drain(0..drop_count);
        }
        if let Err(err) = self.save_versions(&previous.id, &versions) {
            log_line(format!("记录便签历史失败（{err}），不影响本次保存"));
        }
    }

    /// 给前端的版本列表（最新的在前）
    pub fn list_note_versions(&self, id: &str) -> Result<Vec<VersionMeta>, String> {
        let mut versions = self.load_versions(id);
        versions.sort_by_key(|version| std::cmp::Reverse(version.ts));
        Ok(versions
            .into_iter()
            .map(|version| {
                let preview = {
                    let text = preview_text(&version.content);
                    if !text.is_empty() {
                        text
                    } else {
                        // 随身笔记的正文在 items 里：版本列表别显示空白行，改用条目名字
                        let labels = version
                            .items
                            .iter()
                            .map(|item| item.label.trim())
                            .filter(|label| !label.is_empty())
                            .collect::<Vec<_>>()
                            .join("、");
                        preview_text(&labels)
                    }
                };
                // 随身笔记没有正文：字符数把条目里的名字和内容也算上，别显示「0 字」
                let chars = version.content.chars().count()
                    + version
                        .items
                        .iter()
                        .map(|item| item.label.chars().count() + item.value.chars().count())
                        .sum::<usize>();
                VersionMeta {
                    ts: version.ts,
                    title: version.title,
                    chars,
                    preview,
                }
            })
            .collect())
    }

    /// 读某一版完整内容：前端点开历史条目时调用
    pub fn get_note_version(&self, id: &str, ts: i64) -> Result<VersionDetail, String> {
        let Some(version) = self
            .load_versions(id)
            .into_iter()
            .find(|version| version.ts == ts)
        else {
            return Err("没找到这个历史版本".to_string());
        };
        let chars = version.content.chars().count();
        Ok(VersionDetail {
            ts: version.ts,
            title: version.title,
            content: version.content,
            todos: version.todos,
            items: version.items,
            chars,
        })
    }

    /// 恢复到某个历史版本（不 emit，方便单测）
    pub fn restore_version_inner(&self, id: &str, ts: i64) -> Result<Note, String> {
        let Some(version) = self
            .load_versions(id)
            .into_iter()
            .find(|version| version.ts == ts)
        else {
            return Err("没找到这个历史版本".to_string());
        };
        let (previous, restored) = {
            let mut state = self.lock();
            let index = self.index_of(&state, id)?;
            let previous = state.notes[index].clone();
            let note = &mut state.notes[index];
            note.title = version.title;
            note.content = version.content;
            note.todos = version.todos;
            note.items = version.items;
            note.updated_at = model::now_ms();
            let restored = note.clone();
            self.persist_then_clean(&mut state)?;
            (previous, restored)
        };
        // 恢复也要先把"恢复前的当前内容"记一版，否则这次恢复会把还没存进历史的正文直接冲掉
        self.record_version(&previous, &restored);
        Ok(restored)
    }

    /// 恢复到某个历史版本（命令层用，写完通知前端刷新）
    pub fn restore_note_version(&self, app: &AppHandle, id: &str, ts: i64) -> Result<Note, String> {
        let note = self.restore_version_inner(id, ts)?;
        self.emit_notes_changed(app);
        Ok(note)
    }

    /// 删除便签：移进回收站（窗口由命令层负责销毁）
    pub fn delete_note(&self, app: &AppHandle, id: &str) -> Result<bool, String> {
        let removed = self.delete_note_inner(id)?;
        if removed {
            self.emit_notes_changed(app);
        }
        Ok(removed)
    }

    /// 删除的实际逻辑（不 emit，方便单测）：便签进回收站
    fn delete_note_inner(&self, id: &str) -> Result<bool, String> {
        let mut state = self.lock();
        let Some(index) = state.notes.iter().position(|note| note.id == id) else {
            return Ok(false);
        };
        let removed_note = state.notes[index].clone();
        {
            // 先落回收站，再动便签列表：两步之间出错也能回滚，不会把便签弄丢
            let mut trash = self.lock_trash();
            trash.insert(
                0,
                TrashEntry {
                    note: removed_note.clone(),
                    deleted_at: model::now_ms(),
                },
            );
            if let Err(err) = self.persist_trash(trash.as_slice()) {
                trash.remove(0);
                return Err(err);
            }
        }
        state.notes.remove(index);
        state.reminded.remove(id);
        if state.current_reminder.as_deref() == Some(id) {
            state.current_reminder = None;
        }
        if let Err(err) = self.persist_then_clean(&mut state) {
            // 便签列表写盘失败：把便签放回内存，回收站里的那条也撤掉
            state.notes.insert(index, removed_note);
            let mut trash = self.lock_trash();
            trash.retain(|entry| entry.note.id != id);
            if let Err(trash_err) = self.persist_trash(trash.as_slice()) {
                log_line(format!("回滚回收站失败：{trash_err}"));
            }
            return Err(err);
        }
        drop(state);
        Ok(true)
    }

    // ---------- 回收站 ----------

    /// 回收站列表（按删除时间倒序，只带摘要）
    pub fn list_trash(&self) -> Vec<TrashItem> {
        let mut trash = self.lock_trash();
        trash.sort_by_key(|entry| std::cmp::Reverse(entry.deleted_at));
        trash
            .iter()
            .map(|entry| TrashItem {
                id: entry.note.id.clone(),
                kind: entry.note.kind,
                title: entry.note.window_title(),
                preview: trash_preview(&entry.note),
                deleted_at: entry.deleted_at,
            })
            .collect()
    }

    /// 从回收站恢复便签（窗口由前端再调 open_note_window 打开）
    pub fn restore_note(&self, app: &AppHandle, id: &str) -> Result<Note, String> {
        let note = self.restore_note_inner(id)?;
        self.emit_notes_changed(app);
        Ok(note)
    }

    fn restore_note_inner(&self, id: &str) -> Result<Note, String> {
        let mut state = self.lock();
        let mut trash = self.lock_trash();
        let index = trash
            .iter()
            .position(|entry| entry.note.id == id)
            .ok_or_else(|| format!("回收站里没有这张便签：{id}"))?;
        let TrashEntry {
            mut note,
            deleted_at,
        } = trash.remove(index);
        note.hidden = false;
        note.pinned = false;
        note.updated_at = model::now_ms();
        // 理论上 id 不会撞车；真撞上就换个新 id，别让两张便签共用一个窗口
        if state.notes.iter().any(|existing| existing.id == note.id) {
            note.id = model::new_id("note");
        }
        state.notes.push(note.clone());
        if let Err(err) = self.persist_then_clean(&mut state) {
            // 写盘失败：把便签塞回回收站，内存状态也退回去
            state.notes.retain(|existing| existing.id != note.id);
            trash.insert(index, TrashEntry { note, deleted_at });
            return Err(err);
        }
        if let Err(err) = self.persist_trash(trash.as_slice()) {
            // 便签已经恢复了，这里失败只影响回收站文件，记日志即可
            log_line(format!("恢复便签后清理回收站失败：{err}"));
        }
        drop(trash);
        drop(state);
        Ok(note)
    }

    /// 清空回收站，返回清掉的条数
    pub fn empty_trash(&self) -> Result<usize, String> {
        let mut trash = self.lock_trash();
        let count = trash.len();
        if count == 0 {
            return Ok(0);
        }
        trash.clear();
        self.persist_trash(trash.as_slice())?;
        Ok(count)
    }

    /// 设置置顶（窗口的 always_on_top 由命令层同步）
    pub fn set_pinned(&self, app: &AppHandle, id: &str, pinned: bool) -> Result<(), String> {
        {
            let mut state = self.lock();
            let index = self.index_of(&state, id)?;
            state.notes[index].pinned = pinned;
            state.notes[index].updated_at = model::now_ms();
            self.persist_then_clean(&mut state)?;
        }
        self.emit_notes_changed(app);
        Ok(())
    }

    /// 标记窗口显示/隐藏（隐藏的便签下次启动不自动打开窗口）
    pub fn set_hidden(&self, app: &AppHandle, ids: &[String], hidden: bool) -> Result<(), String> {
        let changed = {
            let mut state = self.lock();
            let mut changed = false;
            for note in state.notes.iter_mut() {
                if ids.iter().any(|id| id == &note.id) && note.hidden != hidden {
                    note.hidden = hidden;
                    changed = true;
                }
            }
            if changed {
                self.persist_then_clean(&mut state)?;
            }
            changed
        };
        if changed {
            self.emit_notes_changed(app);
        }
        Ok(())
    }

    /// 单条主动打开成功后恢复显示语义；原生打开失败时保留 hidden。
    /// 原生窗口操作在 Store 锁外执行，避免建窗/窗口事件反向取锁。
    pub fn reopen_note_with(
        &self,
        id: &str,
        open: impl FnOnce(&Note) -> Result<(), String>,
    ) -> Result<bool, String> {
        let note = self.note(id).ok_or_else(|| format!("便签不存在：{id}"))?;
        open(&note)?;
        let mut state = self.lock();
        let note = state
            .notes
            .iter_mut()
            .find(|note| note.id == id)
            .ok_or_else(|| format!("便签不存在：{id}"))?;
        if !note.hidden {
            return Ok(false);
        }
        note.hidden = false;
        state.dirty = true;
        self.persist_then_clean(&mut state)?;
        Ok(true)
    }

    // ---------- 窗口位置 ----------

    /// 窗口移动/缩放：只记内存，等定时线程或退出时统一写盘（避免频繁 IO）
    pub fn update_window_geometry(&self, id: &str, rect: WindowState) {
        let probe = crate::size_probe::active(&crate::windows::note_label(id));
        let measured = std::time::Instant::now();
        let mut state = self.lock();
        let wait_us = measured.elapsed().as_micros();
        if let Some(probe) = &probe {
            probe.store_wait(wait_us);
        }
        let Some(note) = state.notes.iter_mut().find(|note| note.id == id) else {
            return;
        };
        let record_size = !crate::windows::is_size_changing(&crate::windows::note_label(id));
        let changed =
            apply_window_geometry(note, crate::size_host::normalize(note, rect), record_size);
        state.dirty |= changed;
    }

    /// 前端 save_window_state：立刻落盘（拖动结束后调用，重要位置不丢）
    pub fn save_window_state(
        &self,
        _app: &AppHandle,
        id: &str,
        rect: WindowState,
    ) -> Result<(), String> {
        // 前端传来的数字不可信：NaN / 无穷大存进去，下次启动就会把窗口放到屏幕外，
        // 用户再也找不回来。直接拒绝并提示，前端随后会再用真实窗口位置重报一次。
        if !rect.x.is_finite()
            || !rect.y.is_finite()
            || !rect.width.is_finite()
            || !rect.height.is_finite()
        {
            return Err("窗口位置不是有效数字，已忽略".to_string());
        }
        {
            let mut state = self.lock();
            let index = match state.notes.iter().position(|note| note.id == id) {
                Some(index) => index,
                None => return Ok(()), // 便签可能刚被删掉，忽略即可
            };
            let record_size = !crate::windows::is_size_changing(&crate::windows::note_label(id));
            let rect = crate::size_host::normalize(&state.notes[index], rect);
            apply_window_geometry(&mut state.notes[index], rect, record_size);
            self.persist_then_clean(&mut state)?;
        }
        Ok(())
    }

    // ---------- 折叠 / 导出 / 从备份恢复 ----------

    /// 折叠 / 展开一张便签。只改数据，窗口高度由命令层调 windows::apply_collapsed
    ///
    /// expanded_height：折叠前这一刻的真实窗口高度（逻辑像素）。折叠会把窗口压到 64px，
    /// 如果不先把高度记下来，展开时用的就是上一次保存的高度（很可能已经被 64 覆盖），便签就弹不回去。
    pub fn set_collapsed(
        &self,
        app: &AppHandle,
        id: &str,
        collapsed: bool,
        expanded_height: Option<f64>,
    ) -> Result<Note, String> {
        let note = {
            let mut state = self.lock();
            let index = self.index_of(&state, id)?;
            if collapsed && !state.notes[index].collapsed {
                if let Some(height) = expanded_height {
                    if height.is_finite() && height >= crate::windows::MIN_EXPANDED_HEIGHT {
                        state.notes[index].height = Some(height);
                    }
                }
            } else if !collapsed {
                // 展开：记忆高度如果小于一个正常便签（比如动画中途被写成了 73 / 120），
                // 就回落到默认高度，别让用户展开出一张压在 120px 的窄条。
                let too_short = state.notes[index]
                    .height
                    .map(|h| h < crate::windows::MIN_EXPANDED_HEIGHT)
                    .unwrap_or(true);
                if too_short {
                    state.notes[index].height = Some(crate::windows::DEFAULT_HEIGHT);
                }
            }
            state.notes[index].collapsed = collapsed;
            state.notes[index].updated_at = model::now_ms();
            let note = state.notes[index].clone();
            self.persist_then_clean(&mut state)?;
            note
        };
        self.emit_notes_changed(app);
        Ok(note)
    }

    /// 三档尺寸（紧凑 / 标准 / 大）：只改数据，窗口尺寸由命令层调 windows::apply_size
    pub fn set_note_size(
        &self,
        app: &AppHandle,
        id: &str,
        width: f64,
        height: f64,
    ) -> Result<Note, String> {
        if !width.is_finite()
            || !height.is_finite()
            || width < crate::windows::MIN_WIDTH
            || height < crate::windows::MIN_HEIGHT
        {
            return Err("便签大小不是有效尺寸，已忽略".to_string());
        }
        let note = {
            let mut state = self.lock();
            let index = self.index_of(&state, id)?;
            if crate::size_host::enabled() {
                let note = &mut state.notes[index];
                note.x = crate::size_host::resized_x(
                    note.x,
                    note.width.unwrap_or(crate::windows::DEFAULT_WIDTH),
                    width,
                );
            }
            state.notes[index].width = Some(width);
            state.notes[index].height = Some(height);
            state.notes[index].updated_at = model::now_ms();
            let note = state.notes[index].clone();
            self.persist_then_clean(&mut state)?;
            note
        };
        self.emit_notes_changed(app);
        Ok(note)
    }

    /// 锁定 / 解锁一张便签。锁定后 save_note 会守住正文，不允许前端拿旧快照覆盖
    pub fn set_locked(&self, app: &AppHandle, id: &str, locked: bool) -> Result<Note, String> {
        let note = {
            let mut state = self.lock();
            let index = self.index_of(&state, id)?;
            state.notes[index].locked = locked;
            state.notes[index].updated_at = model::now_ms();
            let note = state.notes[index].clone();
            self.persist_then_clean(&mut state)?;
            note
        };
        self.emit_notes_changed(app);
        Ok(note)
    }

    /// 导出全部便签到桌面：一份 Markdown（人看）+ 一份 JSON（备份 / 换电脑用）。
    /// 返回 Markdown 文件的完整路径（前端拿去 toast / 展示），不是目录。
    pub fn export_notes(&self) -> Result<String, String> {
        let (notes, settings) = {
            let state = self.lock();
            (state.notes.clone(), state.settings.clone())
        };
        let dir = desktop_dir();
        fs::create_dir_all(&dir).map_err(|err| format!("创建导出目录失败：{err}"))?;
        // 按任务书命名：小梦备忘录导出-20261111-1650.md / .json，直接放桌面
        let stamp = Local::now().format("%Y%m%d-%H%M").to_string();
        let md_path = dir.join(format!("小梦备忘录导出-{stamp}.md"));
        let json_path = dir.join(format!("小梦备忘录导出-{stamp}.json"));

        let mut md = String::new();
        md.push_str("# 小梦备忘录 · 导出\n\n");
        md.push_str(&format!(
            "导出时间：{}　共 {} 张便签\n\n---\n\n",
            Local::now().format("%Y-%m-%d %H:%M"),
            notes.len()
        ));
        let mut ordered: Vec<&Note> = notes.iter().collect();
        // 置顶的、最近改动的排前面，和面板里的顺序一致
        ordered.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        for note in ordered {
            let title = {
                let title = note.title.trim();
                if !title.is_empty() {
                    title.to_string()
                } else {
                    let first = note.content.lines().next().unwrap_or("").trim();
                    if first.is_empty() {
                        match note.kind {
                            NoteKind::Memo => "（无标题便签）".to_string(),
                            NoteKind::Todo => "（无标题待办）".to_string(),
                            NoteKind::Vault => "（无标题随身笔记）".to_string(),
                        }
                    } else {
                        first.chars().take(40).collect()
                    }
                }
            };
            let kind = match note.kind {
                NoteKind::Memo => "便签",
                NoteKind::Todo => "待办",
                NoteKind::Vault => "随身笔记",
            };
            md.push_str(&format!("## {title}\n\n"));
            let mut meta = format!("*{kind}");
            if note.pinned {
                meta.push_str(" · 置顶");
            }
            if note.locked {
                meta.push_str(" · 已锁定");
            }
            meta.push_str(&format!(
                " · 创建 {} · 更新 {}*\n\n",
                format_ms(note.created_at),
                format_ms(note.updated_at)
            ));
            md.push_str(&meta);
            if let Some(at) = note.reminder_at {
                let repeat = match note.repeat.as_str() {
                    "daily" => "（每天）",
                    "weekdays" => "（工作日）",
                    "weekly" => "（每周）",
                    _ => "",
                };
                md.push_str(&format!("提醒：{}{}\n\n", format_ms(at), repeat));
            }
            match note.kind {
                NoteKind::Memo => {
                    if !note.content.trim().is_empty() {
                        md.push_str(note.content.trim_end());
                        md.push_str("\n\n");
                    }
                }
                NoteKind::Todo => {
                    for item in note.todos.iter() {
                        let box_ = if item.done { "x" } else { " " };
                        md.push_str(&format!("- [{box_}] {}", item.text));
                        if let Some(due) = item.due_at {
                            md.push_str(&format!("（截止 {}）", format_ms(due)));
                        }
                        md.push('\n');
                    }
                    md.push('\n');
                }
                NoteKind::Vault => {
                    // 随身笔记：一条一行，名字加粗，有备注就补在括号里
                    for item in note.items.iter() {
                        let label = item.label.trim();
                        let value = item.value.trim();
                        if label.is_empty() && value.is_empty() {
                            continue;
                        }
                        md.push_str(&format!("- **{label}**：{value}"));
                        let note_text = item.note.trim();
                        if !note_text.is_empty() {
                            md.push_str(&format!("（{note_text}）"));
                        }
                        md.push('\n');
                    }
                    md.push('\n');
                }
            }
            md.push_str("---\n\n");
        }
        // 导出文件也用原子写：写到一半断电不会留下半截文件，却骗用户说导出成功
        write_atomic(&md_path, md.as_bytes()).map_err(|err| format!("写入导出文件失败：{err}"))?;

        let snapshot = Snapshot { notes, settings };
        let json = serde_json::to_vec_pretty(&snapshot)
            .map_err(|err| format!("序列化导出数据失败：{err}"))?;
        write_atomic(&json_path, &json).map_err(|err| format!("写入备份文件失败：{err}"))?;
        // 契约要求返回文件路径（前端拿去做 toast / 展示），不是目录
        Ok(md_path.display().to_string())
    }

    /// 从每日备份（notes.bak.json）整体恢复便签列表，返回恢复条数。
    /// 用备份里的快照替换当前 notes（备份是完整快照，前端已做二次确认）。
    pub fn restore_from_backup(&self, app: &AppHandle) -> Result<usize, String> {
        if !self.bak_path.exists() {
            return Err("还没有备份文件（每天第一次保存时会自动备份一份）".to_string());
        }
        let text =
            fs::read_to_string(&self.bak_path).map_err(|err| format!("读取备份失败：{err}"))?;
        let mut snapshot: Snapshot = serde_json::from_str(&text)
            .map_err(|err| format!("备份文件读不出来（可能已损坏）：{err}"))?;
        sanitize(&mut snapshot);
        let count = snapshot.notes.len();
        // 备份里什么都没有就当作没恢复，别把当前列表整个清空
        if count == 0 {
            return Ok(0);
        }
        {
            let mut state = self.lock();
            // 任务书要求「替换」：备份是完整快照，整体换回去（前端已做二次确认）
            state.notes = snapshot.notes;
            state.reminded.clear();
            state.current_reminder = None;
            self.persist_then_clean(&mut state)?;
        }
        self.emit_notes_changed(app);
        Ok(count)
    }

    /// 从备份文件内容合并导入便签：同 id 跳过不覆盖，返回 {imported,skipped}。
    /// 兼容三种格式：完整快照 {notes,settings}、便签数组 [..]、单张便签 {..}。
    /// 只导入便签，不覆盖当前设置；导入的便签一律显示出来（hidden=false）。
    pub fn import_notes(&self, app: &AppHandle, text: &str) -> Result<ImportResult, String> {
        let value: serde_json::Value = serde_json::from_str(text)
            .map_err(|err| format!("这个文件不是小梦备忘录的备份（不是合法 JSON）：{err}"))?;

        let notes: Vec<Note> = match &value {
            serde_json::Value::Array(_) => serde_json::from_value(value.clone())
                .map_err(|err| format!("这个文件不是小梦备忘录的备份：{err}"))?,
            serde_json::Value::Object(map) if map.contains_key("notes") => {
                let snapshot: Snapshot = serde_json::from_value(value.clone())
                    .map_err(|err| format!("这个文件不是小梦备忘录的备份：{err}"))?;
                snapshot.notes
            }
            // 单张便签也允许：设置页会把单条便签导出成 .json
            serde_json::Value::Object(map)
                if map.contains_key("id") && map.contains_key("kind") =>
            {
                let note: Note = serde_json::from_value(value.clone())
                    .map_err(|err| format!("这个文件不是小梦备忘录的备份：{err}"))?;
                vec![note]
            }
            _ => {
                return Err("这个文件不是小梦备忘录的备份：里面找不到便签数据".to_string());
            }
        };

        // 复用启动时的脏数据清洗：补 id/时间、夹紧尺寸和字号、丢掉非法坐标
        let mut snapshot = Snapshot {
            notes,
            settings: Settings::default(),
        };
        sanitize(&mut snapshot);

        let mut result = ImportResult {
            imported: 0,
            skipped: 0,
        };
        {
            let mut state = self.lock();
            let mut seen: HashSet<String> =
                state.notes.iter().map(|note| note.id.clone()).collect();
            for mut note in snapshot.notes {
                if note.id.trim().is_empty() {
                    note.id = model::new_id("note");
                }
                // 同一份文件里重复的 id 也只留第一条
                if seen.contains(&note.id) {
                    result.skipped += 1;
                    continue;
                }
                note.hidden = false;
                seen.insert(note.id.clone());
                state.notes.push(note);
                result.imported += 1;
            }
            if result.imported == 0 {
                return Ok(result);
            }
            self.persist_then_clean(&mut state)?;
        }
        self.emit_notes_changed(app);
        Ok(result)
    }

    /// 有改动就把内存数据写盘（提醒线程每 25 秒调一次，退出前也调）
    pub fn flush(&self) -> Result<(), String> {
        let mut state = self.lock();
        if !state.dirty {
            return Ok(());
        }
        self.persist_then_clean(&mut state)?;
        Ok(())
    }

    // ---------- 设置 ----------

    pub fn save_settings(
        &self,
        app: &AppHandle,
        mut settings: Settings,
    ) -> Result<Settings, String> {
        settings.default_font_scale = model::clamp_font_scale(settings.default_font_scale);
        if settings.default_color.trim().is_empty() {
            settings.default_color = "yellow".to_string();
        }
        settings.hotkey_new_note = settings.hotkey_new_note.trim().to_string();
        settings.hotkey_show_panel = settings.hotkey_show_panel.trim().to_string();
        settings.hotkey_quick = settings.hotkey_quick.trim().to_string();
        // 纸色只认三档，写脏值会让前端主题切换失效
        settings.theme_mode = settings.theme_mode.trim().to_ascii_lowercase();
        if settings.theme_mode.is_empty() {
            settings.theme_mode = "auto".to_string();
        }
        if !matches!(settings.theme_mode.as_str(), "auto" | "day" | "night") {
            return Err("纸色设置只能是 auto / day / night（跟随时间 / 浅色 / 深色）".to_string());
        }
        {
            let mut state = self.lock();
            state.settings = settings.clone();
            self.persist_then_clean(&mut state)?;
        }
        let _ = app.emit(EVENT_SETTINGS_CHANGED, settings.clone());
        Ok(settings)
    }

    // ---------- 提醒 ----------

    pub fn current_reminder(&self) -> Option<String> {
        self.lock().current_reminder.clone()
    }

    pub fn set_current_reminder(&self, id: Option<String>) {
        self.lock().current_reminder = id;
    }

    /// 取一条到点的提醒（顺带标记已弹过，避免重复）；没有就返回 None
    pub fn take_due_reminder(&self, now: i64) -> Option<String> {
        let mut state = self.lock();
        // 先只读地找一条（不修改任何东西），找到后再标记，避免同时可变/不可变借用
        let found = state
            .notes
            .iter()
            .find(|note| {
                !note.reminder_done
                    && note
                        .reminder_at
                        .is_some_and(|reminder_at| reminder_at <= now)
                    && !state.reminded.contains(&note.id)
            })
            .map(|note| note.id.clone());
        let id = found?;
        state.reminded.insert(id.clone());
        Some(id)
    }

    /// 弹窗失败时撤销「已弹过」标记，下一个扫描周期会重试
    pub fn forget_reminded(&self, id: &str) {
        self.lock().reminded.remove(id);
    }

    /// 设置/清除提醒时间（at 为 None 表示清除）
    pub fn set_reminder(&self, app: &AppHandle, id: &str, at: Option<i64>) -> Result<(), String> {
        {
            let mut state = self.lock();
            let index = self.index_of(&state, id)?;
            state.notes[index].reminder_at = at;
            state.notes[index].reminder_done = false;
            state.notes[index].updated_at = model::now_ms();
            state.reminded.remove(id);
            self.persist_then_clean(&mut state)?;
        }
        self.emit_notes_changed(app);
        Ok(())
    }

    /// 稍后再提醒：顺延 minutes 分钟
    pub fn snooze_reminder(&self, app: &AppHandle, id: &str, minutes: i64) -> Result<(), String> {
        let minutes = minutes.clamp(1, 24 * 60);
        {
            let mut state = self.lock();
            let index = self.index_of(&state, id)?;
            state.notes[index].reminder_at = Some(model::now_ms() + minutes * 60_000);
            state.notes[index].reminder_done = false;
            state.notes[index].updated_at = model::now_ms();
            state.reminded.remove(id);
            self.persist_then_clean(&mut state)?;
        }
        self.emit_notes_changed(app);
        Ok(())
    }

    /// 知道了：不重复就标记已提醒；重复提醒则算出下一次并重新武装
    pub fn dismiss_reminder(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        {
            let mut state = self.lock();
            let index = self.index_of(&state, id)?;
            let note = &mut state.notes[index];
            let repeat = model::normalize_repeat(&note.repeat);
            if repeat.is_empty() {
                // 普通提醒：时间保留，方便前端显示「已提醒过」
                note.reminder_done = true;
            } else {
                let base = note.reminder_at.unwrap_or_else(model::now_ms);
                match next_repeat_at(base, &repeat) {
                    Some(next) => {
                        // 重复提醒：写回下一次时间，重新变回「待提醒」
                        note.reminder_at = Some(next);
                        note.reminder_done = false;
                    }
                    None => {
                        // 系统时间异常等极端情况：先标记已提醒，避免同一轮反复弹窗
                        log_line(format!(
                            "计算下一次重复提醒失败（id={id}，repeat={repeat}）"
                        ));
                        note.reminder_done = true;
                    }
                }
            }
            state.notes[index].updated_at = model::now_ms();
            state.reminded.remove(id);
            if state.current_reminder.as_deref() == Some(id) {
                state.current_reminder = None;
            }
            self.persist_then_clean(&mut state)?;
        }
        self.emit_notes_changed(app);
        Ok(())
    }

    // ---------- 内部工具 ----------

    fn index_of(&self, state: &AppState, id: &str) -> Result<usize, String> {
        state
            .notes
            .iter()
            .position(|note| note.id == id)
            .ok_or_else(|| format!("便签不存在：{id}"))
    }

    /// 写盘 + 每日备份
    fn persist(&self, state: &AppState) -> Result<(), String> {
        let snapshot = Snapshot {
            notes: state.notes.clone(),
            settings: state.settings.clone(),
        };
        let data =
            serde_json::to_vec_pretty(&snapshot).map_err(|err| format!("序列化数据失败：{err}"))?;
        write_atomic(&self.notes_path, &data).map_err(|err| format!("写入数据失败：{err}"))?;
        self.backup_daily();
        self.snapshot_roll();
        Ok(())
    }

    /// 回收站写盘（和 notes.json 一样用临时文件 + rename 原子替换）
    fn persist_trash(&self, items: &[TrashEntry]) -> Result<(), String> {
        let file = TrashFile {
            items: items.to_vec(),
        };
        let data =
            serde_json::to_vec_pretty(&file).map_err(|err| format!("序列化回收站失败：{err}"))?;
        write_atomic(&self.trash_path, &data).map_err(|err| format!("写入回收站失败：{err}"))
    }

    /// 启动时扫一次 backups/，把最近一份快照的时间记到内存。
    /// 之后每次保存只读内存判断，不再扫目录（保存路径上的一次磁盘遍历 = 每次打字都卡一下）。
    fn init_snapshot_clock(&self) {
        let Some(dir) = self.notes_path.parent() else {
            return;
        };
        let backup_dir = dir.join("backups");
        let Ok(entries) = fs::read_dir(&backup_dir) else {
            return;
        };
        let mut latest = 0u64;
        for entry in entries.flatten() {
            if let Some(stamp) = snapshot_stamp(&entry.file_name().to_string_lossy()) {
                latest = latest.max(stamp);
            }
        }
        LAST_SNAPSHOT_SECS.store(latest, Ordering::Relaxed);
    }

    /// 写盘成功才清脏标记；失败时保持 dirty=true 并上抛，
    /// 让下一次定时 flush / 退出流程一定会重试（否则用户的改动会静默丢失）。
    fn persist_then_clean(&self, state: &mut AppState) -> Result<(), String> {
        match self.persist(state) {
            Ok(()) => {
                state.dirty = false;
                Ok(())
            }
            Err(err) => {
                state.dirty = true;
                log_line(format!("保存失败，稍后会重试：{err}"));
                Err(err)
            }
        }
    }

    /// 滚动快照：每 2 分钟最多一份，保留最近 40 份（约 80 分钟的历史）。
    ///
    /// 目的不是备份硬盘，而是防"内容被误覆盖就没法回头"：历史版本多留几份，
    /// 真出事了（不管是程序 bug 还是手抖）还能从 backups/ 里捞回来。
    /// 是否到点看内存里的 LAST_SNAPSHOT_SECS，保存热路径不扫目录；
    /// 只有真的要写新快照时才读一次 backups/ 做清理。
    fn snapshot_roll(&self) {
        let Some(dir) = self.notes_path.parent() else {
            return;
        };
        let backup_dir = dir.join("backups");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let last = LAST_SNAPSHOT_SECS.load(Ordering::Relaxed);
        if last != 0 && now.saturating_sub(last) < 120 {
            return;
        }
        if fs::create_dir_all(&backup_dir).is_err() {
            return;
        }
        let target = backup_dir.join(format!("notes-{now}.json"));
        if let Err(err) = copy_measured(&self.notes_path, &target) {
            log_line(format!("滚动快照失败：{err}"));
            return;
        }
        LAST_SNAPSHOT_SECS.store(now, Ordering::Relaxed);
        // 只留最近 40 份（清理时扫一次目录就够了）
        let mut stamps: Vec<u64> = Vec::new();
        if let Ok(entries) = fs::read_dir(&backup_dir) {
            for entry in entries.flatten() {
                if let Some(stamp) = snapshot_stamp(&entry.file_name().to_string_lossy()) {
                    stamps.push(stamp);
                }
            }
        }
        if !stamps.contains(&now) {
            stamps.push(now);
        }
        stamps.sort_unstable();
        while stamps.len() > 40 {
            let old = stamps.remove(0);
            let _ = fs::remove_file(backup_dir.join(format!("notes-{old}.json")));
        }
    }

    /// 每天备份一次（按备份文件修改时间判断，超过 24 小时才覆盖）
    fn backup_daily(&self) {
        let due = match fs::metadata(&self.bak_path) {
            Ok(meta) => match meta.modified() {
                Ok(modified) => modified
                    .elapsed()
                    .map(|elapsed| elapsed.as_secs() >= 86_400)
                    .unwrap_or(true),
                Err(_) => true,
            },
            Err(_) => true,
        };
        if !due {
            return;
        }
        if let Err(err) = copy_measured(&self.notes_path, &self.bak_path) {
            log_line(format!("每日备份失败：{err}"));
        }
    }
}

/// 从 backups/notes-<秒>.json 的文件名里取出秒数
fn snapshot_stamp(name: &str) -> Option<u64> {
    name.strip_prefix("notes-")
        .and_then(|rest| rest.strip_suffix(".json"))
        .and_then(|num| num.parse::<u64>().ok())
}

/// 桌面目录：中文 Windows 的桌面可能被 OneDrive 重定向，取不到就退回 %USERPROFILE%\Desktop
fn desktop_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let desktop = PathBuf::from(profile).join("Desktop");
        if desktop.is_dir() {
            return desktop;
        }
    }
    std::env::temp_dir()
}

/// 毫秒时间戳 → 「2026-11-11 17:30」（导出文件里给人看）
fn format_ms(ms: i64) -> String {
    match Local.timestamp_millis_opt(ms) {
        LocalResult::Single(time) => time.format("%Y-%m-%d %H:%M").to_string(),
        _ => "时间未知".to_string(),
    }
}

/// 读回收站：文件不存在就当空；文件损坏就改名留档（不覆盖用户数据）后当空
fn load_trash(path: &Path) -> Vec<TrashEntry> {
    if !path.exists() {
        return Vec::new();
    }
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<TrashFile>(&text) {
            Ok(mut file) => {
                sanitize_trash(&mut file.items);
                file.items
            }
            Err(err) => {
                log_line(format!("回收站文件损坏（{}）：{err}", path.display()));
                let broken = path.with_file_name(format!("trash.corrupt-{}.json", model::now_ms()));
                let _ = fs::rename(path, broken);
                Vec::new()
            }
        },
        Err(err) => {
            log_line(format!("读取回收站失败（{}）：{err}", path.display()));
            Vec::new()
        }
    }
}

/// 清洗回收站数据：补删除时间、归一化字段、去重，丢掉没有 id 的条目
fn sanitize_trash(items: &mut Vec<TrashEntry>) {
    let now = model::now_ms();
    let mut seen: HashSet<String> = HashSet::new();
    items.retain_mut(|entry| {
        entry.note.repeat = model::normalize_repeat(&entry.note.repeat);
        entry.note.font_scale = model::clamp_font_scale(entry.note.font_scale);
        entry.note.color = if entry.note.color.trim().is_empty() {
            "yellow".to_string()
        } else {
            entry.note.color.trim().to_string()
        };
        if entry.note.title.chars().count() > 200 {
            entry.note.title = entry.note.title.chars().take(200).collect();
        }
        for item in entry.note.items.iter_mut() {
            if item.id.trim().is_empty() {
                item.id = model::new_id("vault");
            }
        }
        if entry.deleted_at <= 0 {
            entry.deleted_at = now;
        }
        let id = entry.note.id.trim().to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            return false;
        }
        entry.note.id = id;
        true
    });
}

/// 回收站列表的一行摘要：正文压平空白后前 60 字；待办优先取第一条未完成项
fn trash_preview(note: &Note) -> String {
    if note.kind == NoteKind::Vault {
        // 随身笔记优先显示第一条的名字，名字空着就显示内容
        if let Some(item) = note
            .items
            .iter()
            .find(|item| !item.label.trim().is_empty() || !item.value.trim().is_empty())
        {
            let text = if item.label.trim().is_empty() {
                item.value.trim()
            } else {
                item.label.trim()
            };
            return text.chars().take(60).collect();
        }
    }
    if note.kind == NoteKind::Todo {
        if let Some(text) = note
            .todos
            .iter()
            .find(|todo| !todo.done)
            .map(|todo| todo.text.trim())
            .filter(|text| !text.is_empty())
        {
            return text.chars().take(60).collect();
        }
    }
    let flat = note
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.is_empty() {
        // 正文是空的（比如只写了标题）就退回标题，别让列表里出现空白行
        return note.title.trim().chars().take(60).collect();
    }
    flat.chars().take(60).collect()
}

/// 重复提醒的「下一次」：按本地时区、保留原来的时:分。
/// daily = 次日，weekdays = 下一个工作日（周六/周日跳到周一），weekly = 7 天后。
/// 算不出来（系统时间异常）时返回 None。
pub fn next_repeat_at(from_ms: i64, repeat: &str) -> Option<i64> {
    let base = Local.timestamp_millis_opt(from_ms).single()?;
    let mut date = base.date_naive();
    match repeat {
        "daily" => date = date.succ_opt()?,
        "weekdays" => loop {
            date = date.succ_opt()?;
            if !matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
                break;
            }
        },
        "weekly" => date = date.checked_add_days(Days::new(7))?,
        _ => return None,
    }
    let naive = date.and_hms_opt(base.hour(), base.minute(), base.second())?;
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt.timestamp_millis()),
        // 夏令时重叠 / 不存在：取近似值即可（本机没有夏令时，实际走不到）
        LocalResult::Ambiguous(dt, _) => Some(dt.timestamp_millis()),
        LocalResult::None => Some(from_ms + 24 * 60 * 60 * 1000),
    }
}

/// 读数据：先 notes.json，失败再退回 notes.bak.json，最后用默认值
fn load_data(notes_path: &Path, bak_path: &Path) -> (Vec<Note>, Settings, bool) {
    let mut fresh = !notes_path.exists();
    let mut parsed: Option<Snapshot> = None;

    if notes_path.exists() {
        match fs::read_to_string(notes_path) {
            Ok(text) => match serde_json::from_str::<Snapshot>(&text) {
                Ok(snapshot) => parsed = Some(snapshot),
                Err(err) => {
                    log_line(format!("数据文件损坏（{}）：{err}", notes_path.display()));
                    // 把坏文件留一份，别直接覆盖掉用户数据
                    let broken = notes_path
                        .with_file_name(format!("notes.corrupt-{}.json", model::now_ms()));
                    let _ = fs::rename(notes_path, broken);
                    fresh = true;
                }
            },
            Err(err) => log_line(format!(
                "读取数据文件失败（{}）：{err}",
                notes_path.display()
            )),
        }
    }

    if parsed.is_none() && bak_path.exists() {
        match fs::read_to_string(bak_path) {
            Ok(text) => match serde_json::from_str::<Snapshot>(&text) {
                Ok(snapshot) => {
                    log_line("主数据不可用，已从每日备份恢复");
                    parsed = Some(snapshot);
                }
                Err(err) => log_line(format!("备份文件也损坏了（{}）：{err}", bak_path.display())),
            },
            Err(err) => log_line(format!("读取备份文件失败（{}）：{err}", bak_path.display())),
        }
    }

    let mut snapshot = parsed.unwrap_or_default();
    sanitize(&mut snapshot);
    (snapshot.notes, snapshot.settings, fresh)
}

/// 清洗数据：补 id、修时间、拉回字号/尺寸，保证后端不会因为脏数据崩
fn sanitize(snapshot: &mut Snapshot) {
    let now = model::now_ms();
    let mut seen: HashSet<String> = HashSet::new();
    for note in snapshot.notes.iter_mut() {
        let id = note.id.trim().to_string();
        if id.is_empty() || seen.contains(&id) {
            note.id = model::new_id("note");
        } else {
            note.id = id;
        }
        seen.insert(note.id.clone());

        note.font_scale = model::clamp_font_scale(note.font_scale);
        if note.created_at <= 0 {
            note.created_at = now;
        }
        if note.updated_at <= 0 {
            note.updated_at = note.created_at;
        }
        if note.title.chars().count() > 200 {
            note.title = note.title.chars().take(200).collect();
        }
        if note.color.trim().is_empty() {
            note.color = "yellow".to_string();
        }
        note.repeat = model::normalize_repeat(&note.repeat);

        for todo in note.todos.iter_mut() {
            if todo.id.trim().is_empty() {
                todo.id = model::new_id("todo");
            }
        }

        for item in note.items.iter_mut() {
            if item.id.trim().is_empty() {
                item.id = model::new_id("vault");
            }
        }

        note.x = note.x.filter(|value| value.is_finite());
        note.y = note.y.filter(|value| value.is_finite());
        note.width = note
            .width
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(160.0, 4000.0));
        note.height = note
            .height
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(100.0, 4000.0));
    }

    snapshot.settings.default_font_scale =
        model::clamp_font_scale(snapshot.settings.default_font_scale);
    if snapshot.settings.default_color.trim().is_empty() {
        snapshot.settings.default_color = "yellow".to_string();
    }
    snapshot.settings.hotkey_new_note = snapshot.settings.hotkey_new_note.trim().to_string();
}

/// 动画中仍记录位置，宽高只从稳定窗口采集；折叠态永远保留展开高度。
fn apply_window_geometry(note: &mut Note, rect: WindowState, record_size: bool) -> bool {
    let width = if record_size {
        Some(rect.width)
    } else {
        note.width
    };
    let height = if record_size && !note.collapsed {
        Some(rect.height)
    } else {
        note.height
    };
    let changed = note.x != Some(rect.x)
        || note.y != Some(rect.y)
        || note.width != width
        || note.height != height;
    note.x = Some(rect.x);
    note.y = Some(rect.y);
    note.width = width;
    note.height = height;
    changed
}

/// 原子写文件：先写 notes.json.tmp，再 rename 覆盖 notes.json。
///
/// rename 失败（杀毒软件 / 索引服务短暂占用文件）时最多重试 3 次；
/// 还不行就保留 .tmp 并另存一份 xxx.recover.json，**绝不退化成直接写主文件**——
/// 那会先把好数据截断，一旦写入中途失败就把用户数据写没了。
fn copy_measured(from: &Path, to: &Path) -> std::io::Result<u64> {
    let probe = crate::size_probe::write_begin(to);
    let result = fs::copy(from, to);
    crate::size_probe::write_end(probe, result.is_ok());
    result
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let probe = crate::size_probe::write_begin(path);
    let result = write_atomic_unmeasured(path, data);
    crate::size_probe::write_end(probe, result.is_ok());
    result
}

fn write_atomic_unmeasured(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "notes.json".to_string());
    let temp_path = path.with_file_name(format!("{file_name}.tmp"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    {
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(data)?;
        // 先把数据刷到磁盘，再替换，断电也不会只剩空文件
        file.sync_all()?;
    }

    let mut last_err = None;
    for attempt in 0..3u64 {
        match fs::rename(&temp_path, path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = Some(err);
                if attempt < 2 {
                    // 给占用文件的程序一点时间松手，再试一次
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
            }
        }
    }

    let rename_err = last_err.expect("循环至少执行一次");
    let recover_path = recover_path(path, &file_name);
    let saved = match fs::write(&recover_path, data) {
        Ok(()) => format!("最新数据已另存为 {}", recover_path.display()),
        Err(err) => format!("恢复副本也写失败：{err}"),
    };
    log_line(format!(
        "原子替换失败（已重试 3 次，原文件未改动）：{rename_err}；{saved}"
    ));
    Err(rename_err)
}

/// rename 一直失败时的兜底文件名：notes.json → notes.recover.json
fn recover_path(path: &Path, file_name: &str) -> PathBuf {
    let recover_name = file_name
        .strip_suffix(".json")
        .map(|stem| format!("{stem}.recover.json"))
        .unwrap_or_else(|| format!("{file_name}.recover"));
    path.with_file_name(recover_name)
}

/// 两版便签的「正文部分」是否完全相同（标题 + 正文 + 待办）
fn same_note_content(first: &Note, second: &Note) -> bool {
    first.title == second.title
        && first.content == second.content
        && first.items == second.items
        && first.todos.len() == second.todos.len()
        && todos_json(&first.todos) == todos_json(&second.todos)
}

/// 待办列表序列化成字符串再比较（TodoItem 没有实现 PartialEq）
fn todos_json(todos: &[TodoItem]) -> String {
    serde_json::to_string(todos).unwrap_or_default()
}

/// 版本列表里的一行摘要：正文压平空白后取前 40 个字
fn preview_text(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(40)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use crate::model::{self, Note, NoteKind, Settings, Snapshot, TodoItem, VaultItem};

    /// 每个测试用独立临时目录，互不干扰
    fn temp_dir(tag: &str) -> PathBuf {
        // 放在项目 target 下：会话环境可能不允许写系统临时目录
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("{tag}-{}", model::now_ms()));
        fs::create_dir_all(&dir).expect("创建测试目录");
        dir
    }

    /// 直接构造 Store（不碰真实的 %APPDATA%）
    fn test_store(dir: &Path) -> Store {
        Store {
            state: Mutex::new(AppState {
                notes: Vec::new(),
                settings: Settings::default(),
                dirty: false,
                reminded: HashSet::new(),
                current_reminder: None,
            }),
            dir: dir.to_path_buf(),
            notes_path: dir.join("notes.json"),
            bak_path: dir.join("notes.bak.json"),
            trash: Mutex::new(Vec::new()),
            trash_path: dir.join("trash.json"),
        }
    }

    #[test]
    fn 单条打开成功清除隐藏且重启恢复仅该便签() {
        let dir = temp_dir("reopen-hidden");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.hidden = true;
        let mut other = Note::new(NoteKind::Memo, "pink", 1.0, None);
        other.hidden = true;
        {
            let mut state = store.lock();
            state.notes.extend([note.clone(), other.clone()]);
            store.persist_then_clean(&mut state).expect("初始数据落盘");
        }
        let changed = store
            .reopen_note_with(&note.id, |opened| {
                // 与命令使用同一入口；替换的仅是原生建窗，且这里可以再次读取 Store。
                assert_eq!(opened.id, note.id);
                assert!(store.note(&note.id).expect("便签存在").hidden);
                Ok(())
            })
            .expect("窗口打开成功");
        assert!(changed);
        assert!(!store.note(&note.id).expect("便签存在").hidden);
        assert!(store.note(&other.id).expect("另一张便签存在").hidden);
        assert_eq!(
            store
                .restore_notes()
                .iter()
                .map(|n| &n.id)
                .collect::<Vec<_>>(),
            vec![&note.id]
        );
        let (notes, _, fresh) = load_data(&store.notes_path, &store.bak_path);
        assert!(!fresh);
        assert!(
            !notes
                .iter()
                .find(|n| n.id == note.id)
                .expect("磁盘便签存在")
                .hidden
        );
        assert!(
            notes
                .iter()
                .find(|n| n.id == other.id)
                .expect("另一张磁盘便签存在")
                .hidden
        );
        assert!(!store
            .reopen_note_with(&note.id, |_| Ok(()))
            .expect("重复打开"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn 单条打开失败不清除隐藏也不改磁盘() {
        let dir = temp_dir("reopen-failed");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.hidden = true;
        {
            let mut state = store.lock();
            state.notes.push(note.clone());
            store.persist_then_clean(&mut state).expect("初始数据落盘");
        }
        let before = fs::read(&store.notes_path).expect("读取初始文件");
        assert_eq!(
            store.reopen_note_with(&note.id, |_| Err("模拟原生打开失败".into())),
            Err("模拟原生打开失败".into())
        );
        assert!(store.note(&note.id).expect("便签存在").hidden);
        assert_eq!(before, fs::read(&store.notes_path).expect("读取失败后文件"));
        assert!(store
            .reopen_note_with("missing", |_| panic!("不存在的便签不应尝试建窗"))
            .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn 欢迎模板使用当前快捷键并处理禁用组合() {
        let text = welcome_text("Ctrl+Q");
        assert!(text.contains("按 Ctrl+Q"));
        assert!(!text.contains("Ctrl+Alt+N"));
        let disabled = welcome_text(" ");
        assert!(disabled.contains("托盘图标选择新建便签"));
        assert!(!disabled.contains("任何时候按"));
    }

    #[test]
    fn 加载已有欢迎便签保留用户正文和快捷键() {
        let dir = temp_dir("welcome-preserve");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.title = "你好，我是小梦".into();
        note.content = "用户已改写的内容，旧快捷键 Ctrl+Alt+N 也应原样保留".into();
        {
            let mut state = store.lock();
            state.settings.hotkey_new_note = "Ctrl+Q".into();
            state.notes.push(note.clone());
            store.persist_then_clean(&mut state).expect("写入测试数据");
        }
        let (notes, settings, fresh) = load_data(&store.notes_path, &store.bak_path);
        assert!(!fresh);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].content, note.content);
        assert_eq!(settings.hotkey_new_note, "Ctrl+Q");
        fs::remove_dir_all(dir).ok();
    }

    /// 用本地时区构造毫秒时间戳（测试不依赖具体时区偏移）
    fn local_ms(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        use chrono::TimeZone;
        chrono::Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .expect("应是合法的本地时间")
            .timestamp_millis()
    }

    #[test]
    fn 收起动画和折叠后的移动不会覆盖展开高度() {
        for expanded_height in [330.0, 380.0, 500.0] {
            let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
            note.width = Some(400.0);
            note.height = Some(expanded_height);
            note.collapsed = true;
            // 覆盖旧逻辑会误记的 >72px 中间帧，以及动画结束后的移动。
            for height in [304.0, 196.0, 137.0, 104.0, 86.0, 76.0, 71.0, 64.0] {
                apply_window_geometry(
                    &mut note,
                    WindowState {
                        x: 120.0,
                        y: 240.0,
                        width: 400.0,
                        height,
                    },
                    true,
                );
                assert_eq!(note.height, Some(expanded_height));
            }
            assert_eq!(note.x, Some(120.0));
            assert_eq!(note.y, Some(240.0));
        }
    }

    #[test]
    fn 尺寸命令期间记位置但保留目标宽高且失败退出后可继续采集() {
        // 只用内存，不启动应用，也不写测试目录或真实 APPDATA。
        let store = test_store(Path::new("unused-size-state-test"));
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.width = Some(400.0);
        note.height = Some(500.0);
        store.lock().notes.push(note.clone());
        let guard = crate::windows::begin_size_change(&crate::windows::note_label(&note.id));
        store.update_window_geometry(
            &note.id,
            WindowState {
                x: 80.0,
                y: 100.0,
                width: 340.0,
                height: 420.0,
            },
        );
        let captured = store.note(&note.id).expect("便签存在");
        assert_eq!((captured.x, captured.y), (Some(80.0), Some(100.0)));
        assert_eq!(
            (captured.width, captured.height),
            (Some(400.0), Some(500.0))
        );
        // 模拟命令在启动动画前返回错误：RAII 保护释放后不会永久禁止采集。
        drop(guard);
        store.update_window_geometry(
            &note.id,
            WindowState {
                x: 80.0,
                y: 100.0,
                width: 320.0,
                height: 380.0,
            },
        );
        let captured = store.note(&note.id).expect("便签存在");
        assert_eq!(
            (captured.width, captured.height),
            (Some(320.0), Some(380.0))
        );
    }

    #[test]
    fn 自动保存正文不会用旧快照回滚窗口几何和折叠状态() {
        let dir = temp_dir("save-stable-geometry");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.width = Some(320.0);
        note.height = Some(380.0);
        let mut stale = note.clone();
        stale.content = "动画期间修改的正文".to_string();
        note.x = Some(120.0);
        note.y = Some(240.0);
        note.width = Some(400.0);
        note.height = Some(500.0);
        note.collapsed = true;
        store.lock().notes.push(note);

        let saved = store.save_note_core(stale).expect("正文保存成功");
        assert_eq!(saved.content, "动画期间修改的正文");
        assert_eq!((saved.x, saved.y), (Some(120.0), Some(240.0)));
        assert_eq!((saved.width, saved.height), (Some(400.0), Some(500.0)));
        assert!(saved.collapsed);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 重复提醒的下一次按本地时区和星期计算() {
        // 2026-11-13 是周五，09:30
        let friday = local_ms(2026, 11, 13, 9, 30);
        assert_eq!(
            next_repeat_at(friday, "daily"),
            Some(local_ms(2026, 11, 14, 9, 30)),
            "每天：次日同一时刻"
        );
        assert_eq!(
            next_repeat_at(friday, "weekly"),
            Some(local_ms(2026, 11, 20, 9, 30)),
            "每周：7 天后同一时刻"
        );
        assert_eq!(
            next_repeat_at(friday, "weekdays"),
            Some(local_ms(2026, 11, 16, 9, 30)),
            "工作日：周五要跳到下周一"
        );
        assert_eq!(
            next_repeat_at(local_ms(2026, 11, 11, 18, 5), "weekdays"),
            Some(local_ms(2026, 11, 12, 18, 5)),
            "工作日：周三 → 周四，保留时:分"
        );
        assert_eq!(
            next_repeat_at(local_ms(2026, 11, 15, 8, 0), "weekdays"),
            Some(local_ms(2026, 11, 16, 8, 0)),
            "工作日：周日 → 周一"
        );
        assert_eq!(next_repeat_at(friday, ""), None, "不重复没有下一次");
        assert_eq!(next_repeat_at(friday, "hourly"), None, "未知重复方式不处理");
    }

    #[test]
    fn 删除进回收站再恢复能回到便签列表() {
        let dir = temp_dir("trash-roundtrip");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.title = "要删的便签".to_string();
        note.content = "第一行  内容\n第二行".to_string();
        {
            let mut state = store.lock();
            state.notes.push(note.clone());
            store.persist(&state).expect("写盘");
        }

        // 删除：便签列表变空，回收站多一条摘要（正文压平空白）
        assert!(store.delete_note_inner(&note.id).expect("删除便签"));
        assert!(store.lock().notes.is_empty(), "删除后便签列表应为空");
        assert!(store.trash_path.exists(), "回收站要单独写盘");
        let list = store.list_trash();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, note.id);
        assert_eq!(list[0].title, "要删的便签");
        assert_eq!(list[0].preview, "第一行 内容 第二行");
        assert_eq!(list[0].kind, NoteKind::Memo);
        // 重启后回收站还在（trash.json 能读回）
        assert_eq!(load_trash(&store.trash_path).len(), 1);

        // 恢复：回到便签列表，回收站清空
        let restored = store.restore_note_inner(&note.id).expect("恢复便签");
        assert_eq!(restored.id, note.id);
        assert!(!restored.hidden, "恢复后应可见");
        assert!(!restored.pinned, "恢复后不置顶");
        assert!(store.list_trash().is_empty(), "恢复后回收站应为空");
        assert_eq!(store.lock().notes.len(), 1, "恢复后便签列表应有 1 条");
        let (notes, _, _) = load_data(&store.notes_path, &store.bak_path);
        assert_eq!(notes.len(), 1);
        // 同一条不能恢复两次
        assert!(store.restore_note_inner(&note.id).is_err());

        // 清空回收站返回清掉的条数
        assert!(store.delete_note_inner(&note.id).expect("再删一次"));
        assert_eq!(store.empty_trash().expect("清空回收站"), 1);
        assert!(store.list_trash().is_empty());
        assert_eq!(store.empty_trash().expect("重复清空"), 0);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 待办进回收站时摘要取第一条未完成项() {
        let dir = temp_dir("trash-todo");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Todo, "mint", 1.0, None);
        note.title = "采购".to_string();
        note.todos.push(crate::model::TodoItem {
            id: "t1".to_string(),
            text: "先买牛奶".to_string(),
            done: true,
            due_at: None,
            order: 0.0,
        });
        note.todos.push(crate::model::TodoItem {
            id: "t2".to_string(),
            text: "再买面包".to_string(),
            done: false,
            due_at: None,
            order: 1.0,
        });
        {
            let mut state = store.lock();
            state.notes.push(note.clone());
            store.persist(&state).expect("写盘");
        }
        assert!(store.delete_note_inner(&note.id).expect("删除待办"));
        let list = store.list_trash();
        assert_eq!(list[0].kind, NoteKind::Todo);
        assert_eq!(list[0].preview, "再买面包", "待办摘要取第一条未完成项");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 数据能原子写入并完整读回() {
        let dir = temp_dir("roundtrip");
        let store = test_store(&dir);

        let mut note = Note::new(NoteKind::Todo, "pink", 1.2, Some((120.0, 240.0)));
        note.title = "买牛奶".to_string();
        note.todos.push(TodoItem {
            id: "todo-1".to_string(),
            text: "低脂".to_string(),
            done: false,
            due_at: None,
            order: 0.0,
        });
        {
            let mut state = store.lock();
            state.notes.push(note.clone());
            store.persist(&state).expect("写盘");
        }

        // 临时文件不应该残留
        assert!(!dir.join("notes.json.tmp").exists());
        // 每日备份应该生成
        assert!(dir.join("notes.bak.json").exists());

        let (notes, settings, fresh) = load_data(&store.notes_path, &store.bak_path);
        assert!(!fresh);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].title, "买牛奶");
        assert_eq!(notes[0].todos.len(), 1);
        assert_eq!(notes[0].font_scale, 1.2);
        assert_eq!(notes[0].x, Some(120.0));
        assert_eq!(settings.hotkey_new_note, "Ctrl+Alt+N");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 主文件损坏时能从备份恢复() {
        let dir = temp_dir("recover");
        let store = test_store(&dir);
        {
            let mut state = store.lock();
            state
                .notes
                .push(Note::new(NoteKind::Memo, "yellow", 1.0, None));
            store.persist(&state).expect("写盘");
        }
        // 把主文件弄坏
        fs::write(&store.notes_path, b"{ this is not json").expect("写坏文件");

        let (notes, _, _) = load_data(&store.notes_path, &store.bak_path);
        assert_eq!(notes.len(), 1, "应该从 notes.bak.json 恢复出 1 条便签");
        // 坏文件被改名保留，不会直接丢掉
        let corrupt_count = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("notes.corrupt-")
            })
            .count();
        assert_eq!(corrupt_count, 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 到期提醒只弹一次且未到期和已完成不弹() {
        let dir = temp_dir("reminder");
        let store = test_store(&dir);
        let now = model::now_ms();

        let mut due = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        due.id = "due".to_string();
        due.reminder_at = Some(now - 1_000);

        let mut future = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        future.id = "future".to_string();
        future.reminder_at = Some(now + 600_000);

        let mut done = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        done.id = "done".to_string();
        done.reminder_at = Some(now - 2_000);
        done.reminder_done = true;

        {
            let mut state = store.lock();
            state.notes = vec![future, done, due];
        }

        assert_eq!(store.take_due_reminder(now).as_deref(), Some("due"));
        assert_eq!(store.take_due_reminder(now), None, "同一条提醒不能重复弹");
        // 稍后/改期会清掉 reminded，重新到期后还能再弹
        {
            let mut state = store.lock();
            state.reminded.remove("due");
        }
        assert_eq!(store.take_due_reminder(now).as_deref(), Some("due"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 脏数据会被清洗成安全值() {
        let mut snapshot: Snapshot = serde_json::from_str(
            r#"{
                "notes": [
                    {"id": "same", "title": "一号"},
                    {"id": "same", "title": "重复 id"},
                    {"id": "", "font_scale": 99.0, "width": 999999.0}
                ],
                "settings": {"default_font_scale": 100.0, "hotkey_new_note": "  Ctrl+Alt+N  "}
            }"#,
        )
        .expect("解析 JSON");
        // 模拟 JSON 里绝不会出现的坏值（NaN / 无穷）
        snapshot.notes[2].x = Some(f64::INFINITY);
        sanitize(&mut snapshot);

        assert_eq!(snapshot.notes.len(), 3);
        assert_ne!(snapshot.notes[1].id, "same", "重复 id 应被换掉");
        assert!(snapshot.notes[2].x.is_none(), "非法坐标应置空");
        assert_eq!(snapshot.notes[2].font_scale, 3.0, "字号上限 3 倍");
        assert_eq!(snapshot.notes[2].width, Some(4000.0), "宽度上限 4000");
        assert_eq!(snapshot.settings.default_font_scale, 3.0);
        assert_eq!(snapshot.settings.hotkey_new_note, "Ctrl+Alt+N");
        assert!(snapshot.notes[0].created_at > 0, "时间应回填");
    }

    #[test]
    fn 修改记录_内容变化才记一版且相同内容不重复() {
        let dir = temp_dir("history-dedupe");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.title = "标题".to_string();
        note.content = "第一版内容".to_string();

        // 第一次保存：没有旧状态，不产生历史
        store.save_note_core(note.clone()).expect("第一次保存");
        assert!(
            store
                .list_note_versions(&note.id)
                .expect("读历史")
                .is_empty(),
            "第一次保存没有旧状态可记"
        );

        // 内容变了：旧状态进历史
        note.content = "第二版内容".to_string();
        store.save_note_core(note.clone()).expect("第二次保存");
        let list = store.list_note_versions(&note.id).expect("读历史");
        assert_eq!(list.len(), 1, "内容变化应记录 1 条历史");
        assert_eq!(list[0].title, "标题");
        assert_eq!(list[0].chars, 5, "第一版正文 5 个字");
        assert_eq!(list[0].preview, "第一版内容");
        assert!(
            dir.join("history")
                .join(format!("{}.json", note.id))
                .exists(),
            "历史文件应写在 history/<id>.json"
        );

        // 内容没变再保存：不增加
        store.save_note_core(note.clone()).expect("重复保存");
        assert_eq!(
            store.list_note_versions(&note.id).expect("读历史").len(),
            1,
            "内容没变不能重复记"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 修改记录_最多保留60版() {
        let dir = temp_dir("history-cap");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.content = "第 0 版".to_string();
        store.save_note_core(note.clone()).expect("初版保存");
        for index in 1..=70 {
            note.content = format!("第 {index} 版");
            store.save_note_core(note.clone()).expect("连续保存");
        }
        let list = store.list_note_versions(&note.id).expect("读历史");
        assert_eq!(list.len(), 60, "最多保留 60 版");
        assert_eq!(list[0].preview, "第 69 版", "最新一版排在最前");
        assert!(
            list.windows(2).all(|pair| pair[0].ts > pair[1].ts),
            "列表按 ts 倒序且严格递增"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 修改记录_能恢复到历史版本() {
        let dir = temp_dir("history-restore");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.title = "标题".to_string();
        note.content = "旧内容".to_string();
        store.save_note_core(note.clone()).expect("旧版本保存");

        note.content = "新内容".to_string();
        store.save_note_core(note.clone()).expect("新版本保存");
        let list = store.list_note_versions(&note.id).expect("读历史");
        assert_eq!(list.len(), 1);

        let restored = store
            .restore_version_inner(&note.id, list[0].ts)
            .expect("恢复到历史版本");
        assert_eq!(restored.content, "旧内容");
        assert_eq!(restored.title, "标题");
        // 内存 + 磁盘都应该是旧内容
        assert_eq!(store.note(&note.id).expect("便签还在").content, "旧内容");
        let (notes, _, _) = load_data(&store.notes_path, &store.bak_path);
        assert_eq!(notes[0].content, "旧内容", "恢复后要落盘");
        // 找不到的时间戳要报错
        assert!(store.restore_version_inner(&note.id, -1).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 修改记录_能读回某一版完整内容() {
        let dir = temp_dir("history-detail");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Memo, "yellow", 1.0, None);
        note.title = "标题一".to_string();
        note.content = "第一版正文".to_string();
        note.todos = vec![TodoItem {
            id: "t1".to_string(),
            text: "买牛奶".to_string(),
            done: false,
            due_at: None,
            order: 0.0,
        }];
        store.save_note_core(note.clone()).expect("第一版保存");

        note.title = "标题二".to_string();
        note.content = "第二版正文".to_string();
        note.todos = vec![TodoItem {
            id: "t2".to_string(),
            text: "写周报".to_string(),
            done: true,
            due_at: Some(1),
            order: 1.0,
        }];
        store.save_note_core(note.clone()).expect("第二版保存");

        let list = store.list_note_versions(&note.id).expect("读历史");
        assert_eq!(list.len(), 1, "第二次保存会把第一版记进历史");

        let detail = store
            .get_note_version(&note.id, list[0].ts)
            .expect("读回完整版本");
        assert_eq!(detail.ts, list[0].ts);
        assert_eq!(detail.title, "标题一");
        assert_eq!(detail.content, "第一版正文");
        assert_eq!(detail.chars, 5, "第一版正文 5 个字");
        assert_eq!(detail.todos.len(), 1);
        assert_eq!(detail.todos[0].text, "买牛奶");
        assert!(!detail.todos[0].done);

        // 不存在的时间戳要报错，而不是返回空内容
        assert!(store.get_note_version(&note.id, list[0].ts - 1).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 随身笔记的条目和明文开关能存能读能清空() {
        let dir = temp_dir("vault-items");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Vault, "yellow", 1.0, None);
        note.title = "常用账号".to_string();
        note.items = vec![
            VaultItem {
                id: "v1".to_string(),
                label: "OpenAI".to_string(),
                value: "sk-test-123".to_string(),
                note: "月付账号".to_string(),
            },
            VaultItem {
                id: "v2".to_string(),
                label: "家里地址".to_string(),
                value: "上海市某路 1 号".to_string(),
                note: String::new(),
            },
        ];
        note.reveal = true;
        store.save_note_core(note.clone()).expect("保存随身笔记");

        // 内存读回
        let read = store.note(&note.id).expect("便签还在");
        assert_eq!(read.kind, NoteKind::Vault);
        assert_eq!(read.items.len(), 2);
        assert_eq!(read.items[0].label, "OpenAI");
        assert_eq!(read.items[0].value, "sk-test-123");
        assert_eq!(read.items[0].note, "月付账号");
        assert!(read.reveal, "明文开关要跟着存下来");

        // 磁盘读回：JSON 里也得有 items / reveal
        let (notes, _, _) = load_data(&store.notes_path, &store.bak_path);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].items.len(), 2);
        assert_eq!(notes[0].items[1].label, "家里地址");
        assert!(notes[0].reveal);

        // 前端清空条目 + 关掉明文：要真的落库，不能被合并保护挡回来
        note.items.clear();
        note.reveal = false;
        store.save_note_core(note.clone()).expect("清空后再保存");
        let current = store.note(&note.id).expect("便签还在");
        assert!(current.items.is_empty(), "清空 items 要生效");
        assert!(!current.reveal, "关掉明文要生效");
        let (notes, _, _) = load_data(&store.notes_path, &store.bak_path);
        assert!(notes[0].items.is_empty(), "清空 items 要写进磁盘");
        assert!(!notes[0].reveal, "关掉明文要写进磁盘");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 随身笔记的历史快照保留条目且能恢复() {
        let dir = temp_dir("vault-history");
        let store = test_store(&dir);
        let mut note = Note::new(NoteKind::Vault, "yellow", 1.0, None);
        note.title = "常用账号".to_string();
        note.items = vec![VaultItem {
            id: "v1".to_string(),
            label: "旧名字".to_string(),
            value: "旧内容".to_string(),
            note: "旧备注".to_string(),
        }];
        store.save_note_core(note.clone()).expect("第一版保存");

        note.items = vec![VaultItem {
            id: "v1".to_string(),
            label: "新名字".to_string(),
            value: "新内容".to_string(),
            note: String::new(),
        }];
        store.save_note_core(note.clone()).expect("第二版保存");

        let list = store.list_note_versions(&note.id).expect("读历史");
        assert_eq!(list.len(), 1, "改条目也要记一版历史");
        assert_eq!(
            list[0].preview, "旧名字",
            "版本列表摘要用条目名字，不是空白"
        );
        let detail = store
            .get_note_version(&note.id, list[0].ts)
            .expect("读回旧版");
        assert_eq!(detail.items.len(), 1, "历史快照要带 items");
        assert_eq!(detail.items[0].label, "旧名字");
        assert_eq!(detail.items[0].value, "旧内容");
        assert_eq!(detail.items[0].note, "旧备注");

        let restored = store
            .restore_version_inner(&note.id, list[0].ts)
            .expect("恢复旧版");
        assert_eq!(restored.items.len(), 1);
        assert_eq!(restored.items[0].value, "旧内容");
        let current = store.note(&note.id).expect("便签还在");
        assert_eq!(current.items[0].value, "旧内容", "恢复后内存是旧条目");
        let (notes, _, _) = load_data(&store.notes_path, &store.bak_path);
        assert_eq!(notes[0].items[0].label, "旧名字", "恢复后要落盘");
        fs::remove_dir_all(&dir).ok();
    }
}
