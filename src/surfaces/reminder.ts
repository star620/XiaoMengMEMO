/**
 * 提醒弹窗（surface=reminder）
 *
 * 到点的便签会"跳"到眼前：标题 + 内容摘要 + 时间，
 * 只有两个选择——"10 分钟后"（snoozeReminder）或"知道了"（dismissReminder）。
 */
import { api } from "../shared/api";
import { mountChrome } from "../shared/chrome";
import { query } from "../shared/dom";
import { subscribe } from "../shared/events";
import { clockTime, reminderLabel, repeatLabel } from "../shared/format";
import { vaultSummary } from "../shared/vault";
import { replaceImageLines } from "../shared/images";
import { mdToPlain } from "../shared/markdown";
import { closeCurrent } from "../shared/window";
import type { Note } from "../shared/types";

/** "10 分钟后"的分钟数 */
const SNOOZE_MINUTES = 10;
/** 内容摘要最多显示多少字 */
const SUMMARY_LIMIT = 120;

export async function mount(root: HTMLElement, ctx: { noteId: string }): Promise<void> {
  // 无边框窗口：套上自绘窗口壳（提醒窗标题条更矮，视觉按 data-surface=reminder 处理）
  const body = mountChrome(root, {
    surface: "reminder",
    // 点右上角关闭 = 知道了：提醒标记成已处理，别下次又弹
    beforeClose: async () => {
      if (note) await api.dismissReminder(noteId);
    },
  });
  body.innerHTML =
    '<div class="xm-reminder">' +
    '<div class="xm-reminder__paper">' +
    '<div class="xm-reminder__time"></div>' +
    '<h1 class="xm-reminder__title"></h1>' +
    '<p class="xm-reminder__text"></p>' +
    '<div class="xm-reminder__actions">' +
    '<button class="xm-btn" type="button" data-act="snooze">10 分钟后</button>' +
    '<button class="xm-btn xm-btn--primary" type="button" data-act="done">知道了</button>' +
    "</div>" +
    "</div>" +
    '<div class="xm-toast" data-show="0">操作失败</div>' +
    "</div>";

  const timeEl = query<HTMLElement>(body, ".xm-reminder__time");
  const titleEl = query<HTMLElement>(body, ".xm-reminder__title");
  const textEl = query<HTMLElement>(body, ".xm-reminder__text");
  const snoozeBtn = query<HTMLButtonElement>(body, '[data-act="snooze"]');
  const doneBtn = query<HTMLButtonElement>(body, '[data-act="done"]');
  const toastEl = query<HTMLElement>(body, ".xm-toast");

  let noteId = ctx.noteId;
  let note: Note | null = null;
  let busy = false;
  let toastTimer = 0;

  function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.dataset.show = "1";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.dataset.show = "0";
    }, 1400);
  }

  /** 摘要：待办列出没做完的，备忘取正文开头 */
  function summaryOf(target: Note): string {
    if (target.kind === "vault") {
      // 只报名字，不报内容（契约 §13.6）
      return vaultSummary(target.items ?? [], 2);
    }
    if (target.kind === "todo") {
      const rest = target.todos.filter((todo) => !todo.done);
      if (rest.length === 0) return "全部完成了";
      const words = rest.map((todo) => todo.text.trim() || "（没写内容）").join(" · ");
      return "还剩 " + rest.length + " 项：" + words;
    }
    // 提醒窗只有一行摘要：图片行先变成 [图片]，再去掉 Markdown 记号，
    // 否则用户会看到 ![](xmimg:img_xxx.png "说明") 这种源码。
    const text = mdToPlain(replaceImageLines(target.content, "[图片]"))
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "（空便签）";
    return text.length > SUMMARY_LIMIT ? text.slice(0, SUMMARY_LIMIT) + "…" : text;
  }

  function render(target: Note | null): void {
    if (!target) {
      timeEl.textContent = clockTime(Date.now());
      titleEl.textContent = "这张便签已经不在了";
      textEl.textContent = "可能已经被删除。";
      snoozeBtn.hidden = true;
      return;
    }
    snoozeBtn.hidden = false;
    // 到点的时间："今天 22:30" / "明天 09:00"；重复提醒再带上"· 每天"
    const when = target.reminder_at ? reminderLabel(target.reminder_at) : clockTime(Date.now());
    const repeat = target.repeat ? repeatLabel(target.repeat) : "";
    timeEl.textContent = repeat ? when + " · " + repeat : when;
    const firstLine =
      mdToPlain(replaceImageLines(target.content, "[图片]"))
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) ?? "";
    const firstLabel = (target.items ?? []).find((item) => item.label.trim())?.label.trim() ?? "";
    const fallback = target.kind === "todo" ? "待办提醒" : target.kind === "vault" ? "随身笔记提醒" : "便签提醒";
    titleEl.textContent =
      target.kind === "vault"
        ? target.title.trim() || firstLabel || fallback
        : target.title.trim() || firstLine || fallback;
    textEl.textContent = summaryOf(target);
  }

  async function load(): Promise<void> {
    try {
      const snapshot = await api.getSnapshot();
      note = snapshot.notes.find((item) => item.id === noteId) ?? null;
      render(note);
    } catch (error) {
      console.error("读取提醒内容失败", error);
      toast("读取失败");
    }
  }

  async function snooze(): Promise<void> {
    if (busy) return;
    busy = true;
    snoozeBtn.disabled = true;
    doneBtn.disabled = true;
    try {
      await api.snoozeReminder(noteId, SNOOZE_MINUTES);
      await closeCurrent();
    } catch (error) {
      console.error("稍后提醒失败", error);
      busy = false;
      snoozeBtn.disabled = false;
      doneBtn.disabled = false;
      toast("设置失败");
    }
  }

  async function dismiss(): Promise<void> {
    if (busy) return;
    busy = true;
    snoozeBtn.disabled = true;
    doneBtn.disabled = true;
    try {
      await api.dismissReminder(noteId);
      await closeCurrent();
    } catch (error) {
      console.error("关闭提醒失败", error);
      busy = false;
      snoozeBtn.disabled = false;
      doneBtn.disabled = false;
      toast("关闭失败");
    }
  }

  body.addEventListener("click", (event) => {
    const act = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "snooze") void snooze();
    if (act === "done") void dismiss();
  });

  // Enter = 知道了；Esc = 稍后再提醒（不直接丢掉提醒）
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void dismiss();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (note) void snooze();
      else void closeCurrent();
    }
  });

  // 同一个窗口被复用去提醒下一张便签时，跟着刷新内容
  void subscribe<{ id?: string }>("reminder-due", (payload) => {
    if (payload && typeof payload.id === "string" && payload.id) noteId = payload.id;
    void load();
  });

  // 提醒窗口是单例：被复用来提醒下一次时（尤其连续两次提醒同一张便签），
  // 万一页面没有重新挂载，至少把"处理中"状态和按钮恢复正常，
  // 否则上一轮点过之后按钮会一直是灰的，用户点不动。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    busy = false;
    snoozeBtn.disabled = false;
    doneBtn.disabled = false;
    void load();
  });

  await load();
  // 窗口本身由后端置顶聚焦，这里只把主按钮设为可键盘触发
  doneBtn.focus();
}