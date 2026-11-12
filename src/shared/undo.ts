/**
 * 删除撤销的跨窗口小纸条（契约 §12.5）
 *
 * 为什么不在便签里弹 toast：删除后便签窗口会被后端销毁，用户根本看不到。
 * 所以删除时先往 localStorage 写一条 5 秒有效的记录，面板打开/刷新时读取并显示「已删除 · 撤销」。
 * localStorage 是主通道（面板没开也不会丢）；BroadcastChannel 只是加速：面板正开着时立刻弹出。
 * 两处读写一律 try/catch —— 隐身模式、配额满都不该让删除失败。
 */
import type { Note } from "./types";

const STORAGE_KEY = "xm-undo-pending-v1";
const CHANNEL_NAME = "xm-undo";
/** 撤销有效期：5 秒 */
export const UNDO_TTL = 5000;

export interface PendingUndo {
  noteId: string;
  /** 便签标题（没标题就是空串），面板可以不显示，但留一份方便调试 */
  title: string;
  deletedAt: number;
}

/** 删除便签时调用：写本地记录 + 广播（广播失败不影响删除） */
export function publishUndo(note: Pick<Note, "id" | "title">, now = Date.now()): void {
  const entry: PendingUndo = {
    noteId: note.id,
    title: note.title.trim(),
    deletedAt: now,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    /* localStorage 不可用：撤销兜底靠回收站 */
  }
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(entry);
    channel.close();
  } catch {
    /* 没有 BroadcastChannel：面板下次打开时会从 localStorage 读到 */
  }
}

/** 读一条还没过期的记录；过期/损坏就顺手清掉，返回 null */
export function readUndo(now = Date.now()): PendingUndo | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingUndo>;
    if (!parsed || typeof parsed.noteId !== "string" || typeof parsed.deletedAt !== "number") {
      clearUndo();
      return null;
    }
    // 时间戳在未来太多说明系统时间被改过，按过期处理，免得撤销一直挂着
    if (now - parsed.deletedAt > UNDO_TTL || parsed.deletedAt > now + 1000) {
      clearUndo();
      return null;
    }
    return { noteId: parsed.noteId, title: typeof parsed.title === "string" ? parsed.title : "", deletedAt: parsed.deletedAt };
  } catch {
    return null;
  }
}

/** 清掉记录；传 noteId 时只清这一条（避免把别人刚删的撤销弄丢） */
export function clearUndo(noteId?: string): void {
  try {
    if (noteId) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PendingUndo>;
        if (parsed && parsed.noteId !== noteId) return;
      }
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** 面板开着时的加速通道：收到广播立刻显示（订阅失败返回空函数，不影响启动） */
export function subscribeUndo(callback: (pending: PendingUndo) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<Partial<PendingUndo>>) => {
      const data = event.data;
      if (!data || typeof data.noteId !== "string" || typeof data.deletedAt !== "number") return;
      callback({ noteId: data.noteId, title: typeof data.title === "string" ? data.title : "", deletedAt: data.deletedAt });
    };
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      channel?.close();
    } catch {
      /* ignore */
    }
  };
}
