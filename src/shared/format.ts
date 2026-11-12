/** 时间和文案格式化（面板相对时间、提醒时间、输入框值）。 */

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 面板卡片用：刚刚 / 5 分钟前 / 3 小时前 / 昨天 21:30 / 11月8日 / 2025年11月8日 */
export function relativeTime(ts: number): string {
  if (!ts) return "";
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return Math.floor(diff / 60_000) + " 分钟前";
  if (diff < 24 * 60 * 60_000) return Math.floor(diff / 3_600_000) + " 小时前";
  const d = new Date(ts);
  const today = new Date();
  const sameYear = d.getFullYear() === today.getFullYear();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
    return "昨天 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  if (sameYear) return d.getMonth() + 1 + "月" + d.getDate() + "日";
  return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
}

/** 只取时钟：22:30 */
export function clockTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/** 提醒弹窗用：今天 22:30 / 明天 09:00 / 11月12日 08:00 */
export function reminderLabel(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  const hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  if (dayDiff === 0) return "今天 " + hm;
  if (dayDiff === 1) return "明天 " + hm;
  if (dayDiff === 2) return "后天 " + hm;
  return d.getMonth() + 1 + "月" + d.getDate() + "日 " + hm;
}

/** 毫秒时间戳 -> <input type="datetime-local"> 的值（本地时区） */
export function toDateTimeLocalValue(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return (
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes())
  );
}

/** <input type="datetime-local"> 的值 -> 毫秒时间戳；空值返回 null。 */
export function fromDateTimeLocalValue(value: string): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** 待办行里的截止时间短文案：今天 / 明天 / 后天 / 11月12日（过期就在前面加“过期 · ”） */
export function dueShortLabel(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  let text: string;
  if (dayDiff === 0) text = "今天";
  else if (dayDiff === 1) text = "明天";
  else if (dayDiff === 2) text = "后天";
  else text = d.getMonth() + 1 + "月" + d.getDate() + "日";
  // 已经过了截止时间（当天但时间已过也算）就标“过期”，提醒用户
  if (ts < Date.now()) return "过期 · " + text;
  return text;
}

/** 重复提醒的中文标签：每天 / 工作日 / 每周；不重复返回空串 */
export function repeatLabel(repeat: string): string {
  if (repeat === "daily") return "每天";
  if (repeat === "weekdays") return "工作日";
  if (repeat === "weekly") return "每周";
  return "";
}

/** 面板里待办的进度文案：2/3 */
export function todoProgress(done: number, total: number): string {
  return total > 0 ? done + "/" + total : "";
}
