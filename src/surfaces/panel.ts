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
import { NOTE_COLORS, colorLabel } from "../shared/colors";
import type { NoteColor } from "../shared/colors";
import { hideCurrent } from "../shared/window";
import { copyText } from "../shared/clipboard";
import {
  clockTime,
  fromDateTimeLocalValue,
  relativeTime,
  reminderLabel,
  repeatLabel,
  toDateTimeLocalValue,
  todoProgress,
} from "../shared/format";
import { mdToPlain } from "../shared/markdown";
import { imageNames, imageUrl, replaceImageLines } from "../shared/images";
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
    '<div class="xm-panel__actions" data-more="0" data-open="0" data-on="0">' +
    '<button class="xm-btn xm-btn--primary" type="button" data-act="new-memo">' + icons.plus + " 备忘</button>" +
    '<button class="xm-btn xm-btn--primary" type="button" data-act="new-todo">' + icons.plus + " 待办</button>" +
    // 「更多」：次要动作收进第二行，默认收起（task-50），点一下展开；收起时把回收站条数挪到这颗按钮上
    '<button class="xm-btn xm-btn--ghost xm-more" type="button" data-act="more" aria-expanded="false" aria-controls="xm-panel-more" title="更多操作">' +
    icons.more + '<span class="xm-more__text">更多</span></button>' +
    // 「筛选」开关挪到第一行最右（task-53）：和「更多」同一行右对齐，不再单独占一行显得突兀
    '<div class="xm-filters__bar">' +
    // 只有 due/kind/color 真的在筛选时才出现（task-48：文案从「清除」改成「重置筛选」，只清筛选、不动搜索框）
    '<button class="xm-filters__clear" type="button" data-act="filters-clear" hidden>重置筛选</button>' +
    '<button class="xm-chip xm-filters__toggle" type="button" data-act="filters-toggle" aria-expanded="false" aria-controls="xm-panel-filters" title="展开筛选">' +
    icons.expand + '<span class="xm-filters__toggle-text">筛选</span></button>' +
    "</div>" +
    '<div class="xm-panel__more" id="xm-panel-more" inert>' +
    '<button class="xm-btn" type="button" data-act="new-vault" title="新建随身笔记（名字 + 内容，点一下复制）">' +
    icons.plus + " 随身笔记</button>" +
    '<button class="xm-btn" type="button" data-act="from-clipboard" ' +
    'title="把剪贴板里的文字变成一条备忘" aria-label="从剪贴板新建备忘">' + icons.clipboard + " 粘贴</button>" +
    // 多选（task-48）：点一下进入批量模式，卡片左侧出现勾选圆点
    '<button class="xm-btn xm-btn--icon" type="button" data-act="select" title="多选" aria-label="多选" aria-pressed="false">' + icons.select + "</button>" +
    '<button class="xm-btn xm-btn--icon" type="button" data-act="trash" title="回收站" aria-label="回收站">' + icons.trash + "</button>" +
    '<button class="xm-btn xm-btn--icon" type="button" data-act="settings" title="设置" aria-label="设置">' + icons.gear + "</button>" +
    "</div>" +
    '<div class="xm-filters" id="xm-panel-filters" role="group" aria-label="筛选便签">' +
    '<div class="xm-filters__body" inert>' +
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
    "</div>" +
    "</div>" +
    "</div>" +
    '<div class="xm-panel__list" role="listbox" aria-label="便签列表"></div>' +
    // 多选批量条（task-48）：选中 ≥1 张时浮在列表和脚注之间；不显示时整条收起
    '<div class="xm-selbar" hidden>' +
    '<div class="xm-selbar__row">' +
    '<span class="xm-selbar__count">已选 0 张</span>' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-act="sel-exit">退出多选</button>' +
    "</div>" +
    '<div class="xm-selbar__row">' +
    '<button class="xm-btn" type="button" data-act="sel-pin" title="把选中的便签置顶">' + icons.pin + " 置顶</button>" +
    '<button class="xm-btn" type="button" data-act="sel-unpin" title="取消选中便签的置顶">取消置顶</button>' +
    '<div class="xm-selbar__colors" role="group" aria-label="批量改颜色">' +
    NOTE_COLORS.map((color) =>
      '<button class="xm-color-dot" type="button" data-color="' + color.key + '" data-sel-color="' + color.key +
      '" title="' + color.label + '" aria-label="改成' + color.label + '"></button>',
    ).join("") +
    "</div>" +
    '<button class="xm-btn xm-selbar__del" type="button" data-act="sel-delete" title="删到回收站（5 秒内可撤销）">' + icons.trash + " 删除</button>" +
    "</div>" +
    "</div>" +
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
    // 卡片右键菜单（task-48）：和便签菜单同一套纸感弹层 .xm-pop；fixed 定位跟着光标走
    '<div class="xm-pop xm-pop--menu xm-ctx" role="menu" hidden>' +
    '<button class="xm-pop__item" type="button" role="menuitem" data-ctx-act="open">打开</button>' +
    '<button class="xm-pop__item" type="button" role="menuitem" data-ctx-act="pin">置顶</button>' +
    '<div class="xm-pop__sep"></div>' +
    '<div class="xm-pop__label">改颜色</div>' +
    '<div class="xm-colors xm-ctx__colors" role="group" aria-label="改颜色">' +
    NOTE_COLORS.map((color) =>
      '<button class="xm-color-dot" type="button" data-color="' + color.key + '" data-ctx-color="' + color.key +
      '" title="' + color.label + '" aria-label="改成' + color.label + '"></button>',
    ).join("") +
    "</div>" +
    '<div class="xm-pop__sep"></div>' +
    '<button class="xm-pop__item" type="button" role="menuitem" data-ctx-act="copy">复制正文</button>' +
    '<button class="xm-pop__item" type="button" role="menuitem" data-ctx-act="remind">设置提醒</button>' +
    '<div class="xm-pop__sep"></div>' +
    '<button class="xm-pop__item" type="button" role="menuitem" data-ctx-act="delete">删除</button>' +
    '<button class="xm-pop__item" type="button" role="menuitem" data-ctx-act="export">导出 Markdown</button>' +
    "</div>" +
    // 设置提醒弹层（右键菜单「设置提醒」打开）：快选 + 自定义时间
    '<div class="xm-pop xm-pop--remind xm-remind" hidden>' +
    '<div class="xm-pop__label">提醒我</div>' +
    '<div class="xm-pop__quick">' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-remind-quick="10">10 分钟后</button>' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-remind-quick="60">1 小时后</button>' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-remind-quick="tomorrow">明天 9:00</button>' +
    "</div>" +
    '<div class="xm-pop__row"><input class="xm-field" type="datetime-local" aria-label="提醒时间" /></div>' +
    '<div class="xm-pop__row">' +
    '<button class="xm-btn xm-btn--primary" type="button" data-remind-act="set">设置提醒</button>' +
    '<button class="xm-btn" type="button" data-remind-act="clear">清除</button>' +
    "</div>" +
    "</div>" +
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
  // 「更多」折叠组（task-50）：次要动作默认收起，回收站条数挪到这颗按钮上当角标
  const moreBtn = body.querySelector<HTMLButtonElement>('[data-act="more"]')!;
  const morePanel = body.querySelector<HTMLElement>(".xm-panel__more")!;
  const toastEl = body.querySelector<HTMLElement>(".xm-toast")!;
  // 多选 / 批量条 / 右键菜单 / 提醒弹层（task-48）
  const selectBtn = body.querySelector<HTMLButtonElement>('[data-act="select"]')!;
  // 筛选开关现在挂在工具条第一行最右（task-53），所以从 actionsEl 里找，不再从 filtersEl 找
  const filtersClearBtn = actionsEl.querySelector<HTMLButtonElement>('[data-act="filters-clear"]')!;
  const filtersToggleBtn = actionsEl.querySelector<HTMLButtonElement>('[data-act="filters-toggle"]')!;
  const filtersBody = filtersEl.querySelector<HTMLElement>(".xm-filters__body")!;
  const selbarEl = body.querySelector<HTMLElement>(".xm-selbar")!;
  const selCountEl = selbarEl.querySelector<HTMLElement>(".xm-selbar__count")!;
  const ctxEl = body.querySelector<HTMLElement>(".xm-ctx")!;
  const ctxPinItem = ctxEl.querySelector<HTMLElement>('[data-ctx-act="pin"]')!;
  const ctxOpenItem = ctxEl.querySelector<HTMLElement>('[data-ctx-act="open"]')!;
  const ctxRemindItem = ctxEl.querySelector<HTMLElement>('[data-ctx-act="remind"]')!;
  const ctxColorsEl = ctxEl.querySelector<HTMLElement>(".xm-ctx__colors")!;
  const remindEl = body.querySelector<HTMLElement>(".xm-remind")!;
  const remindField = remindEl.querySelector<HTMLInputElement>(".xm-field")!;
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

  // ---------- 多选 / 批量操作（task-48）----------
  /** 是否处于多选模式（卡片点击变成勾选） */
  let multi = false;
  /** 已勾选的便签 id：卡片是重建的，状态只认 id */
  const picked = new Set<string>();
  /** Shift 连选的锚点（列表下标） */
  let pickAnchor = -1;
  /** 批量删除后的撤销（多张用面板自己的，单张仍走 undo.ts 的跨窗口撤销） */
  let batchUndo: { ids: string[]; timer: number } | null = null;

  // ---------- 右键菜单 / 提醒弹层（task-48）----------
  /** 右键菜单当前作用的便签 id（多选时是整个选中集合） */
  let ctxIds: string[] = [];
  /** 提醒弹层当前编辑的便签 */
  let remindId = "";
  /** 弹层锚点：右键光标位置，提醒弹层从菜单打开时沿用 */
  let popX = 0;
  let popY = 0;

  // ---------- 数据 -> 视图 ----------
  function toView(note: Note): CardView {
    // 待办卡只展示前 2 条 + “还有 N 项”，剩下的数量交给右下角进度（2/5）
    const shownTodos = note.todos.slice(0, 2).map((t) => (t.done ? "✓ " : "") + t.text);
    let todoText = shownTodos.join(" · ");
    const restTodos = note.todos.length - shownTodos.length;
    if (restTodos > 0) todoText += "（还有 " + restTodos + " 项）";
    // memo 正文先去掉 Markdown 标记再上卡片：卡片是摘要，不该出现 # 和 **
    // 图片 token（xmimg:...）单独走缩略图，不能算进摘要文字
    const plain = note.kind === "memo" ? mdToPlain(replaceImageLines(note.content, "")) : note.content;
    const imageCount = note.kind === "memo" ? imageNames(note.content).length : 0;
    // 随身笔记的卡片正文单独渲染（名字 + 打码），这里不放内容
    const bodyText = note.kind === "todo" ? todoText : note.kind === "vault" ? "" : plain.replace(/\s+/g, " ").trim();
    const firstLine = plain.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
    const empty =
      note.kind === "vault"
        ? !note.title.trim() && (note.items ?? []).length === 0
        : note.title.trim() === "" && bodyText === "" && imageCount === 0;
    const title =
      note.kind === "vault"
        ? note.title.trim() || vaultTitle(note)
        : note.title.trim() || firstLine || (imageCount > 0 ? "（图片）" : empty ? "（空便签）" : "无标题");
    return {
      note,
      title,
      // 只有图片没有文字时，摘要位放一句「（图片）」，别让卡片空成一条
      summary: empty ? "" : bodyText || (imageCount > 0 ? "（图片）" : ""),
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
    // 搜索不看图片 token（否则搜 "xmimg" 会把所有带图的便签都命中）
    const content = note.kind === "memo" ? replaceImageLines(note.content, "") : note.content;
    return [note.title, content, ...note.todos.map((t) => t.text)].some((text) => textMatches(text, key));
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
    // 普通 toast 会顶掉批量撤销，撤销机会就作废了
    clearBatchUndo();
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
    clearBatchUndo();
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
    clearBatchUndo();
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

  // ---------- 折叠区（task-50）----------
  /** 折叠状态记在本机，下次打开面板保持你上次的样子 */
  const MORE_KEY = "xm.panel.more";
  const FILTERS_KEY = "xm.panel.filters";
  function readFlag(key: string): boolean {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }
  function writeFlag(key: string, on: boolean): void {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* 隐私模式下写不了也无所谓，只是不记住 */
    }
  }

  let trashCount = 0;
  /** 回收站条数：展开时挂在回收站按钮上，收起时挪到「更多」按钮上（不重复显示） */
  function syncMoreBadge(): void {
    const collapsed = actionsEl.dataset.more !== "1";
    if (collapsed && trashCount > 0) moreBtn.dataset.count = trashCount > 99 ? "99+" : String(trashCount);
    else delete moreBtn.dataset.count;
  }
  /** 「更多」按钮的提示语：收起时把回收站条数带出来，否则收起后看不到那个数字 */
  function syncMoreTitle(): void {
    const open = actionsEl.dataset.more === "1";
    const base = open ? "收起更多操作" : "更多操作";
    moreBtn.title = trashCount > 0 ? base + " · 回收站 " + trashCount + " 条" : base;
  }

  function setMoreOpen(open: boolean, remember = true): void {
    actionsEl.dataset.more = open ? "1" : "0";
    moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    moreBtn.classList.toggle("xm-more--open", open);
    // 收起时把里面的按钮移出可聚焦序列，键盘 Tab 不会跳进看不见的控件
    if (open) morePanel.removeAttribute("inert");
    else morePanel.setAttribute("inert", "");
    syncMoreBadge();
    syncMoreTitle();
    if (remember) writeFlag(MORE_KEY, open);
  }

  function setFiltersOpen(open: boolean, remember = true): void {
    // 展开状态挂在工具条容器上：开关在第一行，芯片行在它下面，两者共用一个状态
    actionsEl.dataset.open = open ? "1" : "0";
    filtersToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    filtersToggleBtn.title = open ? "收起筛选" : "展开筛选";
    if (open) filtersBody.removeAttribute("inert");
    else filtersBody.setAttribute("inert", "");
    if (remember) writeFlag(FILTERS_KEY, open);
  }

  // ---------- 渲染 ----------
  function updateTrashBadge(): void {
    const count = trashItems.length;
    trashCount = count;
    // 角标不只挂在回收站按钮上：收起时「更多」按钮也要显示同一个数字
    syncMoreBadge();
    syncMoreTitle();
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
    actionsEl.dataset.on = filtersActive() ? "1" : "0";
    // 「筛选」开关上的角标 = 启用了几项筛选，收起时也能一眼看出自己筛过东西
    const activeFilters =
      (filterDue === "all" ? 0 : 1) + (filterKind === "all" ? 0 : 1) + (filterColor === "all" ? 0 : 1);
    if (activeFilters > 0) filtersToggleBtn.dataset.count = String(activeFilters);
    else delete filtersToggleBtn.dataset.count;
    // 「重置筛选」只在真的筛过东西时出现，而且只清三个筛选芯片，不动搜索框（task-48）
    filtersClearBtn.hidden = !filtersActive();
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
    views = sortNotes(notes)
      .filter((note) => matches(note, key) && matchesFilters(note))
      .map(toView);
    // 过滤掉不再可见的勾选：批量操作只该作用于眼前这些卡
    const visible = new Set(views.map((view) => view.note.id));
    for (const id of Array.from(picked)) {
      if (!visible.has(id)) picked.delete(id);
    }
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
      applyPicked();
      syncSelbar();
      updateFoot(footCountText());
      return;
    }

    views.forEach((view, index) => {
      listEl.appendChild(createCard(view, index));
    });
    selected = Math.min(selected < 0 ? 0 : selected, views.length - 1);
    applySelection();
    applyPicked();
    syncFilterBar();
    updateFilterBadges();
    syncSelbar();
    updateFoot(footCountText());
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
          : multi
            ? "点卡片勾选 · Shift 连选 · Ctrl+A 全选 · Esc 退出"
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
    // 进修改记录就退出多选、收起弹层（task-48 互斥要求）
    if (multi) exitMulti(false);
    closePops();
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
    card.dataset.pick = "0";

    // 多选圆点：只有多选模式才显示（data-multi 在列表容器上），勾选态由 data-pick 驱动
    const pick = document.createElement("span");
    pick.className = "xm-card__pick";
    pick.setAttribute("aria-hidden", "true");
    pick.innerHTML = icons.check;

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

    // 照片缩略图：最多 3 张，多出来的折成 +N（契约 §5.2）
    let thumbs: HTMLElement | null = null;
    if (view.note.kind === "memo") {
      const names = imageNames(view.note.content);
      if (names.length > 0) {
        const strip = document.createElement("div");
        strip.className = "xm-card__thumbs";
        names.slice(0, 3).forEach((name) => {
          const img = document.createElement("img");
          img.className = "xm-card__thumb";
          img.src = imageUrl(name);
          img.alt = "";
          img.loading = "lazy";
          img.draggable = false;
          strip.appendChild(img);
        });
        if (names.length > 3) strip.dataset.extra = String(names.length - 3);
        else strip.dataset.count = String(names.length);
        thumbs = strip;
      }
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
    if (vault) card.append(pick, head, vault, foot);
    else if (thumbs) card.append(pick, head, thumbs, text, foot);
    else card.append(pick, head, text, foot);
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


  // ---------- 多选（task-48）----------
  // 状态：multi 开关 + picked 集合 + pickAnchor（Shift 连选锚点）。
  // 卡片是每次 render 重建的，勾子/批量条统一在渲染后刷一遍，状态只认 id 集合。

  /** 当前列表里已勾选的 id（顺序跟着列表顺序，批量操作好读） */
  function pickedIds(): string[] {
    return views.filter((view) => picked.has(view.note.id)).map((view) => view.note.id);
  }

  function pickedCount(): number {
    return views.reduce((sum, view) => (picked.has(view.note.id) ? sum + 1 : sum), 0);
  }

  function footCountText(): string {
    return keyword() || filtersActive() ? views.length + " / " + notes.length : notes.length + " 张";
  }

  /** 批量条：有选中才出现，数量和按钮可用状态一起刷 */
  function syncSelbar(): void {
    const count = pickedCount();
    if (multi && count > 0) {
      selbarEl.hidden = false;
      selCountEl.textContent = "已选 " + count + " 张";
    } else {
      selbarEl.hidden = true;
    }
    selectBtn.dataset.active = multi ? "1" : "0";
    selectBtn.setAttribute("aria-pressed", multi ? "true" : "false");
    selectBtn.title = multi ? "退出多选" : "多选";
  }

  /** 把勾选态写到卡片上（data-pick 驱动纸感圆点 + 勾） */
  function applyPicked(): void {
    listEl.querySelectorAll<HTMLElement>(".xm-card").forEach((card) => {
      const id = card.dataset.id ?? "";
      card.dataset.pick = id && picked.has(id) ? "1" : "0";
    });
  }

  function enterMulti(): void {
    if (mode !== "list" || multi) return;
    cancelDeleteArm();
    multi = true;
    pickAnchor = selected >= 0 ? selected : -1;
    listEl.dataset.multi = "1";
    renderList();
  }

  /** 退出多选：清空勾选、收起批量条；reRender=false 给「马上要换视图」的调用方省一次重排 */
  function exitMulti(reRender = true): void {
    if (!multi) return;
    multi = false;
    picked.clear();
    pickAnchor = -1;
    delete listEl.dataset.multi;
    syncSelbar();
    if (reRender && mode === "list") renderList();
  }

  /** 多选时点卡片：普通点切换、Shift 从锚点连选（追加，不清掉已有勾选） */
  function pickCard(index: number, id: string, shift: boolean): void {
    if (shift && pickAnchor >= 0) {
      const from = Math.min(pickAnchor, index);
      const to = Math.max(pickAnchor, index);
      for (let i = from; i <= to; i += 1) {
        const view = views[i];
        if (view) picked.add(view.note.id);
      }
    } else if (picked.has(id)) {
      picked.delete(id);
      pickAnchor = index;
    } else {
      picked.add(id);
      pickAnchor = index;
    }
    selected = index;
    applySelection();
    applyPicked();
    syncSelbar();
    updateFoot(footCountText());
  }

  // ---------- 批量操作 ----------
  async function pinNotes(ids: string[], pin: boolean): Promise<void> {
    if (busy || ids.length === 0) return;
    busy = true;
    try {
      await Promise.all(ids.map((id) => api.setPinned(id, pin)));
      showToast((pin ? "已置顶 " : "已取消置顶 ") + ids.length + " 张");
      await loadAll();
    } catch (error) {
      console.error("批量置顶失败", error);
      showToast("置顶失败：" + errorBrief(error), 2800);
    } finally {
      busy = false;
    }
  }

  async function colorNotes(ids: string[], color: NoteColor): Promise<void> {
    if (busy || ids.length === 0) return;
    const wanted = new Set(ids);
    const targets = notes.filter((note) => wanted.has(note.id));
    if (targets.length === 0) return;
    busy = true;
    try {
      // 换色走 save_note（后端自己 bump 更新时间）；只改颜色不会记一条修改记录
      await Promise.all(targets.map((note) => api.saveNote({ ...note, color })));
      showToast("已改成" + colorLabel(color) + " · " + targets.length + " 张");
      await loadAll();
    } catch (error) {
      console.error("批量改颜色失败", error);
      showToast("改颜色失败：" + errorBrief(error), 2800);
    } finally {
      busy = false;
    }
  }

  /** 批量删除（进回收站）：多张用面板自己的批量撤销（单张还是走 undo.ts 的跨窗口撤销） */
  async function deleteNotes(ids: string[]): Promise<void> {
    if (busy || ids.length === 0) return;
    busy = true;
    try {
      await Promise.all(ids.map((id) => api.deleteNote(id)));
      ids.forEach((id) => picked.delete(id));
      selected = -1;
      await loadAll();
      startBatchUndo(ids);
    } catch (error) {
      console.error("批量删除失败", error);
      showToast("删除失败：" + errorBrief(error), 2800);
    } finally {
      busy = false;
    }
  }

  // 批量撤销：只活 5 秒，点 toast 恢复。单张删除仍走 undo.ts（便签窗口也能看到那条撤销）
  function startBatchUndo(ids: string[]): void {
    clearBatchUndo();
    batchUndo = {
      ids: ids.slice(),
      timer: window.setTimeout(() => {
        batchUndo = null;
        toastEl.dataset.show = "0";
      }, UNDO_TTL),
    };
    toastEl.textContent = "已删除 " + ids.length + " 张 · 撤销";
    toastEl.dataset.show = "1";
    toastEl.style.pointerEvents = "auto";
    toastEl.style.cursor = "pointer";
    toastEl.title = "点一下把这几张从回收站恢复";
    undoPending = null;
    undoShownFor = "";
    window.clearTimeout(toastTimer);
    window.clearTimeout(undoHideTimer);
  }

  function clearBatchUndo(): void {
    if (!batchUndo) return;
    window.clearTimeout(batchUndo.timer);
    batchUndo = null;
  }

  async function undoBatchDelete(): Promise<void> {
    const pending = batchUndo;
    if (!pending || busy) return;
    const ids = pending.ids.slice();
    busy = true;
    try {
      clearBatchUndo();
      hideUndoToast();
      await Promise.all(ids.map((id) => api.restoreNote(id)));
      showToast("已恢复 " + ids.length + " 张");
      await loadAll();
    } catch (error) {
      console.error("批量撤销失败", error);
      showToast("恢复失败：" + errorBrief(error), 2800);
    } finally {
      busy = false;
    }
  }

  // ---------- 右键菜单 / 提醒弹层（task-48）----------
  function closeCtx(): void {
    ctxEl.hidden = true;
  }

  function closeRemind(): void {
    remindEl.hidden = true;
    remindId = "";
  }

  function closePops(): void {
    closeCtx();
    closeRemind();
  }

  /** 弹层 fixed 定位：先摆出来量尺寸，再按视口夹紧（留 8px 边距，贴边不裁切） */
  function placePop(el: HTMLElement, x: number, y: number): void {
    el.hidden = false;
    el.style.left = "0px";
    el.style.top = "0px";
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }

  function openCtx(x: number, y: number, card: HTMLElement | null): void {
    if (mode !== "list") return;
    const id = card?.dataset.id ?? "";
    if (!id || !card) {
      closeCtx();
      return;
    }
    closeRemind();
    // 多选里右键一张没勾的卡：先把勾选改成它自己（像资源管理器）
    if (multi && !picked.has(id)) {
      picked.clear();
      picked.add(id);
      const index = Number(card.dataset.index);
      pickAnchor = Number.isFinite(index) ? index : -1;
      applyPicked();
      syncSelbar();
    }
    ctxIds = multi ? pickedIds() : [id];
    if (ctxIds.length === 0) {
      closeCtx();
      return;
    }
    const index = Number(card.dataset.index);
    if (Number.isFinite(index)) {
      selected = index;
      applySelection();
    }
    // 集合级操作才有意义；单张才给「打开 / 设置提醒」
    const single = ctxIds.length === 1;
    ctxOpenItem.hidden = !single;
    ctxRemindItem.hidden = !single;
    const targets = notes.filter((note) => ctxIds.includes(note.id));
    const allPinned = targets.length > 0 && targets.every((note) => note.pinned);
    ctxPinItem.textContent = allPinned ? "取消置顶" : "置顶";
    const activeColor = single ? targets[0]?.color ?? "" : "";
    ctxColorsEl.querySelectorAll<HTMLElement>("[data-ctx-color]").forEach((dot) => {
      dot.dataset.active = dot.dataset.ctxColor === activeColor ? "1" : "0";
    });
    popX = x;
    popY = y;
    placePop(ctxEl, x, y);
  }

  function openRemind(id: string, x: number, y: number): void {
    const note = notes.find((item) => item.id === id);
    if (!note) return;
    closeCtx();
    remindId = id;
    remindField.value = note.reminder_at ? toDateTimeLocalValue(note.reminder_at) : "";
    popX = x;
    popY = y;
    placePop(remindEl, x, y);
    remindField.focus();
  }

  async function setRemind(ts: number | null): Promise<void> {
    const id = remindId;
    if (!id || busy) return;
    if (ts !== null && ts <= Date.now()) {
      showToast("选一个将来的时间");
      return;
    }
    busy = true;
    try {
      await api.setReminder(id, ts);
      closeRemind();
      showToast(ts === null ? "已清除提醒" : "提醒已设置：" + reminderLabel(ts));
      await loadAll();
    } catch (error) {
      console.error("设置提醒失败", error);
      showToast("设置失败：" + errorBrief(error), 2800);
    } finally {
      busy = false;
    }
  }

  // ---------- 复制正文 / 导出 Markdown（task-48）----------
  /** 一张便签的纯文本：标题 + 正文 / 待办行 / 随身笔记条目 */
  function notePlainText(note: Note): string {
    const lines: string[] = [toView(note).title];
    if (note.kind === "todo") {
      note.todos.forEach((item) => lines.push((item.done ? "- [x] " : "- [ ] ") + item.text));
    } else if (note.kind === "vault") {
      (note.items ?? []).forEach((item) => {
        const label = item.label.trim() || "（未命名）";
        lines.push(label + "：" + item.value);
      });
    } else if (note.content.trim()) {
      lines.push(note.content.trim());
    }
    return lines.join("\n");
  }

  async function copyNotes(ids: string[]): Promise<void> {
    const wanted = new Set(ids);
    const targets = notes.filter((note) => wanted.has(note.id));
    if (targets.length === 0) return;
    const ok = await copyText(targets.map(notePlainText).join("\n\n"));
    if (!ok) {
      showToast("复制失败，再试一次");
      return;
    }
    showToast(targets.length > 1 ? "已复制 " + targets.length + " 张正文" : "已复制正文");
  }

  /** 2026-11-14 00:23 —— 和后端导出的时间写法保持一致 */
  function stampText(ts: number): string {
    const d = new Date(ts || Date.now());
    const p = (n: number) => (n < 10 ? "0" + n : String(n));
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  /** 一条便签的 Markdown 段：结构和后端 export_notes 一模一样（同一张笔记两边导出长得一样） */
  function mdForNote(note: Note): string {
    const kindLabel = note.kind === "todo" ? "待办" : note.kind === "vault" ? "随身笔记" : "便签";
    let md = "## " + toView(note).title + "\n\n";
    md += "*" + kindLabel + (note.pinned ? " · 置顶" : "") + (note.locked ? " · 已锁定" : "");
    md += " · 创建 " + stampText(note.created_at) + " · 更新 " + stampText(note.updated_at) + "*\n\n";
    if (note.reminder_at) {
      const repeat = repeatLabel(note.repeat);
      md += "提醒：" + stampText(note.reminder_at) + (repeat ? "（" + repeat + "）" : "") + "\n\n";
    }
    if (note.kind === "memo") {
      if (note.content.trim()) md += note.content.trimEnd() + "\n\n";
    } else if (note.kind === "todo") {
      note.todos.forEach((item) => {
        md += "- [" + (item.done ? "x" : " ") + "] " + item.text;
        if (item.due_at) md += "（截止 " + stampText(item.due_at) + "）";
        md += "\n";
      });
      md += "\n";
    } else {
      (note.items ?? []).forEach((item) => {
        const label = item.label.trim();
        const value = item.value.trim();
        if (!label && !value) return;
        md += "- **" + label + "**：" + value;
        const noteText = item.note.trim();
        if (noteText) md += "（" + noteText + "）";
        md += "\n";
      });
      md += "\n";
    }
    return md + "---\n\n";
  }

  /** 文件名里不能出现的字符换成短横（标题是用户随手写的） */
  function fileSafe(text: string): string {
    const cleaned = text.replace(/[\\/:*?"<>|\r\n]+/g, "-").replace(/\s+/g, " ").trim();
    return (cleaned || "便签").slice(0, 40);
  }

  /** 纯前端导出：拼 Markdown → Blob → 临时 <a download>（后端没有单张导出命令，api.ts 也不让加） */
  function exportMarkdown(ids: string[]): void {
    const wanted = new Set(ids);
    const targets = sortNotes(notes.filter((note) => wanted.has(note.id)));
    if (targets.length === 0) return;
    const now = Date.now();
    let md = "";
    if (targets.length > 1) {
      md += "# 小梦备忘录 · 导出\n\n导出时间：" + stampText(now) + "　共 " + targets.length + " 张便签\n\n---\n\n";
    }
    md += targets.map(mdForNote).join("");
    const name =
      "小梦备忘录-" + fileSafe(targets.length === 1 ? toView(targets[0]).title : "导出") +
      "-" + stampText(now).replace(/[-: ]/g, "") + ".md";
    try {
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast(targets.length > 1 ? "已导出 " + targets.length + " 张的 Markdown" : "已导出 Markdown");
    } catch (error) {
      console.error("导出 Markdown 失败", error);
      showToast("导出失败");
    }
  }

  // ---------- 视图切换 ----------
  function setMode(next: "list" | "trash"): void {
    if (mode === next) return;
    // 批量条只属于便签列表：换视图前先退出多选
    if (multi) exitMulti(false);
    closePops();
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
    if (multi && Number.isFinite(index)) {
      // 多选模式下点卡片＝勾选（普通点切换、Shift 从锚点连选），不打开便签
      pickCard(index, card.dataset.id, event.shiftKey);
      return;
    }
    if (Number.isFinite(index)) {
      selected = index;
      applySelection();
    }
    void openNote(card.dataset.id);
  });

  // ---------- 多选 / 右键菜单 / 提醒弹层（task-48）----------
  // 右键菜单：卡片上按右键弹纸感菜单；多选时作用于整个勾选集合
  listEl.addEventListener("contextmenu", (event) => {
    if (mode !== "list") return;
    const target = event.target as HTMLElement;
    if (!target.closest(".xm-card")) return;
    event.preventDefault();
    const card = target.closest<HTMLElement>(".xm-card");
    openCtx(event.clientX, event.clientY, card);
  });

  selectBtn.addEventListener("click", () => {
    if (mode !== "list") return;
    if (multi) exitMulti();
    else enterMulti();
  });

  selbarEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-act="sel-exit"]')) {
      exitMulti();
      return;
    }
    const dot = target.closest<HTMLElement>("[data-sel-color]");
    if (dot?.dataset.selColor) {
      void colorNotes(pickedIds(), dot.dataset.selColor as NoteColor);
      return;
    }
    if (target.closest('[data-act="sel-pin"]')) {
      void pinNotes(pickedIds(), true);
      return;
    }
    if (target.closest('[data-act="sel-unpin"]')) {
      void pinNotes(pickedIds(), false);
      return;
    }
    if (target.closest('[data-act="sel-delete"]')) {
      void deleteNotes(pickedIds());
    }
  });

  ctxEl.addEventListener("click", (event) => {
    if (ctxIds.length === 0) return;
    const target = event.target as HTMLElement;
    const ids = ctxIds.slice();
    const dot = target.closest<HTMLElement>("[data-ctx-color]");
    if (dot?.dataset.ctxColor) {
      closeCtx();
      void colorNotes(ids, dot.dataset.ctxColor as NoteColor);
      return;
    }
    const item = target.closest<HTMLElement>("[data-ctx-act]");
    const act = item?.dataset.ctxAct;
    if (!act) return;
    const targets = notes.filter((note) => ids.includes(note.id));
    const allPinned = targets.length > 0 && targets.every((note) => note.pinned);
    const x = popX;
    const y = popY;
    closeCtx();
    if (act === "open") {
      const id = ids[0];
      if (id) void openNote(id);
    } else if (act === "pin") {
      void pinNotes(ids, !allPinned);
    } else if (act === "copy") {
      void copyNotes(ids);
    } else if (act === "remind") {
      openRemind(ids[0] ?? "", x, y);
    } else if (act === "delete") {
      // 右键删除是明确的动作：单张直接进回收站（有撤销），多张走批量
      if (ids.length === 1) void deleteFromPanel(ids[0]);
      else void deleteNotes(ids);
    } else if (act === "export") {
      exportMarkdown(ids);
    }
  });

  remindEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const quick = target.closest<HTMLElement>("[data-remind-quick]");
    if (quick?.dataset.remindQuick) {
      const kind = quick.dataset.remindQuick;
      let ts = 0;
      if (kind === "10") ts = Date.now() + 10 * 60 * 1000;
      else if (kind === "60") ts = Date.now() + 60 * 60 * 1000;
      else {
        const next = new Date();
        next.setDate(next.getDate() + 1);
        next.setHours(9, 0, 0, 0);
        ts = next.getTime();
      }
      void setRemind(ts);
      return;
    }
    if (target.closest('[data-remind-act="clear"]')) {
      void setRemind(null);
      return;
    }
    if (target.closest('[data-remind-act="set"]')) {
      const ts = fromDateTimeLocalValue(remindField.value);
      if (ts === null) {
        showToast("先选一个时间");
        return;
      }
      void setRemind(ts);
    }
  });

  // 点弹层外面收起：捕获阶段先于卡片自己的 click，避免"菜单没收起就打开了便签"
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as HTMLElement;
      if (!ctxEl.hidden && !ctxEl.contains(target) && !target.closest(".xm-card")) closeCtx();
      if (!remindEl.hidden && !remindEl.contains(target)) closeRemind();
    },
    true,
  );

  // 列表滚动 / 窗口尺寸变化：弹层跟着光标定位，位置一换算就废了，直接收起
  listEl.addEventListener("scroll", () => closeCtx());
  window.addEventListener("resize", () => closePops());

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
    // 收起状态下动筛选：先展开，否则改完看不见自己选了哪一项
    if (target.closest("[data-due], [data-kind], [data-color]") && actionsEl.dataset.open !== "1") {
      setFiltersOpen(true, false);
    }
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

  moreBtn.addEventListener("click", () => setMoreOpen(actionsEl.dataset.more !== "1"));
  // 筛选开关挪进工具条第一行后不在 filtersEl 里了，单独挂监听（task-53）
  filtersToggleBtn.addEventListener("click", () => setFiltersOpen(actionsEl.dataset.open !== "1"));
  // 「重置筛选」也跟着开关搬到了第一行，同样要单独挂；空列表里的「清除筛选」仍走列表委托
  filtersClearBtn.addEventListener("click", () => clearFilters());
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
    // 多张删除的撤销由面板自己管（undo.ts 只存一条，装不下集合）
    if (batchUndo) {
      void undoBatchDelete();
      return;
    }
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
    // Ctrl+A 全选（只在多选模式里接管；搜索框内还是走浏览器的全选文本）
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      if (!multi || mode !== "list") return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      views.forEach((view) => picked.add(view.note.id));
      pickAnchor = 0;
      selected = views.length > 0 ? 0 : -1;
      applySelection();
      applyPicked();
      syncSelbar();
      updateFoot(footCountText());
      return;
    }
    if (event.key === "Escape") {
      if (!versionEl.hidden) {
        event.preventDefault();
        closeVersionDetail();
        return;
      }
      if (!ctxEl.hidden) {
        event.preventDefault();
        closeCtx();
        return;
      }
      if (!remindEl.hidden) {
        event.preventDefault();
        closeRemind();
        return;
      }
      if (multi) {
        event.preventDefault();
        exitMulti();
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
      // 多选时 Delete 作用于整个勾选集合（不弹二次确认，删除后可撤销）
      if (multi && pickedIds().length > 0) {
        event.preventDefault();
        void deleteNotes(pickedIds());
        return;
      }
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
          if (multi) pickCard(selected, view.note.id, event.shiftKey);
          else void openNote(view.note.id);
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
    closePops();
    if (multi) exitMulti(false);
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
  // 折叠状态跟着上次走：第一次打开面板是收起的，只看到「备忘 / 待办 / 更多」
  setMoreOpen(readFlag(MORE_KEY), false);
  setFiltersOpen(readFlag(FILTERS_KEY), false);
  await loadAll();
  // 带着筛选条件回来时（上次没清），筛选条自动展开，状态不藏
  if (filtersActive()) setFiltersOpen(true, false);
  checkPendingUndo();
  // 浏览器 mock：便签页点「修改记录」后整页跳到面板，广播消息会错过，用 localStorage 请求补上
  const requestedHistory = readHistoryRequest();
  if (requestedHistory) void openHistory(requestedHistory);
  else searchEl.focus();
}
