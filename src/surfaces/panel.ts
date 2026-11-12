/**
 * 召唤面板（surface=panel）
 *
 * 用户最在意"一搜就到"：
 *  - 打开即聚焦搜索框，输入即时过滤（标题 / 正文 / 待办文字都参与匹配）；
 *  - Ctrl+F 回到搜索框，Esc 先清空搜索、再按一次关面板；
 *  - 键盘 ↑↓ 选择、Enter 打开；点卡片也能打开。
 *
 * 回收站（契约 §12.5）：顶部垃圾桶按钮进入；↑↓ 选择、Enter 恢复、Esc 返回；
 * 清空要二次确认。删除某张便签后，这里会显示 5 秒的「已删除 · 撤销」。
 */
import { api } from "../shared/api";
import type { NoteVersion, NoteVersionDetail } from "../shared/api";
import { mountChrome } from "../shared/chrome";
import { debounce } from "../shared/dom";
import { icons } from "../shared/icons";
import { subscribe } from "../shared/events";
import { NOTE_COLORS } from "../shared/colors";
import type { NoteColor } from "../shared/colors";
import { hideCurrent } from "../shared/window";
import { clockTime, relativeTime, reminderLabel, todoProgress } from "../shared/format";
import { mdToPlain } from "../shared/markdown";
import { diffStats, diffText } from "../shared/diff";
import type { DiffOp } from "../shared/diff";
import { maskSecret, vaultCardRows, vaultTitle } from "../shared/vault";
import { PINYIN_INITIAL } from "../shared/pinyin";
import { clearUndo, publishUndo, readUndo, subscribeUndo, UNDO_TTL } from "../shared/undo";
import type { PendingUndo } from "../shared/undo";
import type { Note, TrashItem } from "../shared/types";

/** 便签菜单里的「修改记录」用 BroadcastChannel 通知面板；浏览器单页调试时用 localStorage 兜底 */
const HISTORY_CHANNEL = "xm-history";
const HISTORY_REQUEST_KEY = "xm-history-request";
const HISTORY_REQUEST_TTL = 5000;
/** openPanel 派发的 xm-panel-open 会抢在广播之前到；这个窗口内先让历史请求接管（task-28） */
const HISTORY_OPEN_GUARD = 3000;

/**
 * 只读地看一眼有没有「打开修改记录」的请求（不消费）。
 * 便签点「修改记录」时先写请求再 openPanel，面板的 xm-panel-open 监听靠它判断
 * 「这次打开是历史流程，不要重置回列表」。
 */
