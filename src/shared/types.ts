/**
 * 数据模型 —— 与 Rust 端（src-tauri/src/model.rs）保持严格一致。
 * 时间统一用「毫秒时间戳」i64（JS 端为 number）。
 */
export type NoteKind = "memo" | "todo" | "vault";

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  due_at: number | null;
  order: number;
}

/** 随身笔记里的一条：名字 + 要复制的内容 + 可选备注（契约 §13.6） */
export interface VaultItem {
  id: string;
  /** 名字，比如「公司 VPN」 */
  label: string;
  /** 真正要复制的内容（默认打码显示） */
  value: string;
  /** 备注，可空 */
  note: string;
}

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  content: string;
  todos: TodoItem[];
  /** 随身笔记的条目；其他类型为空数组 */
  items: VaultItem[];
  /** 随身笔记：这张便签是否显示明文（只影响这张便签，默认 false 打码） */
  reveal: boolean;
  color: string;
  pinned: boolean;
  /** 内容锁定（契约 §13.3）：锁定后标题/正文/待办不可改，仍可拖动、可解锁 */
  locked: boolean;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  font_scale: number;
  created_at: number;
  updated_at: number;
  reminder_at: number | null;
  reminder_done: boolean;
  /** 重复提醒：""=不重复 / "daily" / "weekdays" / "weekly"（契约 §12.1） */
  repeat: string;
  collapsed: boolean;
  hidden: boolean;
}

/** 回收站里的一条（list_trash 返回，契约 §12.2） */
export interface TrashItem {
  id: string;
  kind: NoteKind;
  title: string;
  /** 一行摘要：正文压平前 60 字，或待办里第一条没完成的 */
  preview: string;
  deleted_at: number;
}

export interface Settings {
  launch_on_startup: boolean;
  hotkey_new_note: string;
  /** 打开管理面板的全局快捷键（契约 §13.1，默认 Ctrl+Alt+M） */
  hotkey_show_panel: string;
  default_color: string;
  default_font_scale: number;
  play_sound: boolean;
  show_tray: boolean;
  first_run_done: boolean;
  /** Markdown 排版：true 时 memo 便签失焦后把源码排成纸面（默认 true） */
  markdown_enabled: boolean;
  /** 提醒到点时播放声音（契约 §16.10，默认 true） */
  reminder_sound: boolean;
  /** 纸色：auto=跟随时间（19:00–07:00 夜间）/ day=始终浅色 / night=始终深色 */
  theme_mode: "auto" | "day" | "night";
  /** 快速记录浮层的全局快捷键（契约 §16.4，默认 Ctrl+Alt+Space） */
  hotkey_quick: string;
}

export interface Snapshot {
  notes: Note[];
  settings: Settings;
}

export type Surface = "sticky" | "panel" | "settings" | "reminder" | "quick";
