/// <reference types="vite/client" />
/**
 * 与 Rust 后端通信的唯一入口。
 * 命令名必须与 src-tauri/src/commands.rs 中 #[tauri::command] 一致。
 *
 * 浏览器调试：npm run dev 时按需加载 src/shared/mock.ts（localStorage 假数据 + 300ms 延迟），
 * 所以直接打开页面就能调 UI；打包后 mock 是独立 chunk，不在入口主包里，
 * 万一在浏览器里打开生产页面也会给出明确提示，而不是悄悄用假数据。
 * 有 Tauri 时永远走真实 invoke。
 * 这里不允许改命令名/参数名，新增命令要先跟后端对齐。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./env";
import { setImageDir } from "./images";
import type { Note, Settings, Snapshot, TodoItem, TrashItem, VaultItem } from "./types";

/** 修改记录里的一条旧版本（契约 §14） */
export interface NoteVersion {
  /** 这个版本保存的时间戳（毫秒） */
  ts: number;
  /** 当时的标题（没标题时后端会给一个可读的回退） */
  title: string;
  /** 当时的字数（去掉空白） */
  chars: number;
  /** 预览：一行摘要，最多 90 字 */
  preview: string;
}

/** 修改记录详情：点开某一条旧版本时取全文（契约 §8.7） */
export interface NoteVersionDetail {
  /** 这个版本保存的时间戳（毫秒） */
  ts: number;
  /** 当时的标题 */
  title: string;
  /** 当时的正文（memo 才有内容，todo 通常为空串） */
  content: string;
  /** 当时的待办列表（todo 才有内容，勾选态一并保留） */
  todos: TodoItem[];
  /** 当时的随身笔记条目（vault 才有内容；面板里只显示名字和打码内容） */
  items: VaultItem[];
  /** 当时的字数（去掉空白） */
  chars: number;
}

/** 导入备份文件的结果（契约 §16.8）：取消选择时后端返回 null */
interface ImportResult {
  imported: number;
  skipped: number;
}

type Args = Record<string, unknown>;

/** 浏览器开发时的 mock 模块：动态 import，打包后会单独成一个 chunk，不压进主包。 */
let mockModule: Promise<typeof import("./mock")> | null = null;

function loadMock(): Promise<typeof import("./mock")> {
  mockModule ??= import("./mock");
  return mockModule;
}

/**
 * 浏览器里能不能用 mock：开发模式默认可以；
 * 生产构建只有显式设置 globalThis.__XM_MOCK__ = true 才放行（只给端到端测试用）。
 * 保留这个运行时开关，打包器才不会把 mock 整块裁掉，dist 里才有独立的 mock chunk。
 */
function canUseMock(): boolean {
  if (import.meta.env.DEV) return true;
  return (globalThis as { __XM_MOCK__?: boolean }).__XM_MOCK__ === true;
}

/** 统一入口：桌面端走 IPC，浏览器开发时走 mock，生产浏览器直接报错。 */
function call<T>(cmd: string, args?: Args): Promise<T> {
  if (isTauri()) return invoke<T>(cmd, args);
  if (!canUseMock()) {
    return Promise.reject(
      new Error("当前不在桌面应用里，浏览器调试请用 npm run dev 启动。"),
    );
  }
  return loadMock().then((mock) => mock.mockInvoke<T>(cmd, args));
}

export const api = {
  // 快照里带图片目录：统一在这里记下来，后面 imageUrl() 拼 asset 地址要用
  getSnapshot: async () => {
    const snapshot = await call<Snapshot>("get_snapshot");
    setImageDir(snapshot.image_dir ?? "");
    return snapshot;
  },
  saveNote: (note: Note) => call<Note>("save_note", { note }),
  /** 存一张图片（base64，不带 data: 前缀），返回文件名（图片契约 §3.1） */
  saveImage: (data: string) => call<string>("save_image", { data }),
  deleteNote: (id: string) => call<void>("delete_note", { id }),
  /** 回收站：列表 / 恢复 / 清空（契约 §12.2） */
  listTrash: () => call<TrashItem[]>("list_trash"),
  restoreNote: (id: string) => call<void>("restore_note", { id }),
  emptyTrash: () => call<number>("empty_trash"),
  /** 修改记录：列出某张便签的历史版本（按时间倒序，最多约 20 条） */
  listNoteVersions: (id: string) => call<NoteVersion[]>("list_note_versions", { id }),
  /** 把便签恢复到某个历史版本，返回恢复后的便签 */
  restoreNoteVersion: (id: string, ts: number) =>
    call<Note>("restore_note_version", { id, ts }),
  /** 某条历史版本的全文（面板里点开详情用；后端命令 get_note_version） */
  getNoteVersion: (id: string, ts: number) =>
    call<NoteVersionDetail>("get_note_version", { id, ts }),
  createNote: (kind: "memo" | "todo" | "vault", at?: { x: number; y: number }) =>
    call<Note>("create_note", { kind, at: at ?? null }),
  openNoteWindow: (id: string) => call<void>("open_note_window", { id }),
  closeNoteWindow: (id: string) => call<void>("close_note_window", { id }),
  saveWindowState: (id: string, state: { x: number; y: number; width: number; height: number }) =>
    call<void>("save_window_state", { id, state }),
  setPinned: (id: string, pinned: boolean) => call<void>("set_pinned", { id, pinned }),
  /** 折叠 / 展开便签：后端会把窗口高度收成 64px 或还原（契约 §13.2） */
  setNoteCollapsed: (id: string, collapsed: boolean) =>
    call<Note>("set_note_collapsed", { id, collapsed }),
  /** 三档尺寸（紧凑 / 标准 / 大）：后端改窗口大小并记住 */
  setNoteSize: (id: string, width: number, height: number) =>
    call<Note>("set_note_size", { id, width, height }),
  /** 锁定 / 解锁便签：锁上后正文只读，后端也会守住内容不被旧快照覆盖（契约 §13.3） */
  setNoteLocked: (id: string, locked: boolean) => call<Note>("set_note_locked", { id, locked }),
  /** 导出全部便签到桌面，返回导出目录（契约 §13.1） */
  exportNotes: () => call<string>("export_notes"),
  /** 从每日备份补回缺失便签，返回补回条数（契约 §13.1） */
  restoreFromBackup: () => call<number>("restore_from_backup"),
  /** 选一个 json 备份文件导入；同 id 跳过不覆盖，取消选择返回 null（契约 §16.8） */
  importNotesFile: () => call<ImportResult | null>("import_notes_file"),
  openPanel: () => call<void>("open_panel"),
  openSettings: () => call<void>("open_settings"),
  /** 快速记录浮层（契约 §16.4；后端负责窗口置顶/聚焦） */
  openQuick: () => call<void>("open_quick"),
  closeQuick: () => call<void>("close_quick"),
  setReminder: (id: string, at: number | null) => call<void>("set_reminder", { id, at }),
  snoozeReminder: (id: string, minutes: number) => call<void>("snooze_reminder", { id, minutes }),
  dismissReminder: (id: string) => call<void>("dismiss_reminder", { id }),
  saveSettings: (settings: Settings) => call<Settings>("save_settings", { settings }),
  getAutostart: () => call<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => call<boolean>("set_autostart", { enabled }),
  openDataFolder: () => call<void>("open_data_folder"),
  quitApp: () => call<void>("quit_app"),
};

