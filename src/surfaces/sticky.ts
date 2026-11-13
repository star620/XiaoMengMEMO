/**
 * 便签窗口（surface=sticky）
 *
 * 三件核心体验：
 *  1) 点一下纸面就能写，Ctrl+S / 失焦 / 停手 0.8s 自动保存，保存后右下角轻轻提示；
 *  2) 长内容在正文区里原生滚动（滚轮 / 触控板），纸边按压暗渐隐提示；
 *  3) 两种类型：memo 纯文本，todo 待办清单（勾选划线 + WebAudio 合成的"哒"声）。
 *
 * 说明：窗口的边框/透明/置顶由 Rust 端负责；这个文件只管纸面里的 DOM 与交互。
 */
import { api } from "../shared/api";
import { clamp, debounce, query, uid } from "../shared/dom";
import { icons } from "../shared/icons";
import { isTauri } from "../shared/env";
import { onAppEvent } from "../shared/events";
import { startDragging, watchWindowState, closeCurrent } from "../shared/window";
import { playCheckSound } from "../shared/sound";
import { clockTime, dueShortLabel, fromDateTimeLocalValue, reminderLabel, toDateTimeLocalValue } from "../shared/format";
import { mdIsEmpty, mdToHtml, mdToPlain } from "../shared/markdown";
import { repeatLabel } from "../shared/format";
import { clearUndo, publishUndo } from "../shared/undo";
import { copyText } from "../shared/clipboard";
import { hasVaultContent, maskSecret, vaultAllText } from "../shared/vault";
import { createSizeFeel } from "../shared/size-feel";
import type { Note, Settings, TodoItem, VaultItem } from "../shared/types";

/** 6 种纸色，顺序与设置页一致 */
const COLORS = ["yellow", "pink", "mint", "sky", "lavender", "rose"] as const;
type Color = (typeof COLORS)[number];

/** 纸色中文名：和设置页 settings.ts 的 COLORS 保持一致（task-45：菜单里不再显示英文 key） */
const COLOR_LABELS: Record<Color, string> = {
  yellow: "暖黄",
  pink: "樱粉",
  mint: "薄荷",
  sky: "天空",
  lavender: "薰衣草",
  rose: "豆沙",
};

/** 便签三档尺寸（逻辑像素）。不允许拖边框，只能从这三档里选：
 *  一旦窗口可缩放，Windows 11 的「拖到顶部自动贴靠放大」就会生效，便签会被系统摆来摆去。 */
const SIZE_PRESETS: { key: string; label: string; width: number; height: number }[] = [
  { key: "compact", label: "紧凑", width: 280, height: 330 },
  { key: "normal", label: "标准", width: 320, height: 380 },
  { key: "large", label: "大", width: 400, height: 500 },
];

/** 重复提醒选项：空串 = 不重复（契约 §12.1） */
const REPEATS: { value: string; label: string }[] = [
  { value: "", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "工作日" },
  { value: "weekly", label: "每周" },
];