function peekHistoryRequest(): string {
  try {
    const raw = localStorage.getItem(HISTORY_REQUEST_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { noteId?: unknown; ts?: unknown } | null;
    if (!parsed || typeof parsed.noteId !== "string") return "";
    const ts = Number(parsed.ts) || 0;
    if (Date.now() - ts > HISTORY_OPEN_GUARD) return "";
    return parsed.noteId;
  } catch {
    return "";
  }
}

/** 取走并清掉「打开修改记录」的请求；超过 5 秒的视为过期 */
function readHistoryRequest(): string {
  try {
    const raw = localStorage.getItem(HISTORY_REQUEST_KEY);
    if (!raw) return "";
    localStorage.removeItem(HISTORY_REQUEST_KEY);
    const parsed = JSON.parse(raw) as { noteId?: unknown; ts?: unknown } | null;
    if (!parsed || typeof parsed.noteId !== "string") return "";
    const ts = Number(parsed.ts) || 0;
    if (Date.now() - ts > HISTORY_REQUEST_TTL) return "";
    return parsed.noteId;
  } catch {
    return "";
  }
}

interface CardView {
  note: Note;
  /** 面板上显示的标题（没标题就取正文第一行） */
  title: string;
  /** 两行摘要 */
  summary: string;
  /** 待办进度文案，memo 为空 */
  progress: string;
  /** 有没有未到点/未处理的提醒 */
  reminder: string;
}

/** 一段命中区间，start/end 都是原文里的 UTF-16 下标 */
interface MatchRange {
  start: number;
  end: number;
}

type DueFilter = "all" | "today" | "overdue" | "tomorrow";
type KindFilter = "all" | "memo" | "todo" | "vault";
type ColorFilter = "all" | NoteColor;

export async function mount(root: HTMLElement, _ctx: { noteId: string }): Promise<void> {
  // 无边框窗口：先套上自绘窗口壳（品牌名 + 最小化/关闭 + 拖动区），内容放 body 里
  const body = mountChrome(root, { surface: "panel" });
  body.innerHTML =
    '<section class="xm-panel">' +
    '<div class="xm-history__bar" hidden>' +
    '<div class="xm-history__titles">' +
    '<div class="xm-history__title">修改记录</div>' +
    '<div class="xm-history__note"></div>' +
    "</div>" +
    '<button class="xm-btn xm-btn--ghost" type="button" data-act="history-back">返回</button>' +
    "</div>" +
    '<header class="xm-panel__head">' +
    '<input class="xm-search" type="search" placeholder="搜索便签… 支持拼音首字母" title="Ctrl + F" aria-label="搜索便签，支持拼音首字母" />' +
    "</header>" +
    '<div class="xm-panel__actions">' +
    '<button class="xm-btn xm-btn--primary" type="button" data-act="new-memo">' + icons.plus + " 备忘</button>" +
    '<button class="xm-btn xm-btn--primary" type="button" data-act="new-todo">' + icons.plus + " 待办</button>" +
    '<button class="xm-btn" type="button" data-act="new-vault" title="新建随身笔记（名字 + 内容，点一下复制）">' +
    icons.plus + " 随身笔记</button>" +
    '<button class="xm-btn" type="button" data-act="from-clipboard" ' +
    'title="把剪贴板里的文字变成一条备忘" aria-label="从剪贴板新建备忘">' + icons.clipboard + " 粘贴</button>" +
    '<button class="xm-btn xm-btn--icon" type="button" data-act="trash" title="回收站" aria-label="回收站">' + icons.trash + "</button>" +
    '<button class="xm-btn xm-btn--icon" type="button" data-act="settings" title="设置" aria-label="设置">' + icons.gear + "</button>" +
    "</div>" +
    '<div class="xm-filters" data-on="0" role="group" aria-label="筛选便签">' +
    '<div class="xm-filters__group" data-group="due" role="group" aria-label="按时间筛选">' +
    '<button class="xm-chip" type="button" data-due="all" data-active="1">全部</button>' +
    '<button class="xm-chip" type="button" data-due="today" data-active="0">今天</button>' +
    '<button class="xm-chip" type="button" data-due="overdue" data-active="0">逾期</button>' +
    '<button class="xm-chip" type="button" data-due="tomorrow" data-active="0">明天</button>' +
    "</div>" +
    '<div class="xm-filters__group" data-group="kind" role="group" aria-label="按类型筛选">' +
    '<button class="xm-chip" type="button" data-kind="all" data-active="1">全部</button>' +
    '<button class="xm-chip" type="button" data-kind="memo" data-active="0">备忘</button>' +
    '<button class="xm-chip" type="button" data-kind="todo" data-active="0">待办</button>' +
    '<button class="xm-chip" type="button" data-kind="vault" data-active="0">随身笔记</button>' +
    "</div>" +
    '<div class="xm-filters__group" data-group="color" role="group" aria-label="按颜色筛选">' +
    '<button class="xm-chip xm-chip--dot" type="button" data-color="all" data-active="1" title="全部颜色" aria-label="全部颜色"><i class="xm-chip__dot"></i>全色</button>' +
    NOTE_COLORS.map((color) => '<button class="xm-chip xm-chip--dot" type="button" data-color="' + color.key + '" data-active="0" title="' + color.label + '" aria-label="' + color.label + '"><i class="xm-chip__dot"></i></button>').join("") +
    "</div>" +
    '<button class="xm-filters__clear" type="button" data-act="filters-clear">清除</button>' +
    "</div>" +
    '<div class="xm-panel__list" role="listbox" aria-label="便签列表"></div>' +
    '<footer class="xm-panel__foot">' +
    '<span class="xm-panel__hint">↑↓ 选择 · Enter 打开</span>' +
    '<span class="xm-panel__count"></span>' +
    "</footer>" +
    // 版本详情：盖住整块面板内容区，点历史卡片打开（task-28，DOM 契约见 docs/ui-contract.md §8.7）
    '<div class="xm-version" hidden>' +
    '<div class="xm-version__paper">' +
    '<div class="xm-version__head">' +
    '<span class="xm-version__time"></span>' +
    '<span class="xm-version__chars"></span>' +
    '<div class="xm-version__modes" role="group" aria-label="查看方式">' +
    '<button class="xm-btn xm-btn--ghost xm-version__mode" type="button" data-diff-mode="diff" data-active="1">差异</button>' +
    '<button class="xm-btn xm-btn--ghost xm-version__mode" type="button" data-diff-mode="full" data-active="0">全文</button>' +
    "</div>" +
    '<button class="xm-btn xm-btn--ghost" type="button" data-act="version-close">返回</button>' +
    "</div>" +
    '<div class="xm-version__scroll">' +
    '<div class="xm-version__title"></div>' +
    '<div class="xm-version__text" data-mode="diff"></div>' +
    "</div>" +
    '<div class="xm-version__foot">' +
    '<button class="xm-btn xm-btn--primary" type="button" data-act="restore-version" data-ts="">恢复这一版</button>' +
    "</div>" +
    "</div>" +
    "</div>" +
    '<div class="xm-toast" data-show="0"></div>' +
    "</section>";

  const headEl = body.querySelector<HTMLElement>(".xm-panel__head")!;
  const actionsEl = body.querySelector<HTMLElement>(".xm-panel__actions")!;
  const filtersEl = body.querySelector<HTMLElement>(".xm-filters")!;
  const historyBar = body.querySelector<HTMLElement>(".xm-history__bar")!;
  const historyNoteEl = body.querySelector<HTMLElement>(".xm-history__note")!;
  const listEl = body.querySelector<HTMLElement>(".xm-panel__list")!;
  const searchEl = body.querySelector<HTMLInputElement>(".xm-search")!;
  const countEl = body.querySelector<HTMLElement>(".xm-panel__count")!;
  const hintEl = body.querySelector<HTMLElement>(".xm-panel__hint")!;
  const memoBtn = body.querySelector<HTMLButtonElement>('[data-act="new-memo"]')!;
  const todoBtn = body.querySelector<HTMLButtonElement>('[data-act="new-todo"]')!;
  const vaultBtn = body.querySelector<HTMLButtonElement>('[data-act="new-vault"]')!;
  const clipboardBtn = body.querySelector<HTMLButtonElement>('[data-act="from-clipboard"]')!;
  const trashBtn = body.querySelector<HTMLButtonElement>('[data-act="trash"]')!;
  const settingsBtn = body.querySelector<HTMLButtonElement>('[data-act="settings"]')!;
  const toastEl = body.querySelector<HTMLElement>(".xm-toast")!;
  const versionEl = body.querySelector<HTMLElement>(".xm-version")!;
  const versionTimeEl = versionEl.querySelector<HTMLElement>(".xm-version__time")!;
  const versionCharsEl = versionEl.querySelector<HTMLElement>(".xm-version__chars")!;
  const versionTitleEl = versionEl.querySelector<HTMLElement>(".xm-version__title")!;
  const versionTextEl = versionEl.querySelector<HTMLElement>(".xm-version__text")!;
  const versionModeBtns = Array.from(
    versionEl.querySelectorAll<HTMLButtonElement>(".xm-version__mode"),
  );
  const versionRestoreBtn = versionEl.querySelector<HTMLButtonElement>('[data-act="restore-version"]')!;

  /** 全部便签（已排序）：置顶优先，其余按更新时间倒序 */
  let notes: Note[] = [];
  /** 过滤后的结果 */
  let views: CardView[] = [];
  /** 键盘选中的下标，-1 表示没有选中 */
  let selected = -1;
  let creating = false;
  /** 面板筛选（契约 §16.1）：时间 / 类型 / 颜色，和搜索是 AND 关系 */
  let filterDue: DueFilter = "all";
  let filterKind: KindFilter = "all";
  let filterColor: ColorFilter = "all";

  /** 当前视图：便签列表 / 回收站 / 修改记录 */
  let mode: "list" | "trash" | "history" = "list";
  /** 修改记录：当前便签的旧版本 + 键盘选中项 */
  let historyItems: NoteVersion[] = [];
  let historyNoteId = "";
  let historySelected = -1;
  /** 详情请求序号：切版本/关详情时旧请求回来不能覆盖新内容 */
  let versionRequest = 0;
  /** 当前详情：正文 / 上一版 / 第几版 / 差异或全文 */
  let versionDetail: NoteVersionDetail | null = null;
  let versionPrev: NoteVersionDetail | null = null;
  let versionNumber = 0;
  let versionHasPrev = false;
  let versionPrevFailed = false;
  let versionMode: "diff" | "full" = "diff";
  /** 提前算好的差异，头部统计和正文共用，避免重复跑一遍 Myers */
  let versionDiffOps: DiffOp[] | null = null;
  let versionStats = { added: 0, removed: 0 };
  let trashItems: TrashItem[] = [];
  let trashSelected = -1;
  /** 清空回收站的二次确认是否已经按下 */
  let emptyArmed = false;
  let emptyTimer = 0;
  /** 面板里按 Delete 的二次确认目标 */
  let deleteArmId = "";
  let deleteArmTimer = 0;
  /** 恢复/清空等操作进行中，避免连点 */
  let busy = false;
  /** 正在显示的撤销记录 */
  let undoPending: PendingUndo | null = null;
  let undoShownFor = "";
  let toastTimer = 0;

  // ---------- 数据 -> 视图 ----------
  function toView(note: Note): CardView {
    // 待办卡只展示前 2 条 + “还有 N 项”，剩下的数量交给右下角进度（2/5）
    const shownTodos = note.todos.slice(0, 2).map((t) => (t.done ? "✓ " : "") + t.text);
    let todoText = shownTodos.join(" · ");
    const restTodos = note.todos.length - shownTodos.length;
    if (restTodos > 0) todoText += "（还有 " + restTodos + " 项）";
    // memo 正文先去掉 Markdown 标记再上卡片：卡片是摘要，不该出现 # 和 **
    const plain = note.kind === "memo" ? mdToPlain(note.content) : note.content;
    // 随身笔记的卡片正文单独渲染（名字 + 打码），这里不放内容
    const bodyText = note.kind === "todo" ? todoText : note.kind === "vault" ? "" : plain.replace(/\s+/g, " ").trim();
    const firstLine = plain.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
    const empty =
      note.kind === "vault" ? !note.title.trim() && (note.items ?? []).length === 0 : note.title.trim() === "" && bodyText === "";
    const title =
      note.kind === "vault"
        ? note.title.trim() || vaultTitle(note)
        : note.title.trim() || firstLine || (empty ? "（空便签）" : "无标题");
    return {
      note,
      title,
      summary: empty ? "" : bodyText,
      progress: note.kind === "todo" ? todoProgress(note.todos.filter((t) => t.done).length, note.todos.length) : "",
      reminder: note.reminder_at && !note.reminder_done ? reminderLabel(note.reminder_at) : "",
    };
  }

  function sortNotes(list: Note[]): Note[] {
    return list.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updated_at || 0) - (a.updated_at || 0);
    });
  }

  /** 搜索关键词（小写）；拼音首字母只认纯字母 */
  function keyword(): string {
    return searchEl.value.trim().toLowerCase();
  }

  /** 输入时晚 140ms 再重排：长文拼音扫描不必每敲一个字就跑一遍 */
  const renderSearchSoon = debounce(() => {
    if (mode === "list") renderList();
  }, 140);

  /** 清空搜索 / 切筛选时立刻重排，别让用户等防抖 */
  function renderListNow(): void {
    renderSearchSoon.cancel();
    selected = -1;
    renderList();
  }

  /** 转义成能塞进 innerHTML 的文本（卡片标题/摘要来自用户内容，必须转义） */
  function escHtml(text: string): string {
    return text.replace(/[&<>"']/g, (ch) => {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === '"') return "&quot;";
      return "&#39;";
    });
  }

  /** 把一串汉字映射成拼音首字母，同时记住每个字在原文里的位置（用于高亮） */
  function mapInitials(text: string): { initials: string; positions: MatchRange[] } {
    let initials = "";
    const positions: MatchRange[] = [];
    let cursor = 0;
    for (const ch of Array.from(text)) {
      const initial = PINYIN_INITIAL[ch];
      if (initial) {
        initials += initial;
        positions.push({ start: cursor, end: cursor + ch.length });
      }
      cursor += ch.length;
    }
    return { initials, positions };
  }

  /** 字面命中：不区分大小写，区间按原文坐标 */
  function literalRanges(text: string, key: string): MatchRange[] {
    if (!key) return [];
    const lower = text.toLowerCase();
    const ranges: MatchRange[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      const hit = lower.indexOf(key, cursor);
      if (hit < 0) break;
      ranges.push({ start: hit, end: hit + key.length });
      cursor = hit + key.length;
    }
    return ranges;
  }

  /** 拼音首字母命中：把 key 映射回对应的汉字区间（契约 §16.2） */
  function initialRanges(text: string, key: string): MatchRange[] {
    if (!key || !/^[a-z]+$/.test(key)) return [];
    const { initials, positions } = mapInitials(text);
    if (initials.length < key.length) return [];
    const ranges: MatchRange[] = [];
    let cursor = 0;
    while (cursor <= initials.length - key.length) {
      const hit = initials.indexOf(key, cursor);
      if (hit < 0) break;
      // 只认挨着的汉字：bg 要命中的是「报告」这种连在一起的两个字；
      // 否则「标…滚」隔着半页也能凑出 bg，一搜全是假结果
      let adjacent = true;
      for (let i = 1; i < key.length; i++) {
        if (positions[hit + i - 1].end !== positions[hit + i].start) {
          adjacent = false;
          break;
        }
      }
      if (adjacent) {
        const first = positions[hit];
        const last = positions[hit + key.length - 1];
        if (first && last) ranges.push({ start: first.start, end: last.end });
      }
      cursor = hit + 1;
    }
    return ranges;
  }

  /** 合并重叠/相邻的命中区间，避免 <mark> 嵌套 */
  function mergeRanges(ranges: MatchRange[]): MatchRange[] {
    const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: MatchRange[] = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    return merged;
  }

  function searchRanges(text: string, key: string): MatchRange[] {
    return mergeRanges([...literalRanges(text, key), ...initialRanges(text, key)]);
  }

  /** 一段文字是否命中：字面 or 拼音首字母 */
  function textMatches(text: string, key: string): boolean {
    if (!key) return true;
    if (text.toLowerCase().includes(key)) return true;
    return initialRanges(text, key).length > 0;
  }

  /** 便签搜索：vault 只搜名字/备注，别把内容搜出来（契约 §13.6 / §16.2） */
  function matches(note: Note, key: string): boolean {
    if (!key) return true;
    if (note.kind === "vault") {
      return [note.title, ...(note.items ?? []).flatMap((item) => [item.label, item.note])].some((text) =>
        textMatches(text, key),
      );
    }
    return [note.title, note.content, ...note.todos.map((t) => t.text)].some((text) => textMatches(text, key));
  }

  function dayRange(offset: number): [number, number] {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + offset);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return [start.getTime(), end.getTime()];
  }

  /** 时间筛选：完成的事项不算，提醒只看未处理的（契约 §16.1） */
  function matchesDue(note: Note, filter: DueFilter): boolean {
    if (filter === "all") return true;
    if (filter === "overdue") {
      const now = Date.now();
      return note.todos.some((item) => !item.done && item.due_at != null && item.due_at < now);
    }
    const [start, end] = dayRange(filter === "today" ? 0 : 1);
    const todoDue = note.todos.some(
      (item) => !item.done && item.due_at != null && item.due_at >= start && item.due_at < end,
    );
    const reminderDue = note.reminder_at != null && !note.reminder_done && note.reminder_at >= start && note.reminder_at < end;
    return todoDue || reminderDue;
  }

  function matchesFilters(note: Note): boolean {
    if (filterKind !== "all" && note.kind !== filterKind) return false;
    if (filterColor !== "all" && note.color !== filterColor) return false;
    return matchesDue(note, filterDue);
  }

  function filtersActive(): boolean {
    return filterDue !== "all" || filterKind !== "all" || filterColor !== "all";
  }

  /** 搜索命中高亮（契约 §13.4 / §16.2）：字面命中 + 拼音首字母命中都包 <mark class="xm-hit"> */
  function highlight(text: string, key: string): string {
    if (!key || !text) return escHtml(text);
    const ranges = searchRanges(text, key);
    if (ranges.length === 0) return escHtml(text);
    const parts: string[] = [];
    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) parts.push(escHtml(text.slice(cursor, range.start)));
      parts.push('<mark class="xm-hit">' + escHtml(text.slice(range.start, range.end)) + "</mark>");
      cursor = range.end;
    }
    if (cursor < text.length) parts.push(escHtml(text.slice(cursor)));
    return parts.join("");
  }

  // ---------- 通用提示 ----------
  /** 普通提示（不能点）；撤销提示另外用 showUndoToast，会打开点击 */
  function showToast(text: string, ms = 2200): void {
    toastEl.textContent = text;
    toastEl.dataset.show = "1";
    toastEl.style.pointerEvents = "none";
    toastEl.style.cursor = "";
    toastEl.title = "";
    undoPending = null;
    undoShownFor = "";
    window.clearTimeout(toastTimer);
    window.clearTimeout(undoHideTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.dataset.show = "0";
    }, ms);
  }

  let undoHideTimer = 0;
  function hideUndoToast(): void {
    window.clearTimeout(undoHideTimer);
    toastEl.dataset.show = "0";
    toastEl.style.pointerEvents = "none";
    toastEl.style.cursor = "";
    toastEl.title = "";
    undoPending = null;
    undoShownFor = "";
  }

  /** 「已删除 · 撤销」：5 秒内点一下就能恢复（契约 §12.5） */
  function showUndoToast(pending: PendingUndo): void {
    const left = pending.deletedAt + UNDO_TTL - Date.now();
    if (left <= 0) {
      hideUndoToast();
      return;
    }
    undoPending = pending;
    undoShownFor = pending.noteId;
    toastEl.textContent = "已删除 · 撤销";
    toastEl.dataset.show = "1";
    toastEl.style.pointerEvents = "auto";
    toastEl.style.cursor = "pointer";
    toastEl.title = "点一下恢复这张便签";
    window.clearTimeout(toastTimer);
    window.clearTimeout(undoHideTimer);
    undoHideTimer = window.setTimeout(() => {
      if (undoPending?.noteId === pending.noteId) hideUndoToast();
    }, left);
  }

  // ---------- 渲染 ----------
  function updateTrashBadge(): void {
    const count = trashItems.length;
    // 角标位置只有 14px 高，超过两位就截成「99+」（视觉 paper.css 的约定）。
    if (count > 0) trashBtn.dataset.count = count > 99 ? "99+" : String(count);
    else delete trashBtn.dataset.count;
    trashBtn.title = count > 0 ? "回收站（" + count + " 条）" : "回收站";
  }

  function setChipBadge(btn: HTMLButtonElement, count: number): void {
    let badge = btn.querySelector<HTMLElement>(".xm-chip__badge");
    if (count <= 0) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "xm-chip__badge";
      btn.appendChild(badge);
    }
    badge.textContent = String(count);
  }

  /** 筛选条的高亮和计数：计数会跟着搜索词、类型、颜色一起变，切到别处则整条隐藏 */
  function syncFilterBar(): void {
    filtersEl.dataset.on = filtersActive() ? "1" : "0";
    filtersEl.querySelectorAll<HTMLButtonElement>("[data-due]").forEach((btn) => {
      const on = btn.dataset.due === filterDue;
      btn.dataset.active = on ? "1" : "0";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    filtersEl.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((btn) => {
      const on = btn.dataset.kind === filterKind;
      btn.dataset.active = on ? "1" : "0";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    filtersEl.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((btn) => {
      const on = btn.dataset.color === filterColor;
      btn.dataset.active = on ? "1" : "0";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function updateFilterBadges(): void {
    const key = keyword();
    const base = notes.filter(
      (note) =>
        matches(note, key) &&
        (filterKind === "all" || note.kind === filterKind) &&
        (filterColor === "all" || note.color === filterColor),
    );
    filtersEl.querySelectorAll<HTMLButtonElement>("[data-due]").forEach((btn) => {
      const value = btn.dataset.due as DueFilter;
      if (value === "all") return;
      setChipBadge(btn, base.filter((note) => matchesDue(note, value)).length);
    });
  }

  function clearFilters(): void {
    filterDue = "all";
    filterKind = "all";
    filterColor = "all";
    renderListNow();
  }

  function render(): void {
    if (mode === "trash") renderTrash();
    else if (mode === "history") renderHistory();
    else renderList();
  }

  function renderList(): void {
    const key = keyword();
    const active = !!key || filtersActive();
    views = sortNotes(notes)
      .filter((note) => matches(note, key) && matchesFilters(note))
      .map(toView);
    listEl.innerHTML = "";

    if (views.length === 0) {
      const empty = document.createElement("div");
      empty.className = "xm-empty";
      empty.textContent = filtersActive() ? "没有符合条件的便签" : key ? "没有找到「" + searchEl.value.trim() + "」" : "还没有便签";
      if (filtersActive()) {
        const clear = document.createElement("button");
        clear.className = "xm-btn xm-btn--ghost";
        clear.type = "button";
        clear.dataset.act = "filters-clear";
        clear.textContent = "清除筛选";
        empty.append(document.createElement("br"), clear);
      }
      listEl.appendChild(empty);
      selected = -1;
      syncFilterBar();
      updateFilterBadges();
      updateFoot(active ? "0 / " + notes.length : notes.length + " 张");
      return;
    }

    views.forEach((view, index) => {
      listEl.appendChild(createCard(view, index));
    });
    selected = Math.min(selected < 0 ? 0 : selected, views.length - 1);
    applySelection();
    syncFilterBar();
    updateFilterBadges();
    updateFoot(active ? views.length + " / " + notes.length : notes.length + " 张");
  }

  function renderTrash(): void {
    listEl.innerHTML = "";

    const head = document.createElement("div");
    head.className = "xm-trash__head";
    const intro = document.createElement("div");
    intro.className = "xm-trash__intro";
    intro.textContent = trashItems.length > 0 ? "删除的便签会在这里留 30 天。" : "";
    const actions = document.createElement("div");
    actions.className = "xm-trash__actions";

    const emptyBtn = document.createElement("button");
    emptyBtn.className = "xm-btn";
    emptyBtn.type = "button";
    emptyBtn.dataset.act = "empty";
    // 二次确认态：视觉用 [data-confirm="1"] 把它画成砖红底（只看文字会不够醒目）。
    emptyBtn.dataset.confirm = emptyArmed ? "1" : "";
    emptyBtn.textContent = emptyArmed ? "确认清空？" : "清空回收站";
    emptyBtn.disabled = trashItems.length === 0 || busy;

    const backBtn = document.createElement("button");
    backBtn.className = "xm-btn xm-btn--ghost";
    backBtn.type = "button";
    backBtn.dataset.act = "back";
    backBtn.textContent = "返回";

    actions.append(emptyBtn, backBtn);
    head.append(intro, actions);
    listEl.appendChild(head);

    if (trashItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "xm-trash__empty";
      empty.textContent = "回收站是空的";
      listEl.appendChild(empty);
      trashSelected = -1;
      updateFoot("0 条");
      return;
    }

    trashItems.forEach((item, index) => {
      listEl.appendChild(createTrashRow(item, index));
    });
    trashSelected = Math.min(trashSelected < 0 ? 0 : trashSelected, trashItems.length - 1);
    applyTrashSelection();
    updateFoot(trashItems.length + " 条");
  }

  function createTrashRow(item: TrashItem, index: number): HTMLElement {
    const row = document.createElement("article");
    row.className = "xm-trash__row";
    row.dataset.id = item.id;
    row.dataset.index = String(index);
    row.dataset.selected = "0";
    row.tabIndex = 0;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");

    const title = document.createElement("span");
    title.className = "xm-trash__title";
    title.textContent = item.title;

    const preview = document.createElement("span");
    preview.className = "xm-trash__preview";
    preview.textContent = item.preview || "（空便签）";

    const meta = document.createElement("span");
    meta.className = "xm-trash__meta";
    meta.textContent = "删除于 " + relativeTime(item.deleted_at);

    const restore = document.createElement("button");
    restore.className = "xm-btn";
    restore.type = "button";
    restore.dataset.act = "restore";
    restore.dataset.id = item.id;
    restore.textContent = "恢复";
    restore.disabled = busy;

    row.append(title, preview, meta, restore);
    return row;
  }

  function updateFoot(countText: string): void {
    hintEl.textContent =
      mode === "trash"
        ? "↑↓ 选择 · Enter 恢复 · Esc 返回"
        : mode === "history"
          ? "↑↓ 选择 · Enter 恢复 · Esc 返回"
          : "↑↓ 选择 · Enter 打开 · Del 删除";
    countEl.textContent = countText;
  }

  // ---------- 修改记录 ----------
  function createHistoryCard(version: NoteVersion, index: number): HTMLElement {
    const card = document.createElement("article");
    card.className = "xm-card xm-history__card";
    card.dataset.index = String(index);
    card.dataset.ts = String(version.ts);
    card.dataset.selected = "0";
    card.tabIndex = 0;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", "false");

    const head = document.createElement("div");
    head.className = "xm-card__head";

    const time = document.createElement("span");
    time.className = "xm-card__title xm-history__time";
    // 刚存下的几版都在一分钟内，全写「刚刚」分不清先后，这时直接给钟点
    time.textContent =
      Date.now() - version.ts < 5 * 60_000
        ? new Date(version.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        : relativeTime(version.ts);

    const chars = document.createElement("span");
    chars.className = "xm-card__badge xm-history__chars";
    chars.textContent = version.chars + " 字";

    const preview = document.createElement("p");
    preview.className = "xm-card__text xm-history__preview";
    preview.textContent = version.preview || "（空便签）";

    const foot = document.createElement("div");
    foot.className = "xm-card__foot";

    const title = document.createElement("span");
    title.className = "xm-card__time xm-history__title";
    title.textContent = version.title || "（无标题）";

    const restore = document.createElement("button");
    restore.className = "xm-btn xm-history__restore";
    restore.type = "button";
    restore.dataset.act = "restore-version";
    restore.dataset.ts = String(version.ts);
    restore.textContent = "恢复";

    head.append(time, chars);
    // 标题和页头重复，就不在每张卡里再写一遍；只有旧版本标题确实不同才显示
    if (version.title && version.title !== historyNoteEl.textContent) {
      foot.append(title);
    } else {
      restore.style.marginLeft = "auto";
    }
    foot.append(restore);
    card.append(head, preview, foot);
    return card;
  }

  function renderHistory(): void {
    listEl.innerHTML = "";

    if (historyItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "xm-empty xm-history__empty";
      empty.innerHTML = "这张便签还没有历史版本<br><small>每次保存后，旧内容会自动留一份。</small>";
      listEl.appendChild(empty);
      historySelected = -1;
      updateFoot("0 个版本");
      return;
    }

    historyItems.forEach((version, index) => {
      listEl.appendChild(createHistoryCard(version, index));
    });
    historySelected = Math.min(historySelected < 0 ? 0 : historySelected, historyItems.length - 1);
    applyHistorySelection();
    updateFoot(historyItems.length + " 个版本");
  }

  function applyHistorySelection(): void {
    const rows = listEl.querySelectorAll<HTMLElement>(".xm-history__card");
    rows.forEach((row, index) => {
      const on = index === historySelected;
      row.dataset.selected = on ? "1" : "0";
      row.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (historySelected >= 0) rows[historySelected]?.scrollIntoView({ block: "nearest" });
  }

  function moveHistorySelection(delta: number): void {
    if (historyItems.length === 0) return;
    if (historySelected < 0) historySelected = 0;
    else historySelected = (historySelected + delta + historyItems.length) % historyItems.length;
    applyHistorySelection();
    // 详情层开着时，方向键切版本要跟着换内容（task-28 验收）
    if (!versionEl.hidden && historyItems[historySelected]) {
      void openVersionDetail(historyItems[historySelected]);
    }
  }

  /** 关掉版本详情，回到历史列表；键盘操作时把焦点还给选中的卡片 */
  function closeVersionDetail(): void {
    versionRequest += 1;
    versionEl.hidden = true;
    versionTextEl.textContent = "";
    versionTextEl.dataset.mode = "diff";
    versionRestoreBtn.dataset.ts = "";
    versionRestoreBtn.disabled = false;
    versionDetail = null;
    versionPrev = null;
    versionDiffOps = null;
    versionStats = { added: 0, removed: 0 };
    versionNumber = 0;
    versionHasPrev = false;
    versionPrevFailed = false;
    versionMode = "diff";
    syncVersionModes();
    if (mode === "history" && historySelected >= 0) {
      listEl.querySelectorAll<HTMLElement>(".xm-history__card")[historySelected]?.focus();
    }
  }

  /** 当前便签的类型（历史版本只存内容，类型从面板列表里取） */
  function versionKind(): Note["kind"] {
    const note = notes.find((item) => item.id === historyNoteId);
    if (note) return note.kind;
    if (versionDetail && (versionDetail.items ?? []).length > 0) return "vault";
    if (versionDetail && versionDetail.todos.length > 0) return "todo";
    return "memo";
  }

  function todoDiffText(todos: NoteVersionDetail["todos"]): string {
    return todos.map((todo) => (todo.done ? "[x] " : "[ ] ") + todo.text).join("\n");
  }

  function vaultDiffText(items: NoteVersionDetail["items"]): string {
    return items.map((item) => item.label.trim() || "（未命名）").join("\n");
  }

  /** 差异数据只算一次：头部 +X −Y 和正文高亮用同一份 */
  function prepareVersionDiff(): void {
    versionDiffOps = null;
    versionStats = { added: 0, removed: 0 };
    if (!versionDetail || !versionPrev) return;
    const kind = versionKind();
    let prevText: string;
    let nextText: string;
    if (kind === "todo") {
      prevText = todoDiffText(versionPrev.todos);
      nextText = todoDiffText(versionDetail.todos);
    } else if (kind === "vault") {
      // 随身笔记只比名字；value 永远不参与差异，避免明文泄漏
      prevText = vaultDiffText(versionPrev.items ?? []);
      nextText = vaultDiffText(versionDetail.items ?? []);
    } else {
      prevText = versionPrev.content;
      nextText = versionDetail.content;
    }
    versionDiffOps = diffText(prevText, nextText);
    versionStats = diffStats(versionDiffOps);
  }

  /** 把当前版本铺成普通全文：memo 保留换行，todo 渲染成只读勾选列表，vault 打码条目 */
  function renderVersionFullBody(detail: NoteVersionDetail): void {
    const versionItems = detail.items ?? [];
    if (versionItems.length > 0) {
      // 随身笔记的历史版本：只显示名字和打码内容（契约 §13.6）
      const box = document.createElement("div");
      box.className = "xm-version__vault";
      versionItems.forEach((item) => {
        const row = document.createElement("div");
        row.className = "xm-version__vault-row";
        const name = document.createElement("b");
        name.textContent = item.label.trim() || "（未命名）";
        const value = document.createElement("span");
        value.className = "xm-version__vault-value";
        value.dataset.masked = "1";
        value.textContent = " · " + maskSecret(item.value, false);
        row.append(name, value);
        box.appendChild(row);
      });
      versionTextEl.appendChild(box);
    } else if (detail.todos.length > 0) {
      const list = document.createElement("ul");
      list.className = "xm-version__todos";
      detail.todos.forEach((todo) => {
        const row = document.createElement("li");
        row.className = "xm-version__todo";
        row.dataset.done = todo.done ? "1" : "0";
        // 勾选框交给 CSS 画（.xm-version__todo[data-done]），这里只留空的方块
        const check = document.createElement("span");
        check.className = "xm-version__todo-check";
        check.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.className = "xm-version__todo-text";
        text.textContent = todo.text || "（空待办）";
        row.append(check, text);
        list.appendChild(row);
      });
      versionTextEl.appendChild(list);
    } else if (detail.content.trim()) {
      // 用文本节点追加，不要 textContent 覆盖：最早一版的提示行要先留在上面
      versionTextEl.appendChild(document.createTextNode(detail.content));
    } else {
      versionTextEl.appendChild(document.createTextNode("（空便签）"));
    }
  }

  function appendDiffNote(text: string): void {
    const note = document.createElement("div");
    note.className = "xm-diff__note";
    note.textContent = text;
    versionTextEl.appendChild(note);
  }

  function buildDiffBox(ops: DiffOp[]): HTMLElement {
    const box = document.createElement("div");
    box.className = "xm-diff";
    ops.forEach((op) => {
      if (!op.text) return;
      const span = document.createElement("span");
      span.className = "xm-diff__" + op.type;
      span.textContent = op.text;
      box.appendChild(span);
    });
    return box;
  }

  function appendDiffLegend(): void {
    const legend = document.createElement("div");
    legend.className = "xm-diff__legend";
    legend.innerHTML =
      '<i class="xm-diff__swatch xm-diff__swatch--add"></i>新增' +
      '<i class="xm-diff__swatch xm-diff__swatch--del"></i>删除';
    versionTextEl.appendChild(legend);
  }

  interface VaultDiffRow {
    type: "same" | "add" | "del";
    item: Note["items"][number];
  }

  /** 随身笔记按名字做 LCS：只显示新增 / 删除 / 未变，不碰 value 明文 */
  function diffVaultItems(
    prevItems: Note["items"],
    nextItems: Note["items"],
  ): VaultDiffRow[] {
    const prevLabels = prevItems.map((item) => item.label.trim() || "（未命名）");
    const nextLabels = nextItems.map((item) => item.label.trim() || "（未命名）");
    const n = prevLabels.length;
    const m = nextLabels.length;
    const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] =
          prevLabels[i] === nextLabels[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const rows: VaultDiffRow[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (prevLabels[i] === nextLabels[j]) {
        rows.push({ type: "same", item: nextItems[j] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        rows.push({ type: "del", item: prevItems[i] });
        i += 1;
      } else {
        rows.push({ type: "add", item: nextItems[j] });
        j += 1;
      }
    }
    while (i < n) {
      rows.push({ type: "del", item: prevItems[i] });
      i += 1;
    }
    while (j < m) {
      rows.push({ type: "add", item: nextItems[j] });
      j += 1;
    }
    return rows;
  }

  function renderVaultDiff(): void {
    if (!versionDetail || !versionPrev) return;
    const rows = diffVaultItems(versionPrev.items ?? [], versionDetail.items ?? []);
    if (!rows.some((row) => row.type !== "same")) {
      appendDiffNote("这一版和上一版内容一样");
      return;
    }
    rows.forEach((row) => {
      const line = document.createElement("div");
      line.className = "xm-diff__item xm-diff__item--" + row.type;
      const name = document.createElement("b");
      name.textContent = row.item.label.trim() || "（未命名）";
      const value = document.createElement("span");
      value.textContent = " · " + maskSecret(row.item.value, false);
      line.append(name, value);
      versionTextEl.appendChild(line);
    });
  }

  /** 只重画正文：切换「差异 / 全文」时不重新请求后端 */
  function renderVersionBody(): void {
    versionTextEl.innerHTML = "";
    versionTextEl.dataset.mode = versionMode;
    if (!versionDetail) return;

    if (!versionHasPrev) {
      appendDiffNote("最早的一版，没有可对比的上一版");
      renderVersionFullBody(versionDetail);
      return;
    }
    if (versionMode === "full" || versionPrevFailed || !versionPrev) {
      renderVersionFullBody(versionDetail);
      return;
    }
    if (versionKind() === "vault") {
      renderVaultDiff();
      return;
    }

    const ops = versionDiffOps ?? [];
    if (!ops.some((op) => op.type !== "same")) {
      appendDiffNote("这一版和上一版内容一样");
      return;
    }
    versionTextEl.appendChild(buildDiffBox(ops));
    appendDiffLegend();
  }

  function updateVersionHeader(): void {
    if (!versionDetail) {
      versionCharsEl.textContent = "";
      return;
    }
    if (versionMode === "diff" && versionHasPrev && !versionPrevFailed) {
      versionCharsEl.textContent =
        "第 " + versionNumber + " 版 · 较上一版 +" + versionStats.added +
        " −" + versionStats.removed + " 字";
    } else {
      versionCharsEl.textContent = versionDetail.chars + " 字";
    }
  }

  function syncVersionModes(): void {
    versionModeBtns.forEach((button) => {
      const buttonMode = button.dataset.diffMode;
      const disabled =
        !versionHasPrev ||
        (buttonMode === "diff" && versionPrevFailed) ||
        (buttonMode === "full" && !versionHasPrev);
      button.disabled = disabled;
      const active = !disabled && buttonMode === versionMode;
      button.dataset.active = active ? "1" : "0";
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function switchVersionMode(next: "diff" | "full"): void {
    if (next === versionMode) return;
    if (next === "diff" && (!versionHasPrev || versionPrevFailed)) return;
    versionMode = next;
    renderVersionBody();
    updateVersionHeader();
    syncVersionModes();
  }

  /** 历史版本顶部的标题：随身笔记本来就没有标题，不摆「（无标题）」占位 */
  function versionTitleText(title: string): string {
    const note = notes.find((item) => item.id === historyNoteId);
    if (note && note.kind === "vault") return "";
    return title || "（无标题）";
  }

  /** 渲染整层：先算差异，再铺头部和正文 */
  function renderVersionDetail(): void {
    const detail = versionDetail;
    if (!detail) return;
    versionTimeEl.textContent = clockTime(detail.ts);
    versionTitleEl.textContent = versionTitleText(detail.title);
    versionTitleEl.title = detail.title || "";
    versionTitleEl.hidden = !versionTitleEl.textContent;
    versionCharsEl.textContent = detail.chars + " 字";
    prepareVersionDiff();
    updateVersionHeader();
    syncVersionModes();
    renderVersionBody();
    versionRestoreBtn.dataset.ts = String(detail.ts);
    versionRestoreBtn.disabled = false;
  }

  /** 点历史卡片：并发取「这一版 + 上一版」，再决定差异还是全文；切来切去时只认最后一次请求 */
  async function openVersionDetail(version: NoteVersion): Promise<void> {
    if (!historyNoteId) return;
    const noteId = historyNoteId;
    const index = historyItems.findIndex((item) => item.ts === version.ts);
    const prevVersion = index >= 0 ? historyItems[index + 1] : undefined;
    const request = versionRequest + 1;
    versionRequest = request;

    // 先铺骨架，长文也不会有空白等待
    versionEl.hidden = false;
    versionTimeEl.textContent = clockTime(version.ts);
    versionCharsEl.textContent = version.chars + " 字";
    versionTitleEl.textContent = versionTitleText(version.title);
    versionTitleEl.title = version.title || "";
    versionTitleEl.hidden = !versionTitleEl.textContent;
    versionTextEl.textContent = "正在读取…";
    versionTextEl.dataset.mode = "diff";
    versionRestoreBtn.dataset.ts = String(version.ts);
    versionRestoreBtn.disabled = true;
    versionDetail = null;
    versionPrev = null;
    versionDiffOps = null;
    versionStats = { added: 0, removed: 0 };
    versionNumber = index + 1;
    versionHasPrev = false;
    versionPrevFailed = false;
    versionMode = "diff";
    syncVersionModes();

    try {
      const prevPromise: Promise<NoteVersionDetail | null> = prevVersion
        ? api.getNoteVersion(noteId, prevVersion.ts).catch((error: unknown) => {
            console.error("读取上一版失败", error);
            return null;
          })
        : Promise.resolve(null);
      const [detail, prev] = await Promise.all([
        api.getNoteVersion(noteId, version.ts),
        prevPromise,
      ]);
      if (request !== versionRequest || historyNoteId !== noteId) return;
      versionDetail = detail;
      versionPrev = prev;
      versionHasPrev = Boolean(prevVersion);
      versionPrevFailed = Boolean(prevVersion) && !prev;
      versionMode = versionPrevFailed ? "full" : "diff";
      renderVersionDetail();
      if (versionPrevFailed) showToast("读不到上一版，先看全文");
    } catch (error) {
      if (request !== versionRequest) return;
      console.error("读取版本详情失败", error);
      showToast("读不到这个版本");
      closeVersionDetail();
    }
  }

  /** 进修改记录：头部换成「修改记录 + 便签字 + 返回」，列表换成旧版本卡片 */
  async function openHistory(noteId: string): Promise<void> {
    if (mode === "history" && historyNoteId === noteId) return;
    closeVersionDetail();
    cancelDeleteArm();
    emptyArmed = false;
    window.clearTimeout(emptyTimer);
    mode = "history";
    historyNoteId = noteId;
    historySelected = -1;
    historyItems = [];
    headEl.hidden = true;
    actionsEl.hidden = true;
    filtersEl.hidden = true;
    historyBar.hidden = false;
    searchEl.disabled = true;
    listEl.className = "xm-panel__list xm-history";
    listEl.setAttribute("aria-label", "修改记录");
    const target = notes.find((note) => note.id === noteId);
    historyNoteEl.textContent = target ? toView(target).title : "便签";
    historyNoteEl.title = historyNoteEl.textContent;
    listEl.innerHTML = '<div class="xm-empty">正在读取…</div>';
    updateFoot("读取中");

    try {
      const items = await api.listNoteVersions(noteId);
      // 读取期间用户可能已经返回/切走，别把旧视图盖回来
      if (mode !== "history" || historyNoteId !== noteId) return;
      historyItems = items;
      renderHistory();
    } catch (error) {
      console.error("读取修改记录失败", error);
      if (mode !== "history" || historyNoteId !== noteId) return;
      listEl.innerHTML = '<div class="xm-empty">读不到修改记录</div>';
      historySelected = -1;
      updateFoot("0 个版本");
      showToast("读不到修改记录");
    }
  }

  /** 返回便签列表：保留搜索词，和进来之前一样 */
  function leaveHistory(): void {
    if (mode !== "history") return;
    closeVersionDetail();
    mode = "list";
    historyBar.hidden = true;
    headEl.hidden = false;
    actionsEl.hidden = false;
    filtersEl.hidden = false;
    searchEl.disabled = false;
    listEl.className = "xm-panel__list";
    listEl.setAttribute("aria-label", "便签列表");
    historyItems = [];
    historyNoteId = "";
    historySelected = -1;
    selected = -1;
    renderList();
    searchEl.focus();
  }

  /** 恢复某个旧版本；恢复后它自己也会留一条历史，恢复错了还能再回来 */
  async function restoreVersion(ts: number): Promise<void> {
    if (busy || !historyNoteId) return;
    busy = true;
    try {
      const restored = await api.restoreNoteVersion(historyNoteId, ts);
      showToast("已恢复到 " + relativeTime(ts) + "的版本", 2800);
      closeVersionDetail();
      const snapshot = await api.getSnapshot();
      notes = snapshot.notes
        .filter((note) => !note.hidden)
        .map((note) => ({ ...note, items: note.items ?? [], reveal: !!note.reveal }));
      updateTrashBadge();
      const target = notes.find((note) => note.id === restored.id);
      if (target) {
        historyNoteEl.textContent = toView(target).title;
        historyNoteEl.title = historyNoteEl.textContent;
      }
      if (mode === "history" && historyNoteId === restored.id) {
        historyItems = await api.listNoteVersions(restored.id);
        historySelected = 0;
        renderHistory();
      }
    } catch (error) {
      console.error("恢复历史版本失败", error);
      showToast("恢复失败");
    } finally {
      busy = false;
    }
  }

  function createCard(view: CardView, index: number): HTMLElement {
    const card = document.createElement("article");
    card.className = "xm-card";
    card.dataset.kind = view.note.kind;
    card.dataset.color = view.note.color;
    card.dataset.id = view.note.id;
    card.dataset.index = String(index);
    card.tabIndex = 0;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", "false");

    const head = document.createElement("div");
    head.className = "xm-card__head";

    const title = document.createElement("span");
    title.className = "xm-card__title";
    title.innerHTML = highlight(view.title, keyword());

    head.appendChild(title);

    if (view.reminder) {
      const remind = document.createElement("span");
      remind.className = "xm-card__remind";
      remind.textContent = view.reminder;
      head.appendChild(remind);
    }

    const badge = document.createElement("span");
    badge.className = "xm-card__badge";
    badge.textContent = view.note.kind === "todo" ? "待办" : view.note.kind === "vault" ? "随身笔记" : "备忘";
    head.appendChild(badge);

    // 随身笔记卡片：最多列 3 条“名字 · ••••”，剩下的只说还有几条（绝不显示内容）
    let vault: HTMLElement | null = null;
    if (view.note.kind === "vault") {
      const box = document.createElement("div");
      box.className = "xm-card__vault";
      const { rows, more } = vaultCardRows(view.note.items ?? []);
      rows.forEach((item) => {
        const row = document.createElement("div");
        row.className = "xm-card__vault-row";
        const name = document.createElement("b");
        name.textContent = item.label.trim() || "（未命名）";
        const value = document.createElement("span");
        value.className = "xm-card__vault-value";
        value.dataset.masked = "1";
        value.textContent = " · " + maskSecret(item.value, false);
        row.append(name, value);
        box.appendChild(row);
      });
      if (more > 0) {
        const moreEl = document.createElement("div");
        moreEl.className = "xm-card__vault-more";
        moreEl.textContent = "还有 " + more + " 条";
        box.appendChild(moreEl);
      }
      vault = box;
    }

    const text = document.createElement("p");
    text.className = "xm-card__text";
    text.innerHTML = highlight(view.summary, keyword());

    const foot = document.createElement("div");
    foot.className = "xm-card__foot";

    const time = document.createElement("span");
    time.className = "xm-card__time";
    time.textContent = relativeTime(view.note.updated_at);

    const todos = document.createElement("span");
    todos.className = "xm-card__todos";
    todos.textContent = view.progress;

    foot.append(time, todos);
    if (vault) card.append(head, vault, foot);
    else card.append(head, text, foot);
    return card;
  }

  function applySelection(): void {
    const cards = listEl.querySelectorAll<HTMLElement>(".xm-card");
    cards.forEach((card, index) => {
      const on = index === selected;
      card.dataset.selected = on ? "1" : "0";
      card.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (selected >= 0) cards[selected]?.scrollIntoView({ block: "nearest" });
  }

  function applyTrashSelection(): void {
    const rows = listEl.querySelectorAll<HTMLElement>(".xm-trash__row");
    rows.forEach((row, index) => {
      const on = index === trashSelected;
      row.dataset.selected = on ? "1" : "0";
      row.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (trashSelected >= 0) rows[trashSelected]?.scrollIntoView({ block: "nearest" });
  }

  function moveSelection(delta: number): void {
    if (views.length === 0) return;
    if (selected < 0) selected = 0;
    else selected = (selected + delta + views.length) % views.length;
    applySelection();
  }

  function moveTrashSelection(delta: number): void {
    if (trashItems.length === 0) return;
    if (trashSelected < 0) trashSelected = 0;
    else trashSelected = (trashSelected + delta + trashItems.length) % trashItems.length;
    applyTrashSelection();
  }

  // ---------- 视图切换 ----------
  function setMode(next: "list" | "trash"): void {
    if (mode === next) return;
    closeVersionDetail();
    cancelDeleteArm();
    emptyArmed = false;
    window.clearTimeout(emptyTimer);
    // 从修改记录切去别处：先把搜索框/操作按钮还回来
    if (mode === "history") {
      historyBar.hidden = true;
      headEl.hidden = false;
      actionsEl.hidden = false;
    }
    mode = next;
    searchEl.value = "";
    searchEl.disabled = next === "trash";
    filtersEl.hidden = next !== "list";
    // 契约 §12.5：列表区换成 .xm-trash（两者互斥，不同时渲染）
    listEl.className = next === "trash" ? "xm-trash" : "xm-panel__list";
    listEl.setAttribute("aria-label", next === "trash" ? "回收站" : "便签列表");
    if (next === "trash") {
      trashSelected = -1;
      renderTrash();
    } else {
      renderListNow();
    }
  }

  // ---------- 操作 ----------
  async function loadAll(): Promise<void> {
    const [snapshot, trash] = await Promise.all([api.getSnapshot(), api.listTrash()]);
    notes = snapshot.notes
      .filter((n) => !n.hidden)
      .map((note) => ({ ...note, items: note.items ?? [], reveal: !!note.reveal }));
    trashItems = trash;
    updateTrashBadge();
    // 修改记录开着时，标题可能因为别处改名而变；同步一下小字
    if (mode === "history" && historyNoteId) {
      const target = notes.find((note) => note.id === historyNoteId);
      if (target) {
        historyNoteEl.textContent = toView(target).title;
        historyNoteEl.title = historyNoteEl.textContent;
      }
    }
    render();
  }

  /** 面板隐藏期间出过任何异常，回来时都要能继续点：统一清掉锁标志 */
  function resetBusyFlags(): void {
    creating = false;
    memoBtn.disabled = false;
    todoBtn.disabled = false;
    vaultBtn.disabled = false;
    clipboardBtn.disabled = false;
    busy = false;
  }

  /** 把错误压成一句话（最多 30 字），别把后端完整错误原样铺给小白用户 */
  function errorBrief(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? "");
    const text = raw.replace(/\s+/g, " ").trim();
    if (/权限|拒绝|denied|access|permission/i.test(text)) {
      return "写不进数据目录，检查磁盘空间或杀毒软件";
    }
    if (!text) return "再试一次";
    return text.length > 30 ? text.slice(0, 30) + "…" : text;
  }

  async function openNote(id: string): Promise<void> {
    try {
      await api.openNoteWindow(id);
      await hideCurrent();
    } catch (error) {
      console.error("打开便签失败", error);
      showToast("打不开这张便签");
    }
  }

  async function createNote(kind: "memo" | "todo" | "vault"): Promise<void> {
    if (creating) return;
    creating = true;
    memoBtn.disabled = true;
    todoBtn.disabled = true;
    vaultBtn.disabled = true;
    try {
      await api.createNote(kind);
      await hideCurrent();
    } catch (error) {
      console.error("新建便签失败", error);
      // 用户 m02425：加了没反应也没提示 —— 失败必须说出来，并给可操作的下一步
      showToast("新建失败：" + errorBrief(error), 3200);
    } finally {
      // 关键：面板只是 hide（页面不重载），成功路径也必须复位，否则下次打开按钮永远 disabled
      resetBusyFlags();
    }
  }

  /** 从剪贴板新建备忘（契约 §13.6）：整段文字进正文，最多 8000 字 */
  async function createFromClipboard(): Promise<void> {
    if (creating) return;
    creating = true;
    clipboardBtn.disabled = true;
    let raw = "";
    try {
      raw = await navigator.clipboard.readText();
    } catch (error) {
      console.error("读剪贴板失败", error);
      // 浏览器没授权 / 剪贴板被占用时 readText 会直接抛错。统一说"空"：
      // 用户能做的动作是一样的——先复制一段文字再点粘贴。
      showToast("剪贴板是空的");
      resetBusyFlags();
      return;
    }

    const text = raw.replace(/\r\n/g, "\n").trim();
    if (!text) {
      showToast("剪贴板是空的");
      resetBusyFlags();
      return;
    }

    const clipped = text.slice(0, 8000);
    let createdId = "";
    let savedOk = false;

    try {
      const note = await api.createNote("memo");
      createdId = note.id;
      await api.saveNote({ ...note, content: clipped, updated_at: Date.now() });
      savedOk = true;
      // 后端 create_note 已经建好窗口（此时多半还没加载完），这里只是确保它浮到前面
      await api.openNoteWindow(note.id);
      await hideCurrent();
    } catch (error) {
      console.error("从剪贴板新建失败", error);
      // 先建后存失败会留下空纸：把刚建的便签删掉（已经存成功就别删，文字还在里面）
      if (createdId && !savedOk) {
        try {
          await api.deleteNote(createdId);
        } catch (cleanupError) {
          console.error("清理剪贴板空便签失败", cleanupError);
        }
      }
      showToast("新建失败：" + errorBrief(error), 3200);
    } finally {
      resetBusyFlags();
    }
  }

  // ---------- 删除 / 撤销 ----------
  function cancelDeleteArm(): void {
    deleteArmId = "";
    window.clearTimeout(deleteArmTimer);
  }

  /** 面板里按 Delete：第一次只提醒，第二次才真删（不用系统 confirm） */
  function armDelete(noteId: string): void {
    if (deleteArmId === noteId) {
      cancelDeleteArm();
      void deleteFromPanel(noteId);
      return;
    }
    cancelDeleteArm();
    deleteArmId = noteId;
    deleteArmTimer = window.setTimeout(() => {
      deleteArmId = "";
    }, 2600);
    showToast("再按一次删除", 2600);
  }

  async function deleteFromPanel(noteId: string): Promise<void> {
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;
    try {
      // 和便签窗口一致：先留撤销记录，再删（删除后便签窗口会关，撤销入口在面板）
      publishUndo(note);
      await api.deleteNote(noteId);
      const pending = readUndo();
      await loadAll();
      if (pending && pending.noteId === noteId) showUndoToast(pending);
    } catch (error) {
      console.error("删除便签失败", error);
      showToast("删除失败");
    }
  }

  async function undoDelete(): Promise<void> {
    const pending = undoPending;
    if (!pending || busy) return;
    busy = true;
    try {
      const id = pending.noteId;
      clearUndo(id);
      hideUndoToast();
      await api.restoreNote(id);
      await api.openNoteWindow(id);
      await hideCurrent();
    } catch (error) {
      console.error("撤销删除失败", error);
      showToast("恢复失败");
    } finally {
      busy = false;
    }
  }

  function checkPendingUndo(): void {
    const pending = readUndo();
    if (!pending) return;
    if (pending.noteId === undoShownFor) return;
    showUndoToast(pending);
  }

  // ---------- 回收站操作 ----------
  async function restoreItem(id: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await api.restoreNote(id);
      showToast("已恢复");
      await loadAll();
    } catch (error) {
      console.error("恢复便签失败", error);
      showToast("恢复失败");
    } finally {
      busy = false;
    }
  }

  async function emptyTrash(): Promise<void> {
    if (busy || trashItems.length === 0) return;
    if (!emptyArmed) {
      // 第一次点：按钮文案变成“确认清空？”，3 秒内再点一次才真清空
      emptyArmed = true;
      window.clearTimeout(emptyTimer);
      emptyTimer = window.setTimeout(() => {
        emptyArmed = false;
        if (mode === "trash") renderTrash();
      }, 3000);
      renderTrash();
      return;
    }
    emptyArmed = false;
    window.clearTimeout(emptyTimer);
    busy = true;
    try {
      await api.emptyTrash();
      showToast("回收站已清空");
      await loadAll();
    } catch (error) {
      console.error("清空回收站失败", error);
      showToast("清空失败");
    } finally {
      busy = false;
    }
  }

  // ---------- 事件 ----------
  listEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (mode === "history") {
      const restore = target.closest<HTMLElement>('[data-act="restore-version"]');
      if (restore?.dataset.ts) {
        void restoreVersion(Number(restore.dataset.ts));
        return;
      }
      const row = target.closest<HTMLElement>(".xm-history__card");
      if (row) {
        const index = Number(row.dataset.index);
        if (Number.isFinite(index)) {
          historySelected = index;
          applyHistorySelection();
          const version = historyItems[index];
          if (version) void openVersionDetail(version);
        }
      }
      return;
    }
    if (mode === "trash") {
      const restore = target.closest<HTMLElement>('[data-act="restore"]');
      if (restore?.dataset.id) {
        void restoreItem(restore.dataset.id);
        return;
      }
      const emptyBtn = target.closest<HTMLElement>('[data-act="empty"]');
      if (emptyBtn) {
        void emptyTrash();
        return;
      }
      if (target.closest('[data-act="back"]')) {
        setMode("list");
        return;
      }
      const row = target.closest<HTMLElement>(".xm-trash__row");
      if (row) {
        const index = Number(row.dataset.index);
        if (Number.isFinite(index)) {
          trashSelected = index;
          applyTrashSelection();
        }
      }
      return;
    }

    if (target.closest('[data-act="filters-clear"]')) {
      clearFilters();
      return;
    }
    const card = target.closest<HTMLElement>(".xm-card");
    if (!card?.dataset.id) return;
    const index = Number(card.dataset.index);
    if (Number.isFinite(index)) {
      selected = index;
      applySelection();
    }
    void openNote(card.dataset.id);
  });

  listEl.addEventListener("pointermove", (event) => {
    const target = event.target as HTMLElement;
    if (mode === "history") {
      const row = target.closest<HTMLElement>(".xm-history__card");
      if (!row) return;
      const index = Number(row.dataset.index);
      if (Number.isFinite(index) && index !== historySelected) {
        historySelected = index;
        applyHistorySelection();
      }
      return;
    }
    if (mode === "trash") {
      const row = target.closest<HTMLElement>(".xm-trash__row");
      if (!row) return;
      const index = Number(row.dataset.index);
      if (Number.isFinite(index) && index !== trashSelected) {
        trashSelected = index;
        applyTrashSelection();
      }
      return;
    }
    const card = target.closest<HTMLElement>(".xm-card");
    if (!card) return;
    const index = Number(card.dataset.index);
    if (Number.isFinite(index) && index !== selected) {
      selected = index;
      applySelection();
    }
  });

  searchEl.addEventListener("input", () => {
    if (mode !== "list") return;
    selected = -1;
    // 清空（含全选删除）要立刻恢复全部，别等防抖
    if (keyword() === "") renderListNow();
    else renderSearchSoon();
  });

  filtersEl.addEventListener("click", (event) => {
    if (mode !== "list") return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-act="filters-clear"]')) {
      clearFilters();
      return;
    }
    const due = target.closest<HTMLElement>("[data-due]");
    if (due?.dataset.due) {
      filterDue = due.dataset.due as DueFilter;
      renderListNow();
      return;
    }
    const kind = target.closest<HTMLElement>("[data-kind]");
    if (kind?.dataset.kind) {
      filterKind = kind.dataset.kind as KindFilter;
      renderListNow();
      return;
    }
    const color = target.closest<HTMLElement>("[data-color]");
    if (color?.dataset.color) {
      filterColor = color.dataset.color as ColorFilter;
      renderListNow();
    }
  });

  memoBtn.addEventListener("click", () => void createNote("memo"));
  clipboardBtn.addEventListener("click", () => void createFromClipboard());
  todoBtn.addEventListener("click", () => void createNote("todo"));
  vaultBtn.addEventListener("click", () => void createNote("vault"));
  trashBtn.addEventListener("click", () => setMode(mode === "trash" ? "list" : "trash"));
  settingsBtn.addEventListener("click", () => {
    void (async () => {
      try {
        await api.openSettings();
        await hideCurrent();
      } catch (error) {
        console.error("打开设置失败", error);
      }
    })();
  });

  historyBar.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest('[data-act="history-back"]')) leaveHistory();
  });

  // 版本详情层：返回 / 恢复这一版（详情在列表外，单独监听）
  versionEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-act="version-close"]')) {
      closeVersionDetail();
      return;
    }
    const modeBtn = target.closest<HTMLElement>("[data-diff-mode]");
    if (modeBtn) {
      const next = modeBtn.dataset.diffMode;
      if (next === "diff" || next === "full") switchVersionMode(next);
      return;
    }
    const restore = target.closest<HTMLElement>('[data-act="restore-version"]');
    if (restore?.dataset.ts) void restoreVersion(Number(restore.dataset.ts));
  });

  toastEl.addEventListener("click", () => {
    if (undoPending) void undoDelete();
  });

  document.addEventListener("keydown", (event) => {
    const inSearch = document.activeElement === searchEl;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      if (mode !== "list") return;
      event.preventDefault();
      searchEl.focus();
      searchEl.select();
      return;
    }
    if (event.key === "Escape") {
      if (!versionEl.hidden) {
        event.preventDefault();
        closeVersionDetail();
        return;
      }
      if (mode === "history") {
        event.preventDefault();
        leaveHistory();
        return;
      }
      if (mode === "trash") {
        event.preventDefault();
        setMode("list");
        return;
      }
      if (searchEl.value) {
        searchEl.value = "";
        renderListNow();
        return;
      }
      if (filtersActive()) {
        event.preventDefault();
        clearFilters();
        return;
      }
      void hideCurrent();
      return;
    }
    if (mode === "history") {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveHistorySelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveHistorySelection(-1);
        return;
      }
      if (event.key === "Enter") {
        const active = document.activeElement as HTMLElement | null;
        const version = historyItems[historySelected];
        if (version && !active?.closest("button")) {
          event.preventDefault();
          void restoreVersion(version.ts);
        }
        return;
      }
      return;
    }
    if (mode === "trash") {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveTrashSelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveTrashSelection(-1);
        return;
      }
      if (event.key === "Enter") {
        const item = trashItems[trashSelected];
        if (item && document.activeElement === document.body) {
          event.preventDefault();
          void restoreItem(item.id);
        }
        return;
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "Delete") {
      const view = views[selected];
      if (view) {
        event.preventDefault();
        armDelete(view.note.id);
      }
      return;
    }
    if (event.key === "Enter") {
      if (inSearch || document.activeElement === document.body) {
        const view = views[selected];
        if (view) {
          event.preventDefault();
          void openNote(view.note.id);
        }
      }
    }
  });

  // 数据变化：面板可见时刷新（防抖，避免连续保存时闪）
  const reloadSoon = debounce(() => {
    if (document.hidden) return;
    void (async () => {
      try {
        await loadAll();
        checkPendingUndo();
      } catch (error) {
        console.error("刷新面板失败", error);
      }
    })();
  }, 120);
  void subscribe("notes-changed", () => reloadSoon());

  // 面板正开着时，删除动作会通过 BroadcastChannel 加速送达；localStorage 是兜底
  const unsubscribeUndo = subscribeUndo((pending) => {
    if (pending.noteId === undoShownFor) return;
    if (Date.now() - pending.deletedAt > UNDO_TTL) return;
    showUndoToast(pending);
  });

  // 从隐藏切回可见时补一次刷新（隐藏期间事件可能收不到）
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      // 面板从隐藏变可见：先解锁，再做一次完整刷新（避免异常路径留下卡死状态）
      resetBusyFlags();
      reloadSoon.cancel();
      void loadAll().then(checkPendingUndo);
    }
  });
  window.addEventListener("focus", () => {
    resetBusyFlags();
    reloadSoon();
  });

  // 后端每次把面板叫到前台都会派发这个事件：无论上一刻停在修改记录、回收站还是
  // 半截搜索里，都回到便签列表，别让用户以为"面板打不开"。
  window.addEventListener("xm-panel-open", () => {
    resetBusyFlags();
    // 便签刚点「修改记录」：localStorage 里有一条 3 秒内的请求。
    // openPanel 的事件先到、广播后到；这里不能把视图重置回列表，
    // 否则用户看到的就是「面板一闪又回列表」（task-28 A）。
    if (peekHistoryRequest()) return;
    if (mode === "history") leaveHistory();
    else if (mode === "trash") setMode("list");
    reloadSoon();
  });

  // 面板常驻时，便签菜单点「修改记录」就是通过这个通道通知的
  const historyChannel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(HISTORY_CHANNEL) : null;
  if (historyChannel) {
    historyChannel.onmessage = (event: MessageEvent<{ noteId?: unknown }>) => {
      const noteId = event.data?.noteId;
      if (typeof noteId === "string") void openHistory(noteId);
    };
  }

  // 离开页面时断开广播通道（浏览器 mock 多标签页调试时别留下悬挂连接）
  window.addEventListener("beforeunload", () => {
    unsubscribeUndo();
    historyChannel?.close();
  });

  // ---------- 启动 ----------
  await loadAll();
  checkPendingUndo();
  // 浏览器 mock：便签页点「修改记录」后整页跳到面板，广播消息会错过，用 localStorage 请求补上
  const requestedHistory = readHistoryRequest();
  if (requestedHistory) void openHistory(requestedHistory);
  else searchEl.focus();
}
