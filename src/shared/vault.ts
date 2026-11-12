/**
 * 随身笔记的共享小工具：打码、复制全部、卡片/提醒摘要。
 * 约定（契约 §13.6）：面板、搜索、历史预览都不显示明文，只有便签里点眼睛才看得到。
 */
import type { Note, VaultItem } from "./types";

/** 打码时固定补 6 个点，不暴露真实长度 */
const VAULT_MASK = "••••••";

/** 只留前 4 个字符（按字符算，中文/emoji 不会被截一半） */
export function maskSecret(value: string, reveal: boolean): string {
  if (reveal) return value;
  if (!value) return "（空）";
  return Array.from(value).slice(0, 4).join("") + VAULT_MASK;
}

/** 一行是否算「有内容」：名字和内容都空就不复制、不展示 */
export function hasVaultContent(item: VaultItem): boolean {
  return item.label.trim() !== "" || item.value.trim() !== "";
}

/** 「复制全部」：名字：内容，一行一条；空行跳过 */
export function vaultAllText(items: VaultItem[]): string {
  return items
    .filter(hasVaultContent)
    .map((item) => (item.label.trim() || "（未命名）") + "：" + item.value)
    .join("\n");
}

/** 卡片里最多显示 3 条「名字 · ••••」；多出来的只报条数，不带明文 */
export function vaultCardRows(items: VaultItem[]): { rows: VaultItem[]; more: number } {
  const rows = items.filter(hasVaultContent).slice(0, 3);
  return { rows, more: Math.max(0, items.filter(hasVaultContent).length - rows.length) };
}

/** 卡片标题回退：标题 → 第一条名字 → （空便签） */
export function vaultTitle(note: Note): string {
  if (note.title.trim()) return note.title.trim();
  const first = note.items.find(hasVaultContent);
  return first?.label.trim() || "（空便签）";
}

/** 提醒/历史里的一行摘要：只报名字，不报内容 */
export function vaultSummary(items: VaultItem[], limit = 2): string {
  const labels = items
    .filter(hasVaultContent)
    .slice(0, limit)
    .map((item) => item.label.trim() || "（未命名）");
  const rest = items.filter(hasVaultContent).length - labels.length;
  if (labels.length === 0) return "（空便签）";
  return labels.join(" · ") + (rest > 0 ? " 等 " + (labels.length + rest) + " 条（已打码）" : "（已打码）");
}