export async function mount(root: HTMLElement, ctx: { noteId: string }): Promise<void> {
  root.textContent = "正在打开便签…";

  // ---------- 1. 取数据 ----------
  const snapshot = await api.getSnapshot();
  let note = ctx.noteId ? snapshot.notes.find((n) => n.id === ctx.noteId) : undefined;
  if (!note) note = snapshot.notes[0]; // 浏览器调试：不带 id 时随便打开一张
  if (!note) note = await api.createNote("memo");
  let settings: Settings = snapshot.settings;
  /** 编辑中的草稿：所有修改先落在 draft，再整体保存 */
  let draft: Note = {
    ...note,
    repeat: note.repeat ?? "",
    todos: note.todos.map((t) => ({ ...t })),
    items: (note.items ?? []).map((item) => ({ ...item })),
    reveal: !!note.reveal,
  };
  let dirty = false;
  /** 忽略较早的异步响应，防止连点时把最新选择改回去。 */
  let collapseRequest = 0;
  let sizeRequest = 0;
  let windowChanges: Promise<void> = Promise.resolve();
  let pendingWindowChanges = 0;

  /** 折叠和尺寸共用队列，让后端收到的顺序与点击顺序一致。 */
  function queueWindowChange<T>(change: () => Promise<T>): Promise<T> {
    pendingWindowChanges += 1;
    const result = windowChanges.then(change).finally(() => {
      pendingWindowChanges -= 1;
    });
    windowChanges = result.then(() => undefined, () => undefined);
    return result;
  }

  function localWindowState(revision: number): Partial<Pick<Note, "width" | "height" | "collapsed">> {
    return pendingWindowChanges > 0 || revision !== collapseRequest + sizeRequest
      ? { width: draft.width, height: draft.height, collapsed: draft.collapsed }
      : {};
  }
  /**
   * 用户刚点过的那一档尺寸：窗口动画期间量到的宽度是中间帧，
   * 高亮以 intent 为准，等窗口真的到位（或超时）再交还给实际宽度。
   */
  let sizeIntent = "";
  let sizeIntentAt = 0;
  let sizeIntentTimer = 0;
  /** resize 事件节流用 */
  let sizeIntentCheckTimer = 0;
  let saving = false;
  /** 保存飞行中又被要求保存（自动保存/重复提醒等）：本次结束后补写一次，别丢改动 */
  let retryAfterSave = false;
  /** 正文现在是不是"排版后的渲染态"（点一下会退回原文编辑态） */
  let mdRendered = false;
  /** 上一次渲染用的源码，用来判断保存回来后要不要重排 */
  let lastRendered = "";
  /** 随身笔记：正在编辑哪一条（空串 = 没有） */
  let vaultEditingId = "";
  /** 随身笔记：失焦保存的小延迟，让同一行里的按钮点击先发生 */
  let vaultBlurTimer = 0;

  // ---------- 2. 一次性搭好 DOM（结构见 docs/ui-contract.md） ----------
  // 正文只有一层滚动容器（.xm-sheet）；memo / todo 都不再分页
  const bodyHtml =
    draft.kind === "memo"
      ? '<div class="xm-sheet"><div class="xm-sheet__inner xm-text" contenteditable="true" ' +
        'data-md="0" data-placeholder="写点什么…" spellcheck="false"></div></div>'
      : draft.kind === "todo"
        ? '<div class="xm-sheet"><ul class="xm-todos"></ul></div>'
        : '<div class="xm-vault" role="list" aria-label="随身笔记条目"></div>';

  const popHint = '<div class="xm-pop xm-pop--remind" data-pop="remind" hidden>' +
    '<div class="xm-pop__label">提醒我</div>' +
    '<div class="xm-pop__row"><input class="xm-field" type="datetime-local" aria-label="提醒时间" /></div>' +
    '<div class="xm-pop__label">重复</div>' +
    '<div class="xm-repeat" role="group" aria-label="重复提醒">' +
    REPEATS.map((item) =>
      '<button class="xm-repeat__opt" type="button" data-repeat="' + item.value + '" data-active="0" aria-pressed="false">' +
      item.label + "</button>",
    ).join("") +
    "</div>" +
    '<div class="xm-pop__quick">' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-quick="10">10 分钟后</button>' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-quick="60">1 小时后</button>' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-quick="tomorrow">明天 9:00</button>' +
    "</div>" +
    '<div class="xm-pop__row">' +
    '<button class="xm-btn xm-btn--primary" type="button" data-act="remind-set">设置提醒</button>' +
    '<button class="xm-btn" type="button" data-act="remind-clear">清除</button>' +
    "</div></div>";

  // 待办的截止时间弹层：快捷“今天/明天/后天” + 自定义时间（契约 §8.4a）
  const duePopHtml = '<div class="xm-pop xm-pop--due" data-pop="due" hidden>' +
    '<div class="xm-pop__label">截止时间</div>' +
    '<div class="xm-pop__quick">' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-due="today">今天 18:00</button>' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-due="tomorrow">明天 9:00</button>' +
    '<button class="xm-btn xm-btn--ghost" type="button" data-due="after">后天 9:00</button>' +
    "</div>" +
    '<div class="xm-pop__row"><input class="xm-field" type="datetime-local" aria-label="截止时间" /></div>' +
    '<div class="xm-pop__row">' +
    '<button class="xm-btn xm-btn--primary" type="button" data-act="due-set">确定</button>' +
    '<button class="xm-btn" type="button" data-act="due-clear">清除</button>' +
    "</div></div>";

  const menuPopHtml = '<div class="xm-pop xm-pop--menu" data-pop="menu" hidden>' +
    '<div class="xm-pop__label">颜色</div>' +
    '<div class="xm-colors">' +
    COLORS.map(
      (c) =>
        '<button class="xm-color-dot" type="button" data-color="' + c +
        '" title="' + COLOR_LABELS[c] + '" aria-label="' + COLOR_LABELS[c] + '"></button>',
    ).join("") +
    "</div>" +
    '<div class="xm-pop__sep"></div>' +
    '<div class="xm-pop__row"><span class="xm-pop__mini">字号</span>' +
    '<div class="xm-seg">' +
    '<button class="xm-seg__item" type="button" data-scale="0.9">小</button>' +
    '<button class="xm-seg__item" type="button" data-scale="1">中</button>' +
    '<button class="xm-seg__item" type="button" data-scale="1.15">大</button>' +
    "</div></div>" +
    '<div class="xm-pop__row"><span class="xm-pop__mini">大小</span>' +
    '<div class="xm-seg">' +
    SIZE_PRESETS.map((p) => '<button class="xm-seg__item" type="button" data-size="' + p.key + '">' + p.label + "</button>").join("") +
    "</div></div>" +
    '<button class="xm-pop__item xm-pop__item--history" type="button" data-act="history">' +
    icons.history + "<span>修改记录</span></button>" +
    '<div class="xm-pop__sep"></div>' +
    '<button class="xm-pop__item" type="button" data-act="collapse">收起便签</button>' +
    '<button class="xm-pop__item" type="button" data-act="lock">锁定便签</button>' +
    '<div class="xm-pop__sep"></div>' +
    '<button class="xm-pop__item" type="button" data-act="delete">删除便签</button>' +
    '<button class="xm-pop__item" type="button" data-act="close">关闭窗口</button>' +
    "</div>";

  root.innerHTML =
    '<div class="xm-note" data-kind="' + draft.kind + '" data-color="' + draft.color + '" data-pinned="0" data-editing="0" data-collapsed="0" data-locked="0">' +
    '<div class="xm-note__paper">' +
    '<div class="xm-note__drag" data-tauri-drag-region title="按住拖动便签"></div>' +
    '<div class="xm-note__lock" title="已锁定：只能看不能改" aria-hidden="true" hidden>' + icons.lock + "</div>" +
    '<div class="xm-note__head">' +
    '<input class="xm-note__title" maxlength="80" placeholder="标题" aria-label="便签标题" />' +
    '<div class="xm-note__tools">' +
    '<button class="xm-btn xm-btn--icon" type="button" data-act="panel" title="打开面板（所有便签）" aria-label="打开面板">' + icons.panel + "</button>" +
    '<button class="xm-btn xm-btn--icon" type="button" data-act="pin" title="置顶（永远在最上层）" aria-label="置顶" aria-pressed="false">' + icons.pin + "</button>" +
    '<button class="xm-btn xm-btn--icon" type="button" data-act="remind" title="提醒" aria-label="提醒">' + icons.bell + "</button>" +
    '<button class="xm-btn xm-btn--icon" type="button" data-act="expand" title="展开便签" aria-label="展开便签">' + icons.expand + "</button>" +
    '<button class="xm-btn xm-btn--icon" type="button" data-act="menu" title="更多" aria-label="更多">' + icons.more + "</button>" +
    "</div></div>" +
    '<div class="xm-note__body">' + bodyHtml + "</div>" +
    '<div class="xm-note__foot"><span class="xm-note__meta"></span></div>' +
    popHint + menuPopHtml + duePopHtml +
    "</div>" +
    '<div class="xm-toast" data-show="0">已保存</div>' +
    "</div>";

  // ---------- 3. 常用节点 ----------
  const noteEl = query<HTMLElement>(root, ".xm-note");

  const paperEl = query<HTMLElement>(root, ".xm-note__paper");
  const sizeFeel = createSizeFeel(noteEl, paperEl, {
    id: draft.id, width: draft.width || 320, height: draft.collapsed ? 64 : draft.height || 380,
  });
  const dragEl = query<HTMLElement>(root, ".xm-note__drag");
  const titleInput = query<HTMLInputElement>(root, ".xm-note__title");
  const panelBtn = query<HTMLButtonElement>(root, '[data-act="panel"]');
  const pinBtn = query<HTMLButtonElement>(root, '[data-act="pin"]');
  const remindBtn = query<HTMLButtonElement>(root, '[data-act="remind"]');
  const menuBtn = query<HTMLButtonElement>(root, '[data-act="menu"]');
  const expandBtn = query<HTMLButtonElement>(root, '[data-act="expand"]');
  const headEl = query<HTMLElement>(root, ".xm-note__head");
  const toolsEl = query<HTMLElement>(root, ".xm-note__tools");
  const lockBadge = query<HTMLElement>(root, ".xm-note__lock");
  const bodyEl = query<HTMLElement>(root, ".xm-note__body");
  const sheetEl = draft.kind === "vault" ? null : query<HTMLElement>(root, ".xm-sheet");
  /** 随身笔记的滚动层；其他类型为 null */
  const vaultEl = draft.kind === "vault" ? query<HTMLElement>(root, ".xm-vault") : null;
  const metaEl = query<HTMLElement>(root, ".xm-note__meta");
  const toastEl = query<HTMLElement>(root, ".xm-toast");
  const remindPop = query<HTMLElement>(root, '[data-pop="remind"]');
  const menuPop = query<HTMLElement>(root, '[data-pop="menu"]');
  const duePop = query<HTMLElement>(root, '[data-pop="due"]');
  const remindField = query<HTMLInputElement>(remindPop, ".xm-field");
  const dueField = query<HTMLInputElement>(duePop, ".xm-field");
  /** 提醒时间框上次打开时自动填的值：用户没改过时，选重复要按「明天 9:00 起」补起点 */
  let remindAutoValue = "";
  let remindTouched = false;
  remindField.addEventListener("input", () => {
    remindTouched = true;
  });
  remindField.addEventListener("change", () => {
    remindTouched = true;
  });

  /** memo 模式的正文编辑器；todo 模式为 null */
  const editor = draft.kind === "memo" ? query<HTMLElement>(root, ".xm-sheet__inner") : null;
  /** todo 模式的列表；memo 模式为 null */
  const todosEl = draft.kind === "todo" ? query<HTMLUListElement>(root, ".xm-todos") : null;

  // ---------- 4. 保存 ----------
  let toastTimer = 0;
  /** 置顶按钮状态：外观靠 data-active，读屏与悬浮提示靠 aria-pressed + title */
  function updatePinButton(): void {
    const on = draft.pinned;
    pinBtn.dataset.active = on ? "1" : "0";
    pinBtn.setAttribute("aria-pressed", on ? "true" : "false");
    pinBtn.title = on ? "取消置顶（当前已置顶，永远在最上层）" : "置顶（永远在最上层）";
  }

  function toast(text = "已保存"): void {
    toastEl.textContent = text;
    toastEl.dataset.show = "1";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.dataset.show = "0";
    }, 1200);
  }

  /** 把 DOM 上的最新内容收进 draft */
  function collect(): void {
    // 渲染态里 innerText 是排版后的文字，不是原文——这时候千万别覆盖 draft.content
    if (draft.kind === "memo" && editor && !mdRendered) {
      const text = editor.innerText.replace(/\u00a0/g, " ");
      // 结尾的一堆空行没有意义，清掉；中间最多保留两个换行
      draft.content = text.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
    } else if (draft.kind === "todo") {
      draft.todos.forEach((item, index) => {
        item.order = index;
      });
    }
    draft.title = titleInput.value;
  }

  async function saveNote(showToast = true): Promise<void> {
    scheduleSave.cancel();
    if (!dirty) return;
    // 上一次保存还在飞行中：先记下"还要再存一次"，等它结束立刻补写。
    // 旧代码在这里直接 return，导致重复提醒这类改动被静默丢掉（用户 m02364）。
    if (saving) {
      retryAfterSave = true;
      return;
    }
    collect();
    dirty = false;
    saving = true;
    let failed = false;
    const windowRevision = collapseRequest + sizeRequest;
    try {
      const saved = await api.saveNote({ ...draft, updated_at: Date.now() });
      if (!dirty) {
        draft = {
          ...saved,
          ...localWindowState(windowRevision),
          repeat: saved.repeat ?? "",
          todos: saved.todos.map((t) => ({ ...t })),
          items: (saved.items ?? []).map((item) => ({ ...item })),
          reveal: !!saved.reveal,
        };
        renderFromNote();
        if (showToast) toast("已保存");
      } else {
        // 保存期间又改了：不能用这次响应覆盖本地草稿，否则 repeat / color / pinned
        // 这些不来自 DOM 的字段会被旧值回滚，补保存也救不回来。
        draft.updated_at = saved.updated_at;
      }
    } catch (error) {
      // 保存失败：标记回 dirty，下一次输入/失焦会重试
      failed = true;
      retryAfterSave = false;
      dirty = true;
      console.error("保存便签失败", error);
      if (showToast) toast("保存失败");
    } finally {
      saving = false;
      // 保存期间来的新改动（或刚才被 saving 挡掉的那次）结束后立刻补写一次；
      // 失败时不补，避免后端/磁盘异常时死循环重试。
      if (!failed && (dirty || retryAfterSave)) {
        retryAfterSave = false;
        void saveNote(false);
      }
    }
  }

  const scheduleSave = debounce(() => {
    void saveNote(false);
  }, 800);

  function markDirty(): void {
    dirty = true;
    updateMeta();
  }

  // ---------- 5. 渲染 / 刷新 ----------
  function renderFromNote(): void {
    noteEl.dataset.kind = draft.kind;
    noteEl.dataset.color = draft.color;
    noteEl.dataset.pinned = draft.pinned ? "1" : "0";
    noteEl.dataset.mdRendered = mdRendered ? "1" : "0";
    noteEl.style.setProperty("--xm-font-scale", String(draft.font_scale || 1));
    updatePinButton();
    noteEl.dataset.collapsed = draft.collapsed ? "1" : "0";
    updateMenuItems();
    remindBtn.dataset.active = draft.reminder_at && !draft.reminder_done ? "1" : "0";
    if (titleInput.value !== draft.title) titleInput.value = draft.title;
    if (draft.kind === "memo" && editor) {
      if (mdRendered) {
        // 排版态：只有保存回来拿到的新内容才重排（否则会把用户正在看的纸面重画一遍）
        if (draft.content !== lastRendered) renderMarkdown();
      } else {
        // 只有内容真的不一样才重写 DOM：自动保存后会走这里，
        // 之前用 innerText 原样比较，回车产生的行尾差异会导致整段重写、
        // 光标跳走、视觉上像"换行被折回上一行"。
        const current = editor.innerText
          .replace(/\u00a0/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/\s+$/, "");
        if (current !== draft.content) editor.textContent = draft.content;
      }
    } else if (draft.kind === "todo") {
      renderTodos();
    } else if (draft.kind === "vault") {
      renderVault();
    }
    // 必须在正文/待办渲染之后再上锁：renderTodos() 会重建每一行，
    // 早于它调用的话，重新生成的勾选/输入框又变成可点的了（task-22 自检发现）。
    applyLocked();
    updateColorDots();
    updateScaleSeg();
    updateSizeSeg();
    updateRepeatButtons();
    updateMeta();
    scheduleScrollState();
  }

  /** 重建待办表前记下的焦点：哪一行、光标在哪（「＋ 新待办」草稿行连内容一起带过去） */
  interface TodoFocusSnapshot {
    id: string;
    isNew: boolean;
    start: number | null;
    end: number | null;
    newText: string;
  }

  function captureTodoFocus(): TodoFocusSnapshot | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) || !todosEl?.contains(active)) return null;
    if (!active.classList.contains("xm-todo__text")) return null;
    const row = active.closest<HTMLElement>("li.xm-todo");
    if (!row) return null;
    const isNew = row.classList.contains("xm-todo--new");
    return {
      id: row.dataset.id ?? "",
      isNew,
      start: active.selectionStart,
      end: active.selectionEnd,
      newText: isNew ? active.value : "",
    };
  }

  function restoreTodoFocus(focus: TodoFocusSnapshot | null): void {
    if (!focus) return;
    const input = focus.isNew
      ? newRowInput()
      : (todoRowById(focus.id)?.querySelector<HTMLInputElement>(".xm-todo__text") ?? null);
    if (!input) return;
    // 草稿行还没入库：重建时把它已经输入的内容带回来，别让用户白打一段
    if (focus.isNew && focus.newText && input.value !== focus.newText) input.value = focus.newText;
    input.focus();
    if (focus.start !== null && focus.end !== null) {
      try {
        input.setSelectionRange(focus.start, focus.end);
      } catch {
        // 输入框刚好变成不可选（例如同时进入锁定态）就算了，焦点还在
      }
    }
  }

  /**
   * 纸面上的待办是否已经和 draft 一致。
   * 一致就说明这次刷新没有新内容可画——不能白白重建整表：
   * innerHTML="" 会把正在输入的 <input> 换成新节点，焦点和光标一起丢（task-45 P1）。
   */
  function todosDomMatchesDraft(): boolean {
    if (!todosEl) return true;
    const rows = todoRows();
    if (rows.length !== draft.todos.length) return false;
    const sorted = draft.todos.slice().sort((a, b) => a.order - b.order);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const item = sorted[i];
      if (row.dataset.id !== item.id) return false;
      if (row.dataset.done !== (item.done ? "1" : "0")) return false;
      if ((row.dataset.due ?? "") !== (item.due_at ? String(item.due_at) : "")) return false;
      const input = row.querySelector<HTMLInputElement>(".xm-todo__text");
      if (!input || input.value !== item.text) return false;
    }
    return true;
  }

  function renderTodos(): void {
    if (!todosEl) return;
    // 拖拽进行中不重建列表（契约 §16.3）：重建会把正在拖的那一行换成新节点，
    // pointer 捕获和 data-drag 一起丢；等松手/取消后再补一次重画。
    if (todoDrag && todoDrag.active) {
      todosRenderDeferred = true;
      return;
    }
    // 自动保存回来时 draft 只是被后端响应"回填"了一遍，纸面内容通常没变：
    // 这时跳过重建，用户正在输入的那一行连焦点带光标都原样留着（task-45）。
    // 「＋ 新待办」草稿行不在也算不匹配：空待办（新建的待办便签）第一次渲染时
    // rows 和 draft 都是空，会误判成"已经一致"，草稿行就永远不出现，等于没法新增。
    if (todosDomMatchesDraft() && todosEl.querySelector(".xm-todo--new")) {
      updateMeta();
      return;
    }
    // 万一确实要重建（外部改动多行、锁定态变化等），先把焦点记下来，画完还回去
    const focus = captureTodoFocus();
    todosEl.innerHTML = "";
    draft.todos
      .slice()
      .sort((a, b) => a.order - b.order)
      .forEach((item) => todosEl.appendChild(createTodoRow(item)));
    todosEl.appendChild(createNewRow());
    restoreTodoFocus(focus);
    updateMeta();
  }

  function createTodoRow(item: TodoItem): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "xm-todo";
    li.dataset.id = item.id;
    li.dataset.done = item.done ? "1" : "0";
    // 记下截止时间：重建前用它判断"纸面是否已经和 draft 一致"（task-45）
    li.dataset.due = item.due_at ? String(item.due_at) : "";

    // 提起手柄：.xm-todo__text 铺满整行，没有它就几乎按不到能拖的地方（task-39）。
    // 6 个点交给 CSS 画，这里只放最小 DOM；tabindex=-1 表示不参与 Tab 顺序。
    const grip = createTodoGrip();

    const check = document.createElement("button");
    check.className = "xm-todo__check";
    check.type = "button";
    check.setAttribute("aria-label", item.done ? "标记未完成" : "标记完成");
    check.innerHTML = icons.check;

    const input = document.createElement("input");
    input.className = "xm-todo__text";
    input.type = "text";
    input.value = item.text;
    input.setAttribute("aria-label", "待办内容");
    input.spellcheck = false;

    const due = document.createElement("button");
    due.className = "xm-todo__due";
    due.type = "button";
    updateDueButton(due, item);

    const del = document.createElement("button");
    del.className = "xm-todo__del";
    del.type = "button";
    del.setAttribute("aria-label", "删除这条待办");
    del.textContent = "×";

    li.append(grip, check, input, due, del);
    return li;
  }

  /**
   * 待办行左侧的拖拽手柄（契约 §16.3 补充，task-39）。
   * 只负责给出一个"能抓住的地方"：真正排版、6 个点的样子都在 paper.css 里。
   */
  function createTodoGrip(): HTMLSpanElement {
    const grip = document.createElement("span");
    grip.className = "xm-todo__grip";
    grip.setAttribute("role", "button");
    grip.tabIndex = -1;
    grip.title = "拖动排序";
    grip.setAttribute("aria-label", "拖动排序");
    // 六个点由 paper.css 用 radial-gradient 背景画（零图片素材），这里不放多余节点
    return grip;
  }

  /** 刷新一条待办右侧的截止时间小按钮（没设时间就是小钟表图标） */
  function updateDueButton(btn: HTMLElement, item: TodoItem): void {
    const ts = item.due_at;
    if (ts) {
      btn.dataset.set = "1";
      btn.dataset.overdue = ts < Date.now() ? "1" : "0";
      btn.textContent = dueShortLabel(ts);
      btn.title = "截止 " + reminderLabel(ts) + "，点一下修改";
      btn.setAttribute("aria-label", "截止时间 " + reminderLabel(ts));
    } else {
      btn.dataset.set = "0";
      btn.dataset.overdue = "0";
      btn.innerHTML = icons.clock;
      btn.title = "设置截止时间";
      btn.setAttribute("aria-label", "设置截止时间");
    }
  }

  function createNewRow(): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "xm-todo xm-todo--new";
    const input = document.createElement("input");
    input.className = "xm-todo__text";
    input.type = "text";
    input.placeholder = "＋ 新待办";
    input.setAttribute("aria-label", "新待办");
    input.spellcheck = false;
    // 新增行也放一个手柄占位：跟上面的行左边对齐，看着不会突然缩进
    li.append(createTodoGrip(), input);
    return li;
  }

  function newRowInput(): HTMLInputElement | null {
    return todosEl ? todosEl.querySelector<HTMLInputElement>(".xm-todo--new .xm-todo__text") : null;
  }

  // ---------- 5.5 随身笔记（契约 §13.6） ----------
  /** 新建/重画条目列表；编辑中的那一行会换成输入框 */
  function renderVault(): void {
    if (!vaultEl) return;
    vaultEl.innerHTML = "";
    draft.items.forEach((item) => {
      vaultEl.appendChild(createVaultRow(item));
    });
    if (draft.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "xm-vault__empty";
      empty.textContent = "还没有条目，点下面「＋ 再记一条」。";
      vaultEl.appendChild(empty);
    }
    const actions = document.createElement("div");
    actions.className = "xm-vault__actions";
    const add = document.createElement("button");
    add.className = "xm-btn xm-vault__add";
    add.type = "button";
    add.dataset.act = "vault-add";
    add.textContent = "＋ 再记一条";
    const all = document.createElement("button");
    all.className = "xm-btn xm-vault__all";
    all.type = "button";
    all.dataset.act = "vault-copy-all";
    all.textContent = "复制全部";
    actions.append(add, all);
    vaultEl.appendChild(actions);
    updateMeta();
    applyLocked();
  }

  function createVaultRow(item: VaultItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "xm-vault__row";
    row.dataset.id = item.id;
    row.dataset.masked = draft.reveal ? "0" : "1";
    row.setAttribute("role", "listitem");
    if (item.id === vaultEditingId) return fillVaultEditRow(row, item);

    const main = document.createElement("div");
    main.className = "xm-vault__main";
    main.setAttribute("role", "button");
    main.tabIndex = 0;
    main.setAttribute("aria-label", "复制 " + (item.label.trim() || "这一条"));

    const label = document.createElement("div");
    label.className = "xm-vault__label";
    label.textContent = item.label.trim() || "（未命名）";

    const value = document.createElement("div");
    value.className = "xm-vault__value";
    value.textContent = maskSecret(item.value, draft.reveal);

    main.append(label, value);
    if (item.note.trim()) {
      const hint = document.createElement("div");
      hint.className = "xm-vault__hint";
      hint.textContent = item.note.trim();
      main.appendChild(hint);
    }

    const tools = document.createElement("div");
    tools.className = "xm-vault__tools";
    tools.append(
      vaultToolButton("vault-eye", icons.eye, draft.reveal ? "隐藏内容" : "显示明文"),
      vaultToolButton("vault-edit", icons.edit, "编辑这一条"),
      vaultToolButton("vault-del", icons.trash, "删除这一条"),
    );
    const eye = tools.querySelector<HTMLElement>('[data-act="vault-eye"]');
    if (eye) {
      eye.dataset.active = draft.reveal ? "1" : "0";
      eye.setAttribute("aria-pressed", draft.reveal ? "true" : "false");
    }
    row.append(main, tools);
    return row;
  }

  function vaultToolButton(act: string, icon: string, label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "xm-btn xm-btn--icon";
    btn.type = "button";
    btn.dataset.act = act;
    btn.innerHTML = icon;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    return btn;
  }

  function fillVaultEditRow(row: HTMLElement, item: VaultItem): HTMLElement {
    row.dataset.editing = "1";
    const main = document.createElement("div");
    main.className = "xm-vault__main";
    const fields: { field: "label" | "value" | "note"; placeholder: string }[] = [
      { field: "label", placeholder: "名字" },
      { field: "value", placeholder: "要复制的内容" },
      { field: "note", placeholder: "备注（可选）" },
    ];
    fields.forEach(({ field, placeholder }) => {
      const input = document.createElement("input");
      input.className = "xm-vault__input";
      input.type = "text";
      input.dataset.field = field;
      input.placeholder = placeholder;
      input.value = item[field];
      input.spellcheck = false;
      input.autocomplete = "off";
      input.setAttribute("aria-label", placeholder);
      main.appendChild(input);
    });
    const tools = document.createElement("div");
    tools.className = "xm-vault__tools";
    const done = document.createElement("button");
    done.className = "xm-btn xm-vault__done";
    done.type = "button";
    done.dataset.act = "vault-done";
    done.textContent = "完成";
    tools.appendChild(done);
    row.append(main, tools);
    requestAnimationFrame(() => {
      const first = row.querySelector<HTMLInputElement>('.xm-vault__input[data-field="label"]');
      first?.focus();
      first?.select();
    });
    return row;
  }

  function vaultRow(id: string): HTMLElement | null {
    return vaultEl?.querySelector<HTMLElement>('.xm-vault__row[data-id="' + id + '"]') ?? null;
  }

  function startVaultEdit(id: string): void {
    if (draft.locked) return;
    vaultEditingId = id;
    renderVault();
    scheduleScrollState();
  }

  /** 读输入框 -> draft；空行直接丢掉；返回有没有改动 */
  function commitVaultEdit(): void {
    if (!vaultEditingId) return;
    const id = vaultEditingId;
    const row = vaultRow(id);
    const item = draft.items.find((entry) => entry.id === id);
    let changed = false;
    if (row && item) {
      const read = (field: string): string =>
        row.querySelector<HTMLInputElement>('.xm-vault__input[data-field="' + field + '"]')?.value ?? "";
      const label = read("label").trim();
      const value = read("value");
      const note = read("note").trim();
      changed = item.label !== label || item.value !== value || item.note !== note;
      item.label = label;
      item.value = value;
      item.note = note;
      if (!hasVaultContent(item)) {
        draft.items = draft.items.filter((entry) => entry.id !== id);
        changed = true;
      }
    }
    vaultEditingId = "";
    renderVault();
    if (changed) {
      markDirty();
      scheduleScrollState();
      void saveNote(false);
    }
  }

  function cancelVaultEdit(): void {
    if (!vaultEditingId) return;
    const id = vaultEditingId;
    const item = draft.items.find((entry) => entry.id === id);
    if (item && !hasVaultContent(item)) {
      draft.items = draft.items.filter((entry) => entry.id !== id);
    }
    vaultEditingId = "";
    renderVault();
    scheduleScrollState();
  }

  function addVaultItem(): void {
    if (draft.locked) return;
    const item: VaultItem = { id: uid(), label: "", value: "", note: "" };
    draft.items.push(item);
    startVaultEdit(item.id);
    requestAnimationFrame(() => {
      vaultRow(item.id)?.scrollIntoView({ block: "nearest" });
    });
  }

  function deleteVaultItem(id: string): void {
    if (draft.locked) return;
    if (vaultEditingId === id) vaultEditingId = "";
    draft.items = draft.items.filter((item) => item.id !== id);
    renderVault();
    markDirty();
    scheduleScrollState();
    void saveNote(false);
    toast("已删除一条");
  }

  function toggleVaultReveal(): void {
    draft.reveal = !draft.reveal;
    renderVault();
    scheduleScrollState();
    markDirty();
    void saveNote(false);
    toast(draft.reveal ? "已显示明文" : "已打码");
  }

  async function copyVaultItem(id: string, row: HTMLElement | null): Promise<void> {
    const item = draft.items.find((entry) => entry.id === id);
    if (!item) return;
    if (!item.value) {
      toast("这条还没有内容");
      return;
    }
    const ok = await copyText(item.value);
    if (!ok) {
      toast("复制失败，请手动选中");
      return;
    }
    if (row) {
      row.dataset.copied = "1";
      window.setTimeout(() => {
        if (row.isConnected) delete row.dataset.copied;
      }, 1200);
    }
  }

  async function copyAllVault(): Promise<void> {
    const items = draft.items.filter(hasVaultContent);
    if (items.length === 0) {
      toast("还没有可复制的条目");
      return;
    }
    const ok = await copyText(vaultAllText(items));
    toast(ok ? "已复制 " + items.length + " 条" : "复制失败，请手动选中");
  }

  if (vaultEl) {
    vaultEl.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const row = target.closest<HTMLElement>(".xm-vault__row");
      const rowId = row?.dataset.id ?? "";
      const action = target.closest<HTMLElement>("[data-act]")?.dataset.act ?? "";
      // 点到别的行/空白处：先把正在编辑的那条存了
      if (vaultEditingId && rowId !== vaultEditingId && action !== "vault-done") {
        commitVaultEdit();
      }
      // 提交后旧行已经被重画掉了，后面复制要找新的那一行做“已复制”反馈
      const liveRow = rowId ? vaultRow(rowId) : null;
      if (action === "vault-done") {
        commitVaultEdit();
        return;
      }
      if (action === "vault-eye") {
        toggleVaultReveal();
        return;
      }
      if (action === "vault-edit") {
        if (!draft.locked && rowId) startVaultEdit(rowId);
        return;
      }
      if (action === "vault-del") {
        if (!draft.locked && rowId) deleteVaultItem(rowId);
        return;
      }
      if (action === "vault-add") {
        addVaultItem();
        return;
      }
      if (action === "vault-copy-all") {
        void copyAllVault();
        return;
      }
      if (!vaultEditingId && rowId && target.closest(".xm-vault__main")) {
        void copyVaultItem(rowId, liveRow);
      }
    });

    vaultEl.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      if (target.matches('.xm-vault__input')) {
        if (event.key === "Enter") {
          event.preventDefault();
          commitVaultEdit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelVaultEdit();
        }
        return;
      }
      if (target.matches('.xm-vault__main') && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        const row = target.closest<HTMLElement>(".xm-vault__row");
        if (row?.dataset.id) void copyVaultItem(row.dataset.id, row);
      }
    });

    vaultEl.addEventListener("focusout", (event) => {
      if (!vaultEditingId) return;
      const editingId = vaultEditingId;
      const target = event.target as HTMLElement;
      const row = target.closest<HTMLElement>(".xm-vault__row");
      if (!row || row.dataset.id !== editingId) return;
      const next = (event as FocusEvent).relatedTarget as Node | null;
      if (next && row.contains(next)) return;
      if (vaultBlurTimer) window.clearTimeout(vaultBlurTimer);
      vaultBlurTimer = window.setTimeout(() => {
        vaultBlurTimer = 0;
        // 这 120ms 里可能已经点了「＋再记一条」/另一条编辑：只提交原先那一行
        if (vaultEditingId === editingId) commitVaultEdit();
      }, 120);
    });
  }

  function updateMeta(): void {
    if (draft.kind === "vault") {
      metaEl.textContent = draft.items.length > 0 ? draft.items.length + " 条" : "还没有条目";
    } else if (draft.kind === "todo") {
      const total = draft.todos.length;
      const done = draft.todos.filter((t) => t.done).length;
      metaEl.textContent = total > 0 ? total + " 项待办 · " + done + " 已完成" : "还没有待办";
    } else if (editor) {
      // 字数按原文算：Markdown 标记（# - **）不计入，排版前后字数不变。
      // 编辑态用 DOM 里的实时文字（draft.content 要等 collect 才更新，否则字数会慢半秒）
      const source = mdRendered ? draft.content : editor.innerText.replace(/\u00a0/g, " ");
      const len = mdToPlain(source).replace(/\s/g, "").length;
      metaEl.textContent = len > 0 ? len + " 字" : "";
    }
  }

  function updateColorDots(): void {
    menuPop.querySelectorAll<HTMLElement>(".xm-color-dot").forEach((dot) => {
      dot.dataset.active = dot.dataset.color === draft.color ? "1" : "0";
    });
  }

  function updateScaleSeg(): void {
    menuPop.querySelectorAll<HTMLElement>(".xm-seg__item[data-scale]").forEach((item) => {
      item.dataset.active = Number(item.dataset.scale) === Number(draft.font_scale) ? "1" : "0";
    });
  }

  /**
   * 三档尺寸的高亮（task-28）：
   * 用户点过哪一档就以它为准立刻点亮；等窗口动画真的到这一档（±30px），
   * 或 intent 超过 800ms 还没达成，才清掉 intent、改按实际宽度就近匹配。
   * 这样连续点「紧凑 → 标准 → 大」时高亮跟手，不会停在中途某一档。
   */
  function updateSizeSeg(): void {
    let best = "";
    if (sizeIntent) {
      best = sizeIntent;
    } else {
      const current = Math.round(noteEl.offsetWidth || draft.width || 320);
      let bestGap = Number.POSITIVE_INFINITY;
      for (const preset of SIZE_PRESETS) {
        const gap = Math.abs(preset.width - current);
        if (gap < bestGap) {
          bestGap = gap;
          best = preset.key;
        }
      }
    }
    menuPop.querySelectorAll<HTMLElement>(".xm-seg__item[data-size]").forEach((item) => {
      item.dataset.active = item.dataset.size === best ? "1" : "0";
    });
  }

  /** 清掉尺寸 intent（连同 800ms 超时定时器） */
  function clearSizeIntent(): void {
    sizeIntent = "";
    sizeIntentAt = 0;
    if (sizeIntentTimer) {
      window.clearTimeout(sizeIntentTimer);
      sizeIntentTimer = 0;
    }
  }

  /** 点某一档时立刻记住意图并点亮，800ms 内窗口没到位也自动收手 */
  function rememberSizeIntent(key: string): void {
    sizeIntent = key;
    sizeIntentAt = Date.now();
    if (sizeIntentTimer) window.clearTimeout(sizeIntentTimer);
    sizeIntentTimer = window.setTimeout(() => {
      sizeIntentTimer = 0;
      sizeIntent = "";
      updateSizeSeg();
    }, 800);
    updateSizeSeg();
  }

  /** resize 时检查 intent 是否已经达成；达成/超时就交还给实际宽度 */
  function syncSizeIntent(): void {
    if (sizeIntent) {
      const preset = SIZE_PRESETS.find((item) => item.key === sizeIntent);
      const width = noteEl.offsetWidth;
      const reached = preset ? Math.abs(preset.width - width) < 30 : true;
      if (!preset || reached || Date.now() - sizeIntentAt > 800) {
        clearSizeIntent();
      }
    }
    updateSizeSeg();
  }

  /** 菜单里两项的状态文案 */
  function updateMenuItems(): void {
    const collapseItem = menuPop.querySelector<HTMLElement>('[data-act="collapse"]');
    if (collapseItem) collapseItem.textContent = draft.collapsed ? "展开便签" : "收起便签";
    const lockItem = menuPop.querySelector<HTMLElement>('[data-act="lock"]');
    if (lockItem) lockItem.textContent = draft.locked ? "解锁便签" : "锁定便签";
  }

  /**
   * 锁定态：标题只读、正文不可编辑、待办不能勾/改/删；
   * 仍然可以拖动、换纸色、置顶——锁的是"内容"，不是便签本身。
   */
  function applyLocked(): void {
    const locked = !!draft.locked;
    noteEl.dataset.locked = locked ? "1" : "0";
    noteEl.dataset.editing = locked ? "0" : noteEl.dataset.editing;
    lockBadge.hidden = !locked;
    titleInput.readOnly = locked;
    if (editor) {
      if (locked) editor.contentEditable = "false";
      else if (!mdRendered) editor.contentEditable = "true";
    }
    if (todosEl) {
      todosEl.querySelectorAll<HTMLInputElement>("input.xm-todo__text").forEach((input) => {
        input.readOnly = locked;
        input.tabIndex = locked ? -1 : 0;
      });
      todosEl.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
        btn.disabled = locked;
      });
      // 锁定后拖拽排序被禁：手柄留着只会让人以为能拖，按下去还没反应，干脆收起来
      todosEl.querySelectorAll<HTMLElement>(".xm-todo__grip").forEach((grip) => {
        grip.hidden = locked;
      });
    }
    if (vaultEl) {
      // 锁定只锁"改内容"：复制（点行、复制全部）和看明文仍然可用
      vaultEl
        .querySelectorAll<HTMLButtonElement>('[data-act="vault-edit"], [data-act="vault-del"], [data-act="vault-add"]')
        .forEach((btn) => {
          btn.disabled = locked;
        });
      if (locked && vaultEditingId) {
        vaultEditingId = "";
        renderVault();
        applyLocked();
      }
    }
  }

  /** 收起 / 展开：窗口高度由后端改（apply_collapsed），这里只管纸面状态 */
  async function toggleCollapsed(next = !draft.collapsed): Promise<void> {
    if (next === draft.collapsed) return;
    const request = ++collapseRequest;
    const previous = draft.collapsed;
    closePopover();
    draft.collapsed = next;
    noteEl.dataset.collapsed = next ? "1" : "0";
    updateMenuItems();
    try {
      const saved = await queueWindowChange(() => {
        if (request !== collapseRequest) return Promise.resolve(null);
        return sizeFeel.run(() => api.setNoteCollapsed(draft.id, next), {
          width: draft.width ?? innerWidth,
          height: next ? 64 : draft.height ?? 380,
        });
      });
      if (!saved || request !== collapseRequest) return;
      // 只同步后端算出来的字段，别把草稿里还没保存的改动覆盖掉
      draft.collapsed = saved.collapsed;
      draft.updated_at = saved.updated_at;
      noteEl.dataset.collapsed = saved.collapsed ? "1" : "0";
    } catch (error) {
      console.error("收起便签失败", error);
      if (request !== collapseRequest) return;
      draft.collapsed = previous;
      noteEl.dataset.collapsed = draft.collapsed ? "1" : "0";
      toast("收起失败");
    } finally {
      if (request === collapseRequest) updateMenuItems();
    }
  }

  // ---------- 6. 滚动（取代分页/翻页） ----------
  /** 正文的滚动容器：memo / todo 用 .xm-sheet，随身笔记用 .xm-vault，只允许一层滚动 */
  const scrollEl = (sheetEl ?? vaultEl) as HTMLElement;

  /**
   * 把滚动状态写回便签根：
   *  - data-scroll = top / middle / bottom：视觉用它做纸边渐隐
   *  - is-scrollable：内容能不能滚；不能滚时两个都不写
   */
  function updateScrollState(): void {
    const canScroll = scrollEl.scrollHeight > scrollEl.clientHeight + 1;
    noteEl.classList.toggle("is-scrollable", canScroll);
    if (!canScroll) {
      delete noteEl.dataset.scroll;
      return;
    }
    const top = scrollEl.scrollTop;
    if (top <= 1) {
      noteEl.dataset.scroll = "top";
    } else if (top + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) {
      noteEl.dataset.scroll = "bottom";
    } else {
      noteEl.dataset.scroll = "middle";
    }
  }

  let scrollStateRaf = 0;
  /** 内容/尺寸变化后合并到下一帧再算，连续输入时不用每敲一下读一次布局 */
  function scheduleScrollState(): void {
    if (scrollStateRaf) return;
    scrollStateRaf = requestAnimationFrame( () => {
      scrollStateRaf = 0;
      updateScrollState();
    });
  }

  scrollEl.addEventListener("scroll", scheduleScrollState, { passive: true });

  /** 当前阅读位置的比例（0 = 顶部，1 = 底部） */
  function scrollRatio(): number {
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    return max > 1 ? scrollEl.scrollTop / max : 0;
  }

  /** 内容高度变了以后按比例回到原处（Markdown 排版 ↔ 原文来回切时用） */
  function restoreScrollRatio(ratio: number): void {
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (max > 1) scrollEl.scrollTop = clamp(ratio, 0, 1) * max;
    updateScrollState();
  }

  /** 让某一行滚进视野（原生 block:"nearest"，只滚最少距离，不做整页跳） */
  function revealRow(row: HTMLElement): void {
    row.scrollIntoView({ block: "nearest" });
  }

  /** 光标不在视野里时，才用最少距离把它滚进来（优先保持阅读位置） */
  function ensureCaretVisible(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || rect.height === 0) return;
    const box = scrollEl.getBoundingClientRect();
    if (rect.top >= box.top + 4 && rect.bottom <= box.bottom - 4) return;
    if (rect.top < box.top) scrollEl.scrollTop -= box.top - rect.top + 8;
    else scrollEl.scrollTop += rect.bottom - box.bottom + 8;
    updateScrollState();
  }

  /** 当前正文元素（memo = 编辑器，todo = 列表），启动时给 ResizeObserver 用 */
  function contentEl(): HTMLElement | null {
    if (draft.kind === "memo") return editor;
    if (draft.kind === "todo") return todosEl;
    return vaultEl;
  }

  // ---------- 8. 交互：正文 / 标题 ----------
  function setEditing(on: boolean): void {
    noteEl.dataset.editing = on ? "1" : "0";
  }

  function focusEditor(caretAtEnd = true): void {
    if (draft.locked) return; // 锁定便签不给落光标
    if (draft.kind === "vault") return; // 随身笔记没有整块正文可写
    if (draft.kind === "memo") {
      if (!editor) return;
      // 排版态下要写字：先退回原文，再落光标
      if (mdRendered) {
        editMarkdown(undefined);
        setEditing(true);
        return;
      }
      editor.focus();
      if (caretAtEnd) {
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    } else {
      const input = newRowInput();
      if (!input) return;
      // 待办模式点空白处：优先聚焦最后一条待办的输入框，没有就聚焦新增行
      const lastText = todosEl?.querySelector<HTMLInputElement>('li.xm-todo:not(.xm-todo--new) .xm-todo__text:last-of-type');
      (lastText && document.hasFocus() ? lastText : input).focus();
    }
  }

  // ---------- 8.5 Markdown 排版（写的时候看原文，失焦后看排版） ----------

  /** 能不能排版：只有 memo 便签 + 设置里开着 Markdown 排版 */
  function mdEnabled(): boolean {
    return draft.kind === "memo" && !!editor && settings.markdown_enabled !== false;
  }

  /** 把正文排成纸面（只读）。空内容不排，留给 :empty::before 的占位提示 */
  function renderMarkdown(): void {
    if (!editor || !mdEnabled() || mdIsEmpty(draft.content)) return;
    // 排版前后内容高度不一样：先记比例，排完按比例回到原处
    const ratio = scrollRatio();
    editor.innerHTML = mdToHtml(draft.content);
    editor.dataset.md = "1";
    editor.contentEditable = "false";
    noteEl.dataset.mdRendered = "1";
    mdRendered = true;
    lastRendered = draft.content;
    restoreScrollRatio(ratio);
  }

  /** 退回原文编辑态。line 是点击块对应的源码行号（0 起），不给就放末尾 */
  function editMarkdown(line?: number, focus = true): void {
    if (!editor) return;
    const ratio = scrollRatio();
    // 原文从 draft 来，不从 DOM 读——渲染态的文字不是用户写的那份
    editor.textContent = draft.content;
    editor.dataset.md = "0";
    editor.contentEditable = "true";
    noteEl.dataset.mdRendered = "0";
    mdRendered = false;
    restoreScrollRatio(ratio);
    if (focus) {
      editor.focus();
      placeCaretAtSourceLine(line);
      // 浏览器会为了"聚焦/放光标"自己改滚动位置（源码比排版长，视觉上会跳）；
      // 这里重新按比例回到原处，只有光标真的不在视野里才滚到光标（最少距离）。
      restoreScrollRatio(ratio);
      ensureCaretVisible();
    }
  }

  /** 源码第 line 行行尾在全文里的字符下标 */
  function sourceLineEnd(line: number): number {
    const lines = draft.content.split("\n");
    const target = clamp(line, 0, Math.max(0, lines.length - 1));
    let offset = 0;
    for (let i = 0; i < target; i += 1) offset += lines[i].length + 1;
    return offset + lines[target].length;
  }

  /** 把光标放到源码第 line 行行尾（不给行号就放全文末尾） */
  function placeCaretAtSourceLine(line?: number): void {
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    if (typeof line !== "number" || !Number.isFinite(line)) {
      range.selectNodeContents(editor);
      range.collapse(false);
    } else {
      const offset = sourceLineEnd(line);
      // 原文是纯文本，正常只有一个文本节点；用 TreeWalker 兜住极端情况
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node: Text | null = null;
      let acc = 0;
      while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        if (offset <= acc + text.data.length) {
          node = text;
          break;
        }
        acc += text.data.length;
      }
      if (node) {
        range.setStart(node, clamp(offset - acc, 0, node.data.length));
        range.collapse(true);
      } else {
        range.selectNodeContents(editor);
        range.collapse(false);
      }
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** 渲染态单击：找到点中块对应的源码行，退回编辑并把光标放那一行行尾 */
  function restoreFromClick(x: number, y: number): void {
    let line: number | undefined;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const caret = doc.caretRangeFromPoint?.(x, y);
    const pointed: Node | null = caret ? caret.startContainer : document.elementFromPoint(x, y);
    const el: Element | null = pointed
      ? pointed.nodeType === Node.ELEMENT_NODE
        ? (pointed as Element)
        : pointed.parentElement
      : null;
    const block = el?.closest<HTMLElement>("[data-md-line]");
    if (block) {
      const parsed = Number(block.dataset.mdLine);
      if (Number.isFinite(parsed)) line = parsed;
    }
    editMarkdown(line);
    setEditing(true);
  }

  if (editor) {
    // 输入：标脏 + 0.8s 自动保存 + 重算滚动状态
    editor.addEventListener("input", () => {
      markDirty();
      scheduleSave();
      scheduleScrollState();
    });
    editor.addEventListener("focus", () => {
      if (draft.locked) {
        editor?.blur();
        return;
      }
      setEditing(true);
    });
    editor.addEventListener("blur", () => {
      setEditing(false);
      // 先把最新文字收进 draft（排版读的是草稿，不是 DOM），再保存、再排版
      if (!mdRendered) collect();
      if (dirty) void saveNote(false);
      if (mdEnabled()) renderMarkdown();
    });
    // 排版态下点正文 = 回到原文编辑，并把光标放到点到的那一行
    editor.addEventListener("click", (event) => {
      if (draft.locked || !mdRendered) return;
      event.preventDefault();
      event.stopPropagation();
      restoreFromClick(event.clientX, event.clientY);
    });
    // 粘贴一律当纯文本，避免把网页样式带进便签
    editor.addEventListener("paste", (event) => {
      const clipboard = (event as ClipboardEvent).clipboardData;
      if (!clipboard) return;
      event.preventDefault();
      document.execCommand("insertText", false, clipboard.getData("text/plain"));
      markDirty();
      scheduleSave();
      scheduleScrollState();
    });
  }

  titleInput.addEventListener("focus", () => {
    if (draft.locked) titleInput.blur();
  });
  titleInput.addEventListener("input", () => {
    draft.title = titleInput.value;
    markDirty();
    scheduleSave();
  });
  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      focusEditor(true);
    }
  });
  titleInput.addEventListener("blur", () => {
    if (dirty) void saveNote(false);
  });

  // 点击纸面任意空白处 = 进入编辑（"点开就能写"）
  bodyEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, .xm-todo, .xm-pop")) return;
    if (draft.kind === "vault") return; // 随身笔记点行是复制，不落光标
    if (draft.locked) return; // 锁定便签点纸面不进入编辑
    // 排版态点纸面空白：退回原文编辑（点在正文上的情况由 editor 自己的 click 处理）
    if (draft.kind === "memo" && mdRendered) {
      editMarkdown();
      setEditing(true);
      return;
    }
    if (draft.kind === "memo" && document.activeElement === editor) return;
    focusEditor(true);
    setEditing(true);
  });

  // 窗口重新拿到焦点时，要不要把光标放进正文？
  // 只有"空白便签"才自动放（新建后抬笔就能写）；
  // 有内容的便签（比如首启的欢迎便签）不抢光标——用户还没打算写，先让他看见内容。
  let interacted = false;
  window.addEventListener("pointerdown", () => {
    interacted = true;
  }, true);
  window.addEventListener("focus", () => {
    if (interacted) return;
    if (draft.kind !== "memo" || !editor) return;
    if (draft.title.trim() || draft.content.trim()) return;
    const active = document.activeElement;
    if (active && root.contains(active) && active !== document.body) return;
    focusEditor(true);
  });

  // 双击标题条空白处 = 收起 / 展开（契约 §13.2）
  headEl.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, .xm-pop")) return;
    event.preventDefault();
    void toggleCollapsed();
  });

  // 右上角图标是"按一下"的东西：按下事件不要再冒到拖动区/正文（用户 m03078）
  toolsEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  // ---------- 9. 交互：置顶 / 提醒 / 更多 ----------
  pinBtn.addEventListener("click", async () => {
    draft.pinned = !draft.pinned;
    noteEl.dataset.pinned = draft.pinned ? "1" : "0";
    updatePinButton();
    try {
      await api.setPinned(draft.id, draft.pinned);
      toast(draft.pinned ? "已置顶 · 永远在最上层" : "已取消置顶");
    } catch (error) {
      console.error("置顶失败", error);
      // 存失败就把按钮状态拨回去，别让用户以为已经置顶了
      draft.pinned = !draft.pinned;
      noteEl.dataset.pinned = draft.pinned ? "1" : "0";
      updatePinButton();
      toast("置顶失败");
    }
  });

  // 打开面板：便签不关，面板由后端唤起（浏览器 mock 里会跳到面板页）
  panelBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePopover();
    void (async () => {
      try {
        await api.openPanel();
      } catch (error) {
        console.error("打开面板失败", error);
        toast("打不开面板");
      }
    })();
  });

  let openPop: "remind" | "menu" | "due" | null = null;
  /** 截止时间弹层当前在改哪一条待办 */
  let dueTargetId = "";

  function closePopover(): void {
    if (openPop === "remind") remindPop.hidden = true;
    if (openPop === "menu") menuPop.hidden = true;
    if (openPop === "due") duePop.hidden = true;
    openPop = null;
  }
  function togglePopover(name: "remind" | "menu"): void {
    if (openPop === name) {
      closePopover();
      return;
    }
    closePopover();
    openPop = name;
    if (name === "remind") {
      remindPop.hidden = false;
      remindField.value = toDateTimeLocalValue(draft.reminder_at ?? Date.now() + 60 * 60 * 1000);
      remindAutoValue = remindField.value;
      remindTouched = false;
      updateRepeatButtons();
    } else {
      menuPop.hidden = false;
      updateColorDots();
      updateScaleSeg();
    }
  }
  remindBtn.addEventListener("click", () => togglePopover("remind"));
  menuBtn.addEventListener("click", () => togglePopover("menu"));

  // 收起态只留这一颗"展开"按钮：点一下直接展开，不弹菜单。
  // （收起后窗口只有一行高，任何弹层都会被窗口边界裁掉，菜单里塞滚动条更难看。）
  expandBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    void toggleCollapsed(false);
  });

  // 收起态：点纸面任何地方（按钮除外）就展开。
  // 收起后只剩一条标题，用户第一反应是"点它"——不点这个，他根本找不到"展开便签"在哪。
  noteEl.addEventListener("click", (event) => {
    if (!draft.collapsed) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest("button, .xm-pop, [data-pop]")) return;
    event.preventDefault();
    void toggleCollapsed(false);
  });

  /** 重复选项的选中态（空串 = 不重复） */
  function updateRepeatButtons(): void {
    remindPop.querySelectorAll<HTMLElement>("[data-repeat]").forEach((btn) => {
      const on = (btn.dataset.repeat ?? "") === (draft.repeat ?? "");
      btn.dataset.active = on ? "1" : "0";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  /**
   * 重复提醒要有起点：后端 save_note 会把没有 reminder_at 的 repeat 清掉，
   * 所以选重复时如果还没设时间，就自动补一个（用户填的未来时间优先，否则明天 9:00）。
   */
  function repeatStartAt(typedAt: number | null, fieldEdited: boolean): number {
    if (fieldEdited && typedAt && typedAt > Date.now()) return typedAt;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow.getTime();
  }

  /** 保存重复提醒：只改 repeat；没时间时补起点，其余字段先读后端最新值再回传 */
  let repeatQueue: Promise<void> = Promise.resolve();
  function saveRepeat(repeat: string): void {
    draft.repeat = repeat;
    updateRepeatButtons();
    // 点击这一刻的时间框状态先记下来：getSnapshot 有延迟，期间弹层可能被重开
    const typedValue = remindField.value;
    const fieldEdited = remindTouched || (typedValue !== "" && typedValue !== remindAutoValue);
    const typedAt = fromDateTimeLocalValue(typedValue);
    repeatQueue = repeatQueue.then(async () => {
      try {
        const snapshot = await api.getSnapshot();
        const fresh = snapshot.notes.find((n) => n.id === draft.id);
        if (fresh) {
          draft.reminder_at = fresh.reminder_at;
          draft.reminder_done = fresh.reminder_done;
        }
        // 重复必须有起点：还没有提醒时间就自动设一个，并在 toast 里说清楚
        let startAt: number | null = null;
        if (repeat && draft.reminder_at == null) {
          startAt = repeatStartAt(typedAt, fieldEdited);
          draft.reminder_at = startAt;
          draft.reminder_done = false;
          remindField.value = toDateTimeLocalValue(startAt);
          remindAutoValue = remindField.value;
          remindTouched = false;
          remindBtn.dataset.active = "1";
        }
        draft.repeat = repeat;
        markDirty();
        await saveNote(false);
        if (!repeat) toast("已设为不重复");
        else if (startAt) toast(repeatLabel(repeat) + " · " + reminderLabel(startAt) + " 起");
        else toast("重复：" + repeatLabel(repeat));
      } catch (error) {
        console.error("保存重复提醒失败", error);
        toast("保存失败");
      }
    });
  }

  /** 打开某条待办的截止时间弹层（贴着这一行显示；靠近底边时向上翻） */
  function openDuePop(item: TodoItem, button: HTMLElement): void {
    if (openPop === "due" && dueTargetId === item.id) {
      closePopover();
      return;
    }
    closePopover();
    dueTargetId = item.id;
    openPop = "due";
    dueField.value = item.due_at ? toDateTimeLocalValue(item.due_at) : "";
    duePop.hidden = false;
    duePop.style.right = "auto";
    duePop.style.left = "0px";
    duePop.style.top = "0px";
    // 用按钮和纸面的包围盒换算成纸内坐标（便签本身有轻微旋转，这里取近似值足够）
    const btnRect = button.getBoundingClientRect();
    const paperRect = paperEl.getBoundingClientRect();
    const popW = duePop.offsetWidth || 214;
    const popH = duePop.offsetHeight || 196;
    let left = btnRect.right - paperRect.left - popW;
    left = clamp(left, 8, Math.max(8, paperEl.clientWidth - popW - 8));
    let top = btnRect.bottom - paperRect.top + 6;
    if (top + popH > paperEl.clientHeight - 8) {
      top = btnRect.top - paperRect.top - popH - 6;
    }
    top = clamp(top, 8, Math.max(8, paperEl.clientHeight - popH - 8));
    duePop.style.left = Math.round(left) + "px";
    duePop.style.top = Math.round(top) + "px";
  }

  /** 把截止时间写进草稿并立即保存（不刷新整张列表，避免输入框失焦） */
  function applyDue(ts: number | null): void {
    const id = dueTargetId;
    const item = draft.todos.find((t) => t.id === id);
    closePopover();
    if (!item) return;
    item.due_at = ts;
    const row = todosEl?.querySelector<HTMLElement>('.xm-todo[data-id="' + id + '"]');
    const btn = row?.querySelector<HTMLElement>(".xm-todo__due");
    if (btn) updateDueButton(btn, item);
    markDirty();
    void saveNote(false);
    toast(ts ? "截止：" + dueShortLabel(ts) : "已清除截止");
  }

  duePop.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const quick = target.closest<HTMLElement>("[data-due]");
    if (quick) {
      const kind = quick.dataset.due;
      const d = new Date();
      if (kind === "today") {
        d.setHours(18, 0, 0, 0);
      } else if (kind === "tomorrow") {
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
      } else {
        d.setDate(d.getDate() + 2);
        d.setHours(9, 0, 0, 0);
      }
      applyDue(d.getTime());
      return;
    }
    if (target.closest('[data-act="due-set"]')) {
      const ts = fromDateTimeLocalValue(dueField.value);
      if (!ts) {
        toast("先选时间");
        return;
      }
      applyDue(ts);
      return;
    }
    if (target.closest('[data-act="due-clear"]')) applyDue(null);
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!openPop) return;
      const target = event.target as HTMLElement;
      if (target.closest(".xm-pop")) return;
      if (target.closest('[data-act="remind"], [data-act="menu"], .xm-todo__due')) return;
      closePopover();
    },
    true,
  );

  async function setReminderAt(ts: number): Promise<void> {
    try {
      await api.setReminder(draft.id, ts);
      draft.reminder_at = ts;
      draft.reminder_done = false;
      remindBtn.dataset.active = "1";
      closePopover();
      toast("提醒 " + clockTime(ts));
    } catch (error) {
      console.error("设置提醒失败", error);
      toast("设置失败");
    }
  }

  remindPop.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const repeatBtn = target.closest<HTMLElement>("[data-repeat]");
    if (repeatBtn) {
      const value = repeatBtn.dataset.repeat ?? "";
      if ((draft.repeat ?? "") !== value) saveRepeat(value);
      return;
    }
    const quick = target.closest<HTMLElement>("[data-quick]");
    if (quick) {
      const kind = quick.dataset.quick;
      let ts = Date.now();
      if (kind === "10") ts += 10 * 60_000;
      else if (kind === "60") ts += 60 * 60_000;
      else {
        // 明天 9:00
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        ts = tomorrow.getTime();
      }
      void setReminderAt(ts);
      return;
    }
    if (target.closest('[data-act="remind-set"]')) {
      const ts = fromDateTimeLocalValue(remindField.value);
      if (!ts) {
        toast("先选时间");
        return;
      }
      void setReminderAt(ts);
    }
    if (target.closest('[data-act="remind-clear"]')) {
      void (async () => {
        try {
          await api.setReminder(draft.id, null);
          draft.reminder_at = null;
          draft.reminder_done = false;
          // 清除提醒时重复也一起清掉，免得下次设提醒还沿用旧重复（契约 §12.3）
          draft.repeat = "";
          updateRepeatButtons();
          remindBtn.dataset.active = "0";
          markDirty();
          await saveNote(false);
          closePopover();
          toast("已清除提醒");
        } catch (error) {
          console.error("清除提醒失败", error);
        }
      })();
    }
  });

  /** 换纸色时的交叉淡入（M4）：先盖一层旧色，切 data-color，再让覆盖层 200ms 淡出 */
  function fadePaperColor(next: Color): void {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      try {
        const computed = getComputedStyle(paperEl);
        const names = ["--xm-paper-a", "--xm-paper-b", "--xm-paper-c", "--xm-paper-d"];
        const oldColors = names.map((name) => computed.getPropertyValue(name).trim());
        // 连点时只保留最后一层，避免叠一堆覆盖层
        paperEl.querySelectorAll(".xm-colorfade").forEach((node) => node.remove());
        const overlay = document.createElement("div");
        overlay.className = "xm-colorfade";
        names.forEach((name, index) => overlay.style.setProperty(name, oldColors[index]));
        overlay.style.pointerEvents = "none";
        overlay.style.opacity = "1";
        paperEl.appendChild(overlay);
        void overlay.offsetWidth; // 强制一次布局，让浏览器记住起始透明度
        overlay.style.transition = "opacity 200ms ease-out";
        overlay.style.opacity = "0";
        window.setTimeout(() => overlay.remove(), 240);
      } catch (error) {
        console.error("换色过渡失败", error);
      }
    }
    draft.color = next;
    noteEl.dataset.color = next;
  }

  /**
   * 打开面板并切到这张便签的修改记录（task-28）。
   * 顺序很重要：先写 localStorage 请求 → 再 openPanel → 成功后才广播。
   * 后端 openPanel 会派发 xm-panel-open，面板收到时会先看这条请求；
   * 如果先广播再 openPanel，面板会先被重置回列表，看起来就是「一闪回列表」。
   */
  function openHistoryView(): void {
    closePopover();
    const noteId = draft.id;
    try {
      localStorage.setItem("xm-history-request", JSON.stringify({ noteId, ts: Date.now() }));
    } catch {
      /* localStorage 不可用时只能靠广播，广播失败就只剩打开面板 */
    }
    void api
      .openPanel()
      .then(() => {
        try {
          const channel = new BroadcastChannel("xm-history");
          channel.postMessage({ noteId });
          channel.close();
        } catch {
          /* 浏览器不支持 BroadcastChannel：面板启动时会读 localStorage 请求 */
        }
      })
      .catch((error) => {
        console.error("打开面板失败", error);
        toast("打不开面板");
      });
  }

  menuPop.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-act="history"]')) {
      openHistoryView();
      return;
    }
    const colorDot = target.closest<HTMLElement>(".xm-color-dot");
    if (colorDot?.dataset.color) {
      const next = colorDot.dataset.color as Color;
      if (draft.color !== next) fadePaperColor(next);
      updateColorDots();
      markDirty();
      void saveNote(false);
      return;
    }
    const sizeItem = target.closest<HTMLElement>(".xm-seg__item[data-size]");
    if (sizeItem?.dataset.size) {
      sizeFeel.press(sizeItem);
      const preset = SIZE_PRESETS.find((p) => p.key === sizeItem.dataset.size);
      if (preset) {
        const request = ++sizeRequest;
        const previous = { width: draft.width, height: draft.height };
        draft.width = preset.width;
        draft.height = preset.height;
        // 队列中已被后续点击取代的目标不再调用后端；运行中的提交由后端合并最新目标。
        void queueWindowChange(() => {
          if (request !== sizeRequest) return Promise.resolve(null);
          return sizeFeel.run(() => api.setNoteSize(draft.id, preset.width, preset.height), preset);
        })
          .then((saved) => {
            if (!saved || request !== sizeRequest) return;
            draft.width = saved.width;
            draft.height = saved.height;
            draft.updated_at = saved.updated_at;
          })
          .catch((error) => {
            console.error("调整便签大小失败", error);
            if (request !== sizeRequest) return;
            draft.width = previous.width;
            draft.height = previous.height;
            clearSizeIntent();
            updateSizeSeg();
            toast("大小没能改好，请再试一次");
          });
        // 高亮立刻跟手；实际宽度到位或 800ms 超时后自动回到实测值
        rememberSizeIntent(preset.key);
        scheduleScrollState();
      }
      return;
    }
    const scaleItem = target.closest<HTMLElement>(".xm-seg__item");
    if (scaleItem?.dataset.scale) {
      draft.font_scale = Number(scaleItem.dataset.scale);
      noteEl.style.setProperty("--xm-font-scale", String(draft.font_scale));
      updateScaleSeg();
      markDirty();
      void saveNote(false);
      scheduleScrollState();
      return;
    }
    if (target.closest('[data-act="collapse"]')) {
      void toggleCollapsed();
      return;
    }
    if (target.closest('[data-act="lock"]')) {
      // 走专用命令落库：save_note 会"后端说了算"地保住旧的 locked，拿它改不动
      const next = !draft.locked;
      draft.locked = next;
      applyLocked();
      updateMenuItems();
      closePopover();
      toast(next ? "已锁定 · 只能拖动" : "已解锁");
      void (async () => {
        try {
          const saved = await api.setNoteLocked(draft.id, next);
          draft.locked = saved.locked;
          draft.updated_at = saved.updated_at;
          applyLocked();
        } catch (error) {
          console.error("锁定便签失败", error);
          draft.locked = !next;
          applyLocked();
          toast("锁定失败");
        } finally {
          updateMenuItems();
        }
      })();
      return;
    }
    if (target.closest('[data-act="delete"]')) {
      const btn = target.closest<HTMLButtonElement>('[data-act="delete"]');
      if (!btn) return;
      if (btn.dataset.confirm !== "1") {
        // 两步确认，避免误删（比系统 confirm 更像便签本身）
        btn.dataset.confirm = "1";
        btn.textContent = "确认删除？";
        window.setTimeout(() => {
          if (btn.isConnected) {
            delete btn.dataset.confirm;
            btn.textContent = "删除便签";
          }
        }, 3000);
        return;
      }
      void (async () => {
        try {
          collect();
          await api.deleteNote(draft.id);
          // 删除成功后才写撤销记录：写早了删除失败会留下"撤销一张还在的便签"的脏记录（task-45）。
          // 便签窗口随后会被销毁、toast 看不到，这条 5 秒记录是给面板用的。
          publishUndo(draft);
          await closeCurrent();
        } catch (error) {
          console.error("删除便签失败", error);
          // 失败时可能已经写进去（旧写法是先 publish 后删），统一清掉，面板就不会弹出撤销
          clearUndo(draft.id);
          toast("删除失败");
        }
      })();
      return;
    }
    if (target.closest('[data-act="close"]')) {
      void (async () => {
        if (dirty) await saveNote(false);
        await closeCurrent();
      })();
    }
  });

  // ---------- 10. 窗口拖动 / 尺寸位置保存 ----------
  dragEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); // 避免拖动时选中文字
    void startDragging();
  });

  void watchWindowState((state) => {
    // 收起态窗口只有 64px 高，这是折叠形态、不是便签该记住的高度：
    // 存下去的话展开时会按 64 还原，便签就卡成一条矮条。收起期间不写位置/尺寸。
    if (draft.collapsed) return;
    // 动画期间宽高是否可写由后端状态决定，不用固定毫秒数猜动画是否结束。
    void api.saveWindowState(draft.id, state);
  });

  // 关闭窗口前确保内容落库（Tauri 会先拦下 close，存完再关）
  if (isTauri()) {
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.onCloseRequested(async (event) => {
        if (draft.kind === "vault" && vaultEditingId) commitVaultEdit();
        if (!dirty) return;
        event.preventDefault();
        await saveNote(false);
        await win.close();
      });
    })();
  }
  window.addEventListener("beforeunload", () => {
    // 正在改的随身笔记条目先收进 draft，否则关窗就丢了
    if (draft.kind === "vault" && vaultEditingId) commitVaultEdit();
    if (!dirty) return;
    collect();
    void api.saveNote({ ...draft, updated_at: Date.now() });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    if (draft.kind === "vault" && vaultEditingId) commitVaultEdit();
    if (dirty) void saveNote(false);
  });

  // ---------- 11. 全局键盘 ----------
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    // 随身笔记正在改某一条：回车存下、Esc 取消，交给输入框自己处理
    if (draft.kind === "vault" && vaultEditingId) {
      if (event.key === "Enter") {
        event.preventDefault();
        commitVaultEdit();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelVaultEdit();
        return;
      }
    }
    // Ctrl+S 保存
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      // 正在改随身笔记条目：先把输入框里的内容收进来，再一起存
      if (draft.kind === "vault" && vaultEditingId) commitVaultEdit();
      // 没有改动也给个反馈：用户按了保存，就该看到"已保存"
      if (!dirty || saving) toast("已保存");
      else void saveNote(true);
      return;
    }
    if (event.key === "Escape") {
      if (openPop) {
        closePopover();
        return;
      }
      if (document.activeElement === titleInput) titleInput.blur();
      if (draft.kind === "memo" && document.activeElement === editor) editor?.blur();
      return;
    }
  });

  // ---------- 12. 待办列表事件（事件委托） ----------
  if (todosEl) {
    todosEl.addEventListener("click", (event) => {
      // 锁定的便签只读：按钮本身是 disabled，这里再兜一层（键盘/合成事件也进不来）
      if (draft.locked) return;
      const target = event.target as HTMLElement;
      const li = target.closest<HTMLElement>(".xm-todo");
      if (!li || li.classList.contains("xm-todo--new")) return;
      const item = draft.todos.find((t) => t.id === li.dataset.id);
      if (!item) return;
      if (target.closest(".xm-todo__due")) {
        // 点小钟表：打开“截止时间”弹层（今天 / 明天 / 后天 / 自定义）
        const dueBtn = target.closest<HTMLElement>(".xm-todo__due");
        if (dueBtn) openDuePop(item, dueBtn);
        return;
      }
      if (target.closest(".xm-todo__check")) {
        item.done = !item.done;
        li.dataset.done = item.done ? "1" : "0";
        const check = li.querySelector<HTMLElement>(".xm-todo__check");
        if (check) check.setAttribute("aria-label", item.done ? "标记未完成" : "标记完成");
        if (item.done) playCheckSound(settings.play_sound);
        markDirty();
        updateMeta();
        void saveNote(false); // 勾选立即落库，不等防抖
      } else if (target.closest(".xm-todo__del")) {
        draft.todos = draft.todos.filter((t) => t.id !== item.id);
        draft.todos.forEach((t, index) => {
          t.order = index;
        });
        li.remove();
        markDirty();
        updateMeta();
        scheduleScrollState();
        void saveNote(false);
      }
    });

    todosEl.addEventListener("input", (event) => {
      if (draft.locked) return;
      const input = event.target as HTMLInputElement;
      if (!input.classList.contains("xm-todo__text")) return;
      const li = input.closest<HTMLElement>(".xm-todo");
      if (!li || li.classList.contains("xm-todo--new")) return; // 新增行是草稿，回车/失焦才入库
      const item = draft.todos.find((t) => t.id === li.dataset.id);
      if (!item) return;
      item.text = input.value;
      markDirty();
      scheduleSave();
      scheduleScrollState();
    });

    todosEl.addEventListener("keydown", (event) => {
      // 只读输入框仍会收到 Enter/Backspace：不加这道守卫，锁定后还能新增/删除待办
      if (draft.locked) return;
      const input = event.target as HTMLInputElement;
      if (!input.classList.contains("xm-todo__text")) return;
      const li = input.closest<HTMLElement>(".xm-todo");
      if (!li) return;
      const isNew = li.classList.contains("xm-todo--new");
      // Alt+↑ / Alt+↓：与相邻行交换顺序（契约 §16.3）；新增草稿行不参与
      if (
        !isNew &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        swapTodoRow(li, event.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (isNew) {
          commitNewRow(input, true);
        } else {
          insertTodoAfter(li.dataset.id ?? "");
        }
        return;
      }
      if (event.key === "Backspace" && input.value === "" && !isNew) {
        event.preventDefault();
        removeTodoRow(li);
      }
    });

    // 新增行失焦：有内容就落成一条正式待办
    todosEl.addEventListener("focusout", (event) => {
      const input = event.target as HTMLInputElement;
      if (!input.classList.contains("xm-todo__text")) return;
      const li = input.closest<HTMLElement>(".xm-todo");
      if (!li || !li.classList.contains("xm-todo--new")) return;
      window.setTimeout(() => {
        if (document.activeElement !== input) commitNewRow(input, false);
      }, 120);
    });

    todosEl.addEventListener("focusin", (event) => {
      const target = event.target as HTMLElement;
      if (target.classList.contains("xm-todo__text")) {
        const row = target.closest<HTMLElement>(".xm-todo");
        if (row) revealRow(row);
      }
      if (!draft.locked) noteEl.dataset.editing = "1";
    });
    todosEl.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!root.contains(document.activeElement)) noteEl.dataset.editing = "0";
      }, 0);
    });

    // 待办拖拽排序（契约 §16.3）：pointerdown 只"预备"，移动超过 4px 才真的开始拖。
    // 这样点勾选框、点截止时间、点删除都不会被拖走。
    todosEl.addEventListener("pointerdown", (event) => {
      if (draft.locked) return; // 锁定便签只能看不能改，顺序也不给动
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      const row = target.closest<HTMLElement>(".xm-todo");
      if (!row) return;
      if (row.classList.contains("xm-todo--new")) {
        // 新增行的手柄只是对齐用的占位：按它就把光标送进这行的输入框，别留一块死区
        if (target.closest(".xm-todo__grip")) {
          event.preventDefault();
          row.querySelector<HTMLInputElement>(".xm-todo__text")?.focus();
        }
        return;
      }
      // 手柄：这是专门用来"抓住一行"的地方，按下就直接预备拖拽，
      // 不受下面"check/text 内不触发"的限制。
      if (target.closest(".xm-todo__grip")) {
        event.preventDefault(); // 别让浏览器顺手选中文字/聚焦正文（触摸时也别原生滚动打断）
        armTodoDrag(row, event);
        return;
      }
      // 勾选框与文字输入是"按一下就要生效"的地方，从它们上面按下不进入拖拽
      if (target.closest(".xm-todo__check, .xm-todo__text")) return;
      armTodoDrag(row, event);
    });

    // 拖完松手浏览器还会补发一次 click，可能正好落在勾选/删除/截止按钮上：
    // 在捕获阶段吃掉它，拖动不该顺手勾掉一条待办。
    todosEl.addEventListener(
      "click",
      (event) => {
        if (!swallowTodoClick) return;
        swallowTodoClick = false;
        window.clearTimeout(swallowClickTimer);
        swallowClickTimer = 0;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
  }

  // ---------- 12.5 待办拖拽排序 / Alt+↑↓ 换行（契约 §16.3） ----------
  /**
   * 一次拖拽的运行时状态。
   * 鼠标、触屏、笔统一走 pointer 事件，所以只认 pointerId，不区分设备。
   */
  interface TodoDragState {
    /** 正在拖的那一行（待办 id） */
    id: string;
    pointerId: number;
    /** 按下时的坐标：用来判断有没有移动超过阈值 */
    startX: number;
    startY: number;
    /** 最近一次指针位置：松手落点、边缘自动滚动都用它 */
    lastX: number;
    lastY: number;
    /** 是否已经越过 4px 阈值（false = 这还只是一次普通点击） */
    active: boolean;
    /** 当前落点：落在哪一行上、落在它上边(before)还是下边(after) */
    dropId: string;
    dropPlace: "before" | "after";
    /** 拖到列表上下边缘时自动滚动用的 rAF 句柄 */
    raf: number;
  }
  /** 位移阈值（px）：小于它算点击，大于它才算拖拽，避免误触 */
  const DRAG_THRESHOLD = 4;
  let todoDrag: TodoDragState | null = null;
  /** 拖拽期间被推迟的那次重画（见 renderTodos 顶部的守卫） */
  let todosRenderDeferred = false;
  /** 拖拽松手后要吃掉随之补发的那一次 click */
  let swallowTodoClick = false;
  let swallowClickTimer = 0;

  /** 纸面上的待办行（不含「＋ 新待办」草稿行），顺序 = 用户看到的顺序 */
  function todoRows(): HTMLElement[] {
    return todosEl
      ? Array.from(todosEl.querySelectorAll<HTMLElement>("li.xm-todo:not(.xm-todo--new)"))
      : [];
  }

  function todoRowById(id: string): HTMLElement | null {
    if (!todosEl || !id) return null;
    return todosEl.querySelector<HTMLElement>('li.xm-todo[data-id="' + id + '"]');
  }

  /**
   * 按给定的 id 顺序重排 draft.todos 并重写 order（落库的就是这份顺序）。
   * 顺序从纸面 DOM 数出来，不用数组下标猜：插入、删除、拖拽之后，
   * draft.todos 的下标不一定等于视觉顺序。
   */
  function reorderTodos(ids: string[]): void {
    const byId = new Map<string, TodoItem>();
    draft.todos.forEach((item) => byId.set(item.id, item));
    const next: TodoItem[] = [];
    ids.forEach((id) => {
      const item = byId.get(id);
      if (item) {
        next.push(item);
        byId.delete(id);
      }
    });
    // 兜住没在纸面上出现的条目（理论上不会有），别把数据丢掉
    byId.forEach((item) => next.push(item));
    next.forEach((item, index) => {
      item.order = index;
    });
    draft.todos = next;
  }

  /**
   * 指针现在该落在哪里：按每一行的中线判断插入点。
   * 指针还在自己那一行里时算出来的插入点就是原处，松手不会白改一次顺序。
   */
  function dropTargetAt(clientY: number): { id: string; place: "before" | "after" } | null {
    const draggedId = todoDrag?.id ?? "";
    const rest = todoRows().filter((row) => row.dataset.id !== draggedId);
    if (rest.length === 0) return null;
    let index = 0;
    rest.forEach((row) => {
      const rect = row.getBoundingClientRect();
      if (clientY > rect.top + rect.height / 2) index += 1;
    });
    if (index >= rest.length) {
      const last = rest[rest.length - 1];
      return { id: last.dataset.id ?? "", place: "after" };
    }
    return { id: rest[index].dataset.id ?? "", place: "before" };
  }

  /** 画落点指示：落点行 .xm-todo[data-drop="before|after"]（2px 指示线样式在 paper.css） */
  function paintDropMark(target: { id: string; place: "before" | "after" } | null): void {
    if (!todoDrag) return;
    const id = target?.id ?? "";
    const place = target?.place ?? "";
    if (todoDrag.dropId === id && todoDrag.dropPlace === place) return;
    const previousId = todoDrag.dropId;
    todoDrag.dropId = id;
    todoDrag.dropPlace = place === "after" ? "after" : "before";
    if (previousId && previousId !== id) {
      const old = todoRowById(previousId);
      if (old) delete old.dataset.drop;
    }
    if (!id) return;
    const row = todoRowById(id);
    if (row) row.dataset.drop = todoDrag.dropPlace;
  }

  function updateDropMark(): void {
    if (!todoDrag || !todoDrag.active) return;
    paintDropMark(dropTargetAt(todoDrag.lastY));
  }

  /** 拖拽时真正在滚的那一层：待办列表自己能滚就滚它，否则滚外层 .xm-sheet */
  function dragScrollBox(): HTMLElement {
    if (todosEl && todosEl.scrollHeight > todosEl.clientHeight + 1) return todosEl;
    return scrollEl;
  }

  /** 拖到正文上下边缘时自动滚动：指针停着不动也要继续滚，所以用 rAF 循环 */
  function startDragAutoScroll(): void {
    if (!todoDrag || todoDrag.raf) return;
    const step = (): void => {
      const state = todoDrag;
      if (!state || !state.active) {
        if (state) state.raf = 0;
        return;
      }
      state.raf = requestAnimationFrame(step);
      const box = dragScrollBox();
      const rect = box.getBoundingClientRect();
      const edge = 24;
      let dy = 0;
      if (state.lastY < rect.top + edge) dy = -Math.min(16, (rect.top + edge - state.lastY) / 2 + 2);
      else if (state.lastY > rect.bottom - edge) dy = Math.min(16, (state.lastY - (rect.bottom - edge)) / 2 + 2);
      if (!dy) return;
      const max = box.scrollHeight - box.clientHeight;
      const before = box.scrollTop;
      box.scrollTop = clamp(before + dy, 0, max);
      if (box.scrollTop !== before) updateDropMark();
    };
    todoDrag.raf = requestAnimationFrame(step);
  }

  /** pointerdown 之后进入"预备拖拽"：只差 4px 就成真 */
  function armTodoDrag(row: HTMLElement, event: PointerEvent): void {
    if (todoDrag) cancelTodoDrag();
    todoDrag = {
      id: row.dataset.id ?? "",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      dropId: "",
      dropPlace: "before",
      raf: 0,
    };
    window.addEventListener("pointermove", onTodoDragMove, true);
    window.addEventListener("pointerup", onTodoDragEnd, true);
    window.addEventListener("pointercancel", onTodoDragCancel, true);
  }

  function stopTodoDragListeners(): void {
    window.removeEventListener("pointermove", onTodoDragMove, true);
    window.removeEventListener("pointerup", onTodoDragEnd, true);
    window.removeEventListener("pointercancel", onTodoDragCancel, true);
  }

  /** 把拖拽留下的 data 属性/内联样式摘干净（松手、取消、被打断都走这里） */
  function releaseTodoDragVisuals(active: boolean): void {
    if (!active || !todosEl) return;
    todosEl.querySelectorAll<HTMLElement>(".xm-todo[data-drag], .xm-todo[data-drop]").forEach((row) => {
      delete row.dataset.drag;
      delete row.dataset.drop;
    });
    delete todosEl.dataset.dragging;
    todosEl.style.removeProperty("user-select");
    todosEl.style.removeProperty("-webkit-user-select");
  }

  /** 拖拽期间被推迟的重画，松手/取消后补上 */
  function flushDeferredTodosRender(): void {
    if (!todosRenderDeferred) return;
    todosRenderDeferred = false;
    renderTodos();
  }

  /** 按住不动只是点击：这里什么都不做，交给 click 处理；动了才算拖 */
  function onTodoDragMove(event: PointerEvent): void {
    const state = todoDrag;
    if (!state || event.pointerId !== state.pointerId) return;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (!state.active) {
      const moved = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
      if (moved <= DRAG_THRESHOLD) return; // 还没过阈值：手抖而已，等真的移动了再说
      const row = todoRowById(state.id);
      const box = todosEl;
      if (!row || !box) {
        cancelTodoDrag();
        return;
      }
      state.active = true;
      row.dataset.drag = "1";
      box.dataset.dragging = "1";
      // 拖拽期间别让浏览器顺手选中一行字
      box.style.userSelect = "none";
      box.style.setProperty("-webkit-user-select", "none");
      window.getSelection()?.removeAllRanges();
      try {
        // 抓住指针：拖出便签/拖到别的行上面也不会丢事件
        row.setPointerCapture(event.pointerId);
      } catch {
        // 指针已经被系统抢走：靠 window 上的 pointermove 兜底
      }
      startDragAutoScroll();
    }
    updateDropMark();
  }

  /** 松手：按落点重排 order → 保存 → 重画（契约 §16.3） */
  function applyTodoDrop(id: string, target: { id: string; place: "before" | "after" }): void {
    const ids = todoRows()
      .map((row) => row.dataset.id ?? "")
      .filter((value) => value !== "");
    const fromIndex = ids.indexOf(id);
    if (fromIndex < 0) return;
    const rest = ids.filter((value) => value !== id);
    const at = rest.indexOf(target.id);
    if (at < 0) return;
    const insertAt = target.place === "before" ? at : at + 1;
    // 落回原处：不动数据、不写库，免得平白多一条修改记录
    if (insertAt === fromIndex) return;
    rest.splice(insertAt, 0, id);
    reorderTodos(rest);
    markDirty();
    updateMeta();
    void saveNote(false);
    renderTodos();
    scheduleScrollState();
  }

  function cancelTodoDrag(): void {
    const state = todoDrag;
    if (!state) return;
    todoDrag = null;
    stopTodoDragListeners();
    if (state.raf) cancelAnimationFrame(state.raf);
    releaseTodoDragVisuals(state.active);
    flushDeferredTodosRender();
  }

  function onTodoDragCancel(event: PointerEvent): void {
    const state = todoDrag;
    if (!state || event.pointerId !== state.pointerId) return;
    cancelTodoDrag();
  }

  function onTodoDragEnd(event: PointerEvent): void {
    const state = todoDrag;
    if (!state || event.pointerId !== state.pointerId) return;
    // 落点要在清掉 todoDrag 之前算：dropTargetAt 要靠它排除正在拖的那一行
    const target = state.active ? dropTargetAt(state.lastY) : null;
    todoDrag = null;
    stopTodoDragListeners();
    if (state.raf) cancelAnimationFrame(state.raf);
    releaseTodoDragVisuals(state.active);
    if (state.active) {
      // 松手后浏览器会补发一次 click，吃掉它（见前面的捕获阶段监听）
      swallowTodoClick = true;
      window.clearTimeout(swallowClickTimer);
      swallowClickTimer = window.setTimeout(() => {
        swallowTodoClick = false;
      }, 400);
      if (target) applyTodoDrop(state.id, target);
    }
    flushDeferredTodosRender();
  }

  /**
   * Alt+↑ / Alt+↓：与相邻行交换顺序（契约 §16.3）。
   * 只挪这两个 <li> 节点、不整表重画，正在编辑的输入框与光标位置都留在原处；
   * 交换的两行加 .xm-todo--moving（140ms 过渡）。
   */
  function swapTodoRow(li: HTMLElement, delta: number): void {
    const rows = todoRows();
    const index = rows.indexOf(li);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= rows.length) return;
    const other = rows[targetIndex];
    const input = li.querySelector<HTMLInputElement>(".xm-todo__text");
    // 挪节点可能把焦点/光标弄丢：先把位置记下来，挪完还回去
    const selStart = input?.selectionStart ?? null;
    const selEnd = input?.selectionEnd ?? null;
    const ids = rows.map((row) => row.dataset.id ?? "");
    ids[index] = other.dataset.id ?? "";
    ids[targetIndex] = li.dataset.id ?? "";
    reorderTodos(ids);
    const box = todosEl;
    if (box) {
      if (delta < 0) box.insertBefore(li, other);
      else box.insertBefore(li, other.nextSibling);
    }
    [li, other].forEach((row) => row.classList.add("xm-todo--moving"));
    window.setTimeout(() => {
      li.classList.remove("xm-todo--moving");
      other.classList.remove("xm-todo--moving");
    }, 140);
    if (input) {
      if (document.activeElement !== input) input.focus();
      if (selStart != null && selEnd != null) {
        try {
          input.setSelectionRange(selStart, selEnd);
        } catch {
          // 极老引擎不支持就算了，焦点还在这一行
        }
      }
    }
    revealRow(li);
    markDirty();
    updateMeta();
    void saveNote(false);
    scheduleScrollState();
  }

  // 拖拽中按 Esc：放弃这次排序（拖到一半总得有个退出的办法）
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      if (!todoDrag || !todoDrag.active) return;
      event.preventDefault();
      event.stopPropagation();
      cancelTodoDrag();
    },
    true,
  );

  /** 把新增行的草稿变成正式待办 */
  function commitNewRow(input: HTMLInputElement, refocus: boolean): void {
    if (draft.locked) return;
    const text = input.value.trim();
    if (!text) return;
    const order = draft.todos.length > 0 ? Math.max(...draft.todos.map((t) => t.order)) + 1 : 0;
    const item: TodoItem = { id: uid(), text, done: false, due_at: null, order };
    draft.todos.push(item);
    if (todosEl) {
      const newRow = todosEl.querySelector<HTMLElement>(".xm-todo--new");
      const row = createTodoRow(item);
      if (newRow) todosEl.insertBefore(row, newRow);
      input.value = "";
      if (refocus && document.hasFocus()) input.focus();
    }
    markDirty();
    updateMeta();
    scheduleSave();
    scheduleScrollState();
  }

  /** 回车：在当前待办下面插入一条空白待办并聚焦 */
  function insertTodoAfter(id: string): void {
    const index = draft.todos.findIndex((t) => t.id === id);
    if (index < 0) return;
    const item: TodoItem = { id: uid(), text: "", done: false, due_at: null, order: 0 };
    draft.todos.splice(index + 1, 0, item);
    draft.todos.forEach((t, i) => {
      t.order = i;
    });
    renderTodos();
    const row = todosEl?.querySelector<HTMLElement>('.xm-todo[data-id="' + item.id + '"]');
    row?.querySelector<HTMLInputElement>(".xm-todo__text")?.focus();
    markDirty();
    scheduleScrollState();
  }

  /** 退格删除空待办，焦点落到上一条 */
  function removeTodoRow(li: HTMLElement): void {
    const id = li.dataset.id;
    if (!id) return;
    const rows = Array.from(todosEl?.querySelectorAll<HTMLElement>("li.xm-todo:not(.xm-todo--new)") ?? []);
    const index = rows.indexOf(li);
    draft.todos = draft.todos.filter((t) => t.id !== id);
    draft.todos.forEach((t, i) => {
      t.order = i;
    });
    li.remove();
    markDirty();
    updateMeta();
    scheduleScrollState();
    scheduleSave();
    if (index > 0) {
      rows[index - 1]?.querySelector<HTMLInputElement>(".xm-todo__text")?.focus();
    } else {
      newRowInput()?.focus();
    }
  }

  // ---------- 13. 启动 ----------
  renderFromNote();
  // 有内容的便签打开就显示排版效果；点一下才会回到原文编辑
  if (mdEnabled()) renderMarkdown();
  // 启动 & 尺寸/字体变化后重算滚动状态（是否可滚、在顶/中/底）
  requestAnimationFrame(() => {
    requestAnimationFrame(updateScrollState);
    // 新建的空便签已由原生窗口聚焦，页面就绪后把光标落到正文。
    if (document.hasFocus() && draft.kind === "memo" && !draft.collapsed && !draft.title && !draft.content) {
      focusEditor(true);
    }
  });
  void document.fonts?.ready.then( () => updateScrollState);
  window.addEventListener("resize", scheduleScrollState);
  // 尺寸档位高亮跟手：resize 节流 80ms，窗口到档后把 intent 交还给实际宽度
  window.addEventListener("resize",  () => {
    if (sizeIntentCheckTimer) return;
    sizeIntentCheckTimer = window.setTimeout( () => {
      sizeIntentCheckTimer = 0;
      syncSizeIntent();
    }, 80);
  });
  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => scheduleScrollState());
    resizeObserver.observe(scrollEl);
    const content = contentEl();
    if (content) resizeObserver.observe(content);
    const sizeObserver = new ResizeObserver(syncSizeIntent);
    sizeObserver.observe(noteEl);
  }

  // 外部改动（面板里改颜色、后端补发提醒等）：没在编辑就刷新当前便签
  void onAppEvent<{ id?: string }>("notes-changed", (payload) => {
    if (dirty) return;
    // notes-changed 有时不带 id（整库变动，例如从修改记录恢复）：这时也要刷新当前便签
    if (payload?.id && payload.id !== draft.id) return;
    const active = document.activeElement;
    if (active && (active === editor || root.contains(active))) return;
    void (async () => {
      const windowRevision = collapseRequest + sizeRequest;
      const fresh = (await api.getSnapshot()).notes.find((n) => n.id === draft.id);
      if (!fresh) return;
      draft = {
        ...fresh,
        ...localWindowState(windowRevision),
        todos: fresh.todos.map((t) => ({ ...t })),
        items: (fresh.items ?? []).map((item) => ({ ...item })),
        reveal: !!fresh.reveal,
      };
      renderFromNote();
    })();
  });
  void onAppEvent<Settings>("settings-changed", (next) => {
    if (next) settings = { ...settings, ...next };
    // 设置里关掉 Markdown 排版：正在排版的便签立刻退回原文
    if (settings.markdown_enabled === false && mdRendered) {
      editMarkdown(undefined, false);
    } else if (
      settings.markdown_enabled !== false &&
      mdEnabled() &&
      document.activeElement !== editor
    ) {
      // 设置里重新打开：没在编辑的话直接排上
      renderMarkdown();
    }
  });
  void onAppEvent<{ id?: string }>("note-focus", (payload) => {
    if (payload?.id === draft.id) focusEditor(true);
  });
}
