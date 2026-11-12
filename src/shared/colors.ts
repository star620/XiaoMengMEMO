/**
 * 六种纸色的唯一来源。
 *
 * 设置页的默认配色圆点、面板的按颜色筛选都用这里，
 * 免得两个页面各写一份中文名，慢慢就对不上了。
 * key 必须和 tokens.css 里的 .xm-note[data-color] 一一对应。
 */
export const NOTE_COLORS = [
  { key: "yellow", label: "暖黄" },
  { key: "pink", label: "樱粉" },
  { key: "mint", label: "薄荷" },
  { key: "sky", label: "天空" },
  { key: "lavender", label: "薰衣草" },
  { key: "rose", label: "豆沙" },
] as const;

export type NoteColor = (typeof NOTE_COLORS)[number]["key"];

/** 把 key 翻成给人看的中文名；不认识的 key 原样返回。 */
export function colorLabel(key: string): string {
  const found = NOTE_COLORS.find((color) => color.key === key);
  return found ? found.label : key;
}
