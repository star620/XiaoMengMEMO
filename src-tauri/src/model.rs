//! 数据模型：与前端 `src/shared/types.ts` 一一对应。
//! 约定：字段名保持 snake_case（serde 默认按字段名序列化，不要加 rename_all），
//! 时间统一用 i64 毫秒时间戳（与 JS 的 Date.now() 一致）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 便签类型：memo = 便利贴，todo = 待办清单，vault = 随身笔记（一条 = 名字 + 内容）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    /// default：类便签类型的缺省值就是便利贴
    #[default]
    Memo,
    Todo,
    Vault,
}

/// 待办清单里的一条
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub due_at: Option<i64>,
    #[serde(default)]
    pub order: f64,
}

/// 随身笔记里的一条：名字 + 内容（API key、兑换码、地址、常用话术等）。
/// id 由前端生成，后端只负责原样存下来。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultItem {
    #[serde(default)]
    pub id: String,
    /// 名字（显示用，面板按它搜索）
    #[serde(default)]
    pub label: String,
    /// 内容（默认打码显示，点一下复制）
    #[serde(default)]
    pub value: String,
    /// 备注，可为空
    #[serde(default)]
    pub note: String,
}

/// 一张便签（便利贴 / 待办清单 / 随身笔记）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: NoteKind,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub todos: Vec<TodoItem>,
    /// 随身笔记的条目（kind=vault 时使用；旧数据没有这个字段时为空）
    #[serde(default)]
    pub items: Vec<VaultItem>,
    /// 随身笔记是否明文显示（false=打码；前端点眼睛切换后 save_note 保存）
    #[serde(default)]
    pub reveal: bool,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub pinned: bool,
    /// 锁定：锁定后标题 / 正文 / 待办都不再被前端改动（save_note 会沿用后端已有的内容）
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default = "default_font_scale")]
    pub font_scale: f64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub reminder_at: Option<i64>,
    #[serde(default)]
    pub reminder_done: bool,
    /// 重复提醒方式：空串（不重复，默认）/ "daily"（每天）/ "weekdays"（工作日）/ "weekly"（每周）
    /// 老数据没有这个字段，按空串读（不重复）
    #[serde(default)]
    pub repeat: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub hidden: bool,
}

impl Note {
    /// 创建一张默认便签；at 是逻辑像素坐标（鼠标位置），None 表示居中
    pub fn new(kind: NoteKind, color: &str, font_scale: f64, at: Option<(f64, f64)>) -> Note {
        let now = now_ms();
        Note {
            id: new_id("note"),
            kind,
            title: String::new(),
            content: String::new(),
            todos: Vec::new(),
            items: Vec::new(),
            reveal: false,
            color: if color.trim().is_empty() {
                default_color()
            } else {
                color.to_string()
            },
            pinned: false,
            locked: false,
            x: at.map(|point| point.0),
            y: at.map(|point| point.1),
            width: None,
            height: None,
            font_scale: clamp_font_scale(font_scale),
            created_at: now,
            updated_at: now,
            reminder_at: None,
            reminder_done: false,
            repeat: String::new(),
            collapsed: false,
            hidden: false,
        }
    }

    /// 窗口标题用：优先标题，其次正文第一行，最后按类型给个默认名
    pub fn window_title(&self) -> String {
        let title = self.title.trim();
        if !title.is_empty() {
            return title.chars().take(40).collect();
        }
        let first_line = self.content.lines().next().unwrap_or("").trim();
        if !first_line.is_empty() {
            return first_line.chars().take(40).collect();
        }
        match self.kind {
            NoteKind::Memo => "便签".to_string(),
            NoteKind::Todo => "待办".to_string(),
            NoteKind::Vault => "随身笔记".to_string(),
        }
    }
}

/// 用户设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub launch_on_startup: bool,
    #[serde(default = "default_hotkey")]
    pub hotkey_new_note: String,
    /// 打开管理面板的全局快捷键；老数据没有这个字段，按 Ctrl+Alt+M 读
    #[serde(default = "default_hotkey_panel")]
    pub hotkey_show_panel: String,
    #[serde(default = "default_color")]
    pub default_color: String,
    #[serde(default = "default_font_scale")]
    pub default_font_scale: f64,
    #[serde(default)]
    pub play_sound: bool,
    #[serde(default = "default_true")]
    pub show_tray: bool,
    /// 便签正文失焦后按 Markdown 排版；老数据没有这个字段，按 true 读
    #[serde(default = "default_true")]
    pub markdown_enabled: bool,
    /// 提醒到点时播放系统提示音（默认开；老数据没有这个字段按 true 读）
    #[serde(default = "default_true")]
    pub reminder_sound: bool,
    /// 纸色：auto 跟随时间 / day 浅色 / night 深色（老数据按 auto）
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    /// 快速记录悬浮窗的全局快捷键（老数据按 Ctrl+Alt+Space）
    #[serde(default = "default_hotkey_quick")]
    pub hotkey_quick: String,
    #[serde(default)]
    pub first_run_done: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            // 默认不开机自启：装完软件就悄悄常驻启动会吓到用户（还可能被安全软件拦），
            // 想要的人到设置里自己开一次即可。
            launch_on_startup: false,
            hotkey_new_note: default_hotkey(),
            hotkey_show_panel: default_hotkey_panel(),
            default_color: default_color(),
            default_font_scale: 1.0,
            // 勾掉待办的那声轻响默认开着（可在设置里关）
            play_sound: true,
            show_tray: true,
            // 便签正文失焦后按 Markdown 排版，默认开（用户可以在设置里关）
            markdown_enabled: true,
            reminder_sound: true,
            theme_mode: default_theme_mode(),
            hotkey_quick: default_hotkey_quick(),
            first_run_done: false,
        }
    }
}

/// 一次取回给前端的数据：全部便签 + 设置 + 图片目录
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub settings: Settings,
    /// 图片目录的绝对路径（前端拼 asset URL 用）；取不到时为空串
    #[serde(default)]
    pub image_dir: String,
}

/// create_note 的鼠标位置参数（逻辑像素）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct Point {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

/// 窗口位置与大小（逻辑像素），前端 save_window_state 传来
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct WindowState {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
}

/// 回收站里的一条：被删除的完整便签 + 删除时间（毫秒时间戳）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashEntry {
    pub note: Note,
    #[serde(default)]
    pub deleted_at: i64,
}

/// trash.json 的文件结构：{ "items": [ { "note": ..., "deleted_at": ... } ] }
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrashFile {
    #[serde(default)]
    pub items: Vec<TrashEntry>,
}

/// 给前端的回收站列表项（列表只需要摘要，不把正文全部传过去）
#[derive(Debug, Clone, Serialize)]
pub struct TrashItem {
    pub id: String,
    pub kind: NoteKind,
    pub title: String,
    pub preview: String,
    pub deleted_at: i64,
}

/// 合法的重复提醒方式：空串 / daily / weekdays / weekly；其它值一律当「不重复」
pub fn normalize_repeat(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "daily" => "daily".to_string(),
        "weekdays" => "weekdays".to_string(),
        "weekly" => "weekly".to_string(),
        _ => String::new(),
    }
}

/// 字号缩放范围（0.6 ~ 3 倍），越界会被拉回来
pub fn clamp_font_scale(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.6, 3.0)
    } else {
        1.0
    }
}

/// 当前时间（毫秒时间戳）
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 生成一个不会重复的 id：前缀 + 纳秒时间 + 进程内自增计数
pub fn new_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{nanos:x}-{seq:x}")
}

fn default_font_scale() -> f64 {
    1.0
}

fn default_hotkey() -> String {
    "Ctrl+Alt+N".to_string()
}

fn default_hotkey_panel() -> String {
    "Ctrl+Alt+M".to_string()
}

fn default_hotkey_quick() -> String {
    "Ctrl+Alt+Space".to_string()
}

/// 纸色默认「跟随时间」
fn default_theme_mode() -> String {
    "auto".to_string()
}

fn default_color() -> String {
    "yellow".to_string()
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::Settings;

    /// 兼容性：老用户的 notes.json 没有 markdown_enabled 字段，必须按 true 读出来且不报错
    #[test]
    fn 老设置缺字段时_markdown_默认开启() {
        let old = r#"{"launch_on_startup":false,"hotkey_new_note":"Ctrl+Alt+N","default_color":"yellow","default_font_scale":1.0,"play_sound":true,"show_tray":true,"first_run_done":true}"#;
        let settings: Settings = serde_json::from_str(old).expect("老设置应能正常读出");
        assert!(settings.markdown_enabled, "缺字段时应默认 true");

        // 新数据显式关掉时能正确读出 false
        let parsed: Settings =
            serde_json::from_str(r#"{"markdown_enabled":false}"#).expect("新设置应能正常读出");
        assert!(!parsed.markdown_enabled);

        // 写出去的 JSON 里必须真的带这个字段，前端 get_snapshot / save_settings 才能拿到
        let json = serde_json::to_string(&Settings::default()).expect("设置应能序列化");
        assert!(json.contains(r#""markdown_enabled":true"#));
    }

    /// 兼容性：老用户设置里没有 reminder_sound / theme_mode / hotkey_quick，必须给出安全默认值
    #[test]
    fn 老设置缺新字段时按默认值读() {
        let old = r#"{"launch_on_startup":false,"play_sound":true,"show_tray":true}"#;
        let settings: Settings = serde_json::from_str(old).expect("老设置应能正常读出");
        assert!(settings.reminder_sound, "缺字段时提醒声音默认开");
        assert_eq!(settings.theme_mode, "auto", "缺字段时纸色跟随时间");
        assert_eq!(
            settings.hotkey_quick, "Ctrl+Alt+Space",
            "缺字段时用默认快速记录键"
        );

        // 新字段写出去后前端能拿到
        let json = serde_json::to_string(&Settings::default()).expect("设置应能序列化");
        assert!(json.contains(r#""reminder_sound":true"#));
        assert!(json.contains(r#""theme_mode":"auto""#));
        assert!(json.contains(r#""hotkey_quick":"Ctrl+Alt+Space""#));
    }

    /// 兼容性：老便签没有 repeat 字段，必须按「不重复」读出来
    #[test]
    fn 老便签缺_repeat_时按不重复读() {
        let old = r#"{"id":"note-1","kind":"memo","title":"旧便签","content":"正文","created_at":1,"updated_at":1}"#;
        let note: super::Note = serde_json::from_str(old).expect("老便签应能正常读出");
        assert_eq!(note.repeat, "", "缺字段时应按不重复读");

        // 写出去的 JSON 必须带 repeat 字段，前端才能拿到
        let json = serde_json::to_string(&note).expect("便签应能序列化");
        assert!(json.contains(r#""repeat":"""#));

        // 显式写值时能正确读出，非法值会被当成不重复
        let daily: super::Note =
            serde_json::from_str(r#"{"id":"n2","repeat":"daily"}"#).expect("新便签应能读出");
        assert_eq!(daily.repeat, "daily");
        assert_eq!(super::normalize_repeat(" DAILY "), "daily");
        assert_eq!(super::normalize_repeat("hourly"), "");
    }
}
