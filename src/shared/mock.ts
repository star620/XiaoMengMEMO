/**
 * 浏览器 mock 后端 —— 只在没有 Tauri（window.__TAURI_INTERNALS__ 不存在）时启用。
 *
 * 为什么要有它：Rust 端还在实现时，前端也要能直接在浏览器里调 UI：
 *   npm run dev  然后打开 http://localhost:1420/?surface=sticky&id=...
 * mock 用 localStorage 存数据（刷新不丢），并模拟 300ms 的 IPC 延迟；
 * 保存后派发 &notes-changed 之类的同名事件，多个标签页之间用 BroadcastChannel 同步，
 * 这样便签窗口和面板窗口可以分别开标签页联调。
 *
 * 注意：这里实现 api.ts 里用到的命令，命令名/参数与真实后端完全一致。
 * 生产构建会把它拆成独立 chunk，不会进主包。
 */
import { mdToPlain } from "./markdown";
import { uid } from "./dom";
import type { Note, Settings, Snapshot, TodoItem, TrashItem, VaultItem } from "./types";

const STORE_KEY = "xm-mock-store-v1";
/** 模拟 IPC 延迟（毫秒），让加载态/防抖更接近真实情况 */
const LATENCY = 300;

/** 回收站条目：和 Rust 端 trash.json 的结构一致（契约 §12.1） */
interface TrashEntry {
  note: Note;
  deleted_at: number;
}

/** 一条旧版本：便签当时的完整快照 + 保存时间（契约 §14） */
interface VersionEntry {
  note: Note;
  ts: number;
}

interface MockStore {
  notes: Note[];
  settings: Settings;
  autostart: boolean;
  trash: TrashEntry[];
  /** 修改记录（每张便签最多保留 20 条，前端 mock 与 Rust 端结构一致） */
  versions: VersionEntry[];
}

const DEFAULT_SETTINGS: Settings = {
  launch_on_startup: false,
  hotkey_new_note: "Ctrl+Alt+N",
  hotkey_show_panel: "Ctrl+Alt+M",
  default_color: "yellow",
  default_font_scale: 1,
  play_sound: true,
  show_tray: true,
  first_run_done: true,
  markdown_enabled: true,
  reminder_sound: true,
  theme_mode: "auto",
  hotkey_quick: "Ctrl+Alt+Space",
};


/** 浏览器 mock 的图片仓库：文件名 -> data URL（契约 §4.5）。 */
const mockImages = new Map<string, string>();

/** 一张 300x200 的 SVG 占位照片：暖色窗景，别用 1x1 透明图，才能看清相纸排版。 */
function svgPhoto(sky: string, windowColor: string, sun: string, caption: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">' +
    '<rect width="300" height="200" fill="' + sky + '"/>' +
    '<rect x="34" y="28" width="232" height="128" rx="4" fill="' + windowColor + '" stroke="#a98a5a" stroke-width="3"/>' +
    '<circle cx="216" cy="70" r="24" fill="' + sun + '" opacity=".92"/>' +
    '<path d="M34 156 L110 104 L166 142 L214 112 L266 156 Z" fill="#7d9a6a" opacity=".85"/>' +
    '<path d="M34 156 L266 156" stroke="#a98a5a" stroke-width="3"/>' +
    '<text x="150" y="187" text-anchor="middle" font-size="12" fill="#6b5636" font-family="KaiTi, serif">' + caption + "</text>" +
    "</svg>";
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/** 种子便签里引用的两张图（文件名符合 img_[0-9a-f]{16}.png） */
const SEED_PHOTO_1 = "img_5a1c9e7b3d2f4086.png";
const SEED_PHOTO_2 = "img_c4d2a8f6b1e90357.png";
mockImages.set(SEED_PHOTO_1, svgPhoto("#f4e2bd", "#cfe3ef", "#e9a53f", "窗台上的猫"));
mockImages.set(SEED_PHOTO_2, svgPhoto("#e6ddc8", "#d8e8d0", "#d8b36a", "楼下的面包店"));

/** 给 images.ts 用：浏览器里把文件名换成 data URL。 */
export function __mockImageUrl(name: string): string {
  return mockImages.get(name) ?? "";
}

// mock 模块加载时把解析器挂到全局，images.ts 就不用静态 import 整个 mock（保住独立 chunk）
(globalThis as { __XM_MOCK_IMAGE_URL__?: (file: string) => string }).__XM_MOCK_IMAGE_URL__ =
  __mockImageUrl;


/** 把 localStorage 里可能缺字段的 items 洗成干净数组（老数据没有 items 就补空） */
function normalizeItems(raw: unknown): VaultItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Partial<VaultItem> => !!entry && typeof entry === "object")
    .map((entry) => ({
      id: typeof entry.id === "string" && entry.id ? entry.id : uid(),
      label: typeof entry.label === "string" ? entry.label : "",
      value: typeof entry.value === "string" ? entry.value : "",
      note: typeof entry.note === "string" ? entry.note : "",
    }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function newNote(
  kind: "memo" | "todo" | "vault",
  settings: Settings,
  at?: { x: number; y: number } | null,
): Note {
  const t = Date.now();
  return {
    id: uid(),
    kind,
    title: "",
    content: "",
    todos: kind === "todo" ? [{ id: uid(), text: "", done: false, due_at: null, order: 0 }] : [],
    items: [],
    reveal: false,
    color: settings.default_color || "yellow",
    pinned: false,
    locked: false,
    x: at?.x ?? null,
    y: at?.y ?? null,
    width: null,
    height: null,
    font_scale: settings.default_font_scale || 1,
    created_at: t,
    updated_at: t,
    reminder_at: null,
    reminder_done: false,
    repeat: "",
    collapsed: false,
    hidden: false,
  };
}

/** 回收站摘要：正文压平前 60 字；待办取第一条没完成的；随身笔记只报名字（契约 §12.2/§13.6） */
function previewOf(note: Note): string {
  if (note.kind === "vault") {
    const labels = note.items.map((item) => item.label.trim()).filter(Boolean);
    if (!labels.length) return "空随身笔记";
    const text = labels.slice(0, 2).join(" · ") + (labels.length > 2 ? " 等 " + labels.length + " 条" : "") + "（已打码）";
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
  }
  if (note.kind === "todo") {
    const rest = note.todos.find((todo) => !todo.done && todo.text.trim());
    const text = rest ? rest.text.trim() : note.todos.length ? "全部完成了" : "空待办";
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
  }
  const text = note.content.replace(/\s+/g, " ").trim();
  return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

/** 回收站标题：优先标题，其次正文第一行 */
function trashTitle(note: Note): string {
  const title = note.title.trim();
  if (title) return title;
  const first = note.content.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (first) return first;
  if (note.kind === "vault") {
    return note.items.map((item) => item.label.trim()).find(Boolean) || "随身笔记";
  }
  return note.kind === "todo" ? "待办" : "空便签";
}

/** 造两条回收站数据，浏览器里点开回收站就有东西可看、可恢复（mock 专用） */
function seedTrash(): TrashEntry[] {
  const t = Date.now();
  const todo: Note = {
    ...newNote("todo", DEFAULT_SETTINGS),
    id: "seed-trash-todo",
    title: "上周的杂事",
    todos: [
      { id: uid(), text: "把快递盒扔掉", done: true, due_at: null, order: 0 },
      { id: uid(), text: "给绿萝换个盆", done: false, due_at: null, order: 1 },
      { id: uid(), text: "整理抽屉里的旧票据", done: false, due_at: null, order: 2 },
    ],
    color: "sky",
    created_at: t - 5 * 86_400_000,
    updated_at: t - 4 * 86_400_000,
    hidden: true,
  };
  const memo: Note = {
    ...newNote("memo", DEFAULT_SETTINGS),
    id: "seed-trash-memo",
    title: "过期的小目标",
    content: "每天走一万步。\n睡前读二十页书。\n周末把阳台收拾出来。",
    color: "rose",
    created_at: t - 9 * 86_400_000,
    updated_at: t - 8 * 86_400_000,
    hidden: true,
  };
  return [
    { note: todo, deleted_at: t - 2 * 3_600_000 },
    { note: memo, deleted_at: t - 26 * 3_600_000 },
  ];
}

/** 复制便签，避免历史版本和当前便签共享 todos 引用 */
function cloneNote(note: Note): Note {
  return {
    ...note,
    todos: note.todos.map((item) => ({ ...item })),
    items: note.items.map((item) => ({ ...item })),
  };
}

/**
 * 差异视图的演示便签：三个版本逐版都有增删，
 * 浏览器里打开「改稿示例 · 看差异」→ 修改记录 → 最新版，就能直接看到红绿改动。
 * 最后一项是最新正文，和 seed() 里那张便签保持一致。
 */
const DIFF_SAMPLE_VERSIONS = [
  "周末计划\n\n早上去河边散步，顺便买橘子。\n下午整理书架，把旧杂志收进箱子。\n晚上给妈妈打电话。",
  "周末计划\n\n早上去河边走一圈，顺便买两斤橘子。\n下午把书架整理一下，把旧杂志收进箱子。\n晚上给妈妈打个电话，问问她最近怎么样。",
  "周末计划\n\n早上去河边走一圈，顺便买两斤橘子和一把小葱。\n下午把书架整理一下，把旧杂志收进箱子。\n晚上给妈妈打电话，问问她膝盖还疼不疼。",
];
const DIFF_SAMPLE_CONTENT = DIFF_SAMPLE_VERSIONS[DIFF_SAMPLE_VERSIONS.length - 1];

/** 旧正文：按比例截短，读起来像"还没写完的上一稿" */
function olderContent(content: string, step: number): string {
  if (!content.trim()) return content;
  const keep = Math.max(1, Math.floor(content.length * Math.max(0.22, 1 - step * 0.16)));
  return content.slice(0, keep).replace(/\s+$/, "");
}

/** 这条历史版本的标题：和面板一致，没标题就取正文第一行 / 随身笔记第一条名字 */
function versionTitle(note: Note): string {
  const title = note.title.trim();
  if (title) return title;
  if (note.kind === "vault") {
    return note.items.map((item) => item.label.trim()).find(Boolean) || "随身笔记";
  }
  const first = mdToPlain(note.content)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  return first || (note.kind === "todo" ? "待办" : "空便签");
}

/** 字数：和便签右下角一致，去掉空白与 Markdown 标记 */
function versionChars(note: Note): number {
  if (note.kind === "todo") {
    return note.todos.map((item) => item.text).join("").replace(/\s/g, "").length;
  }
  if (note.kind === "vault") {
    // 不拿 value 算字数，避免从"字数"反推出密码长度
    return note.items.map((item) => item.label).join("").replace(/\s/g, "").length;
  }
  return mdToPlain(note.content).replace(/\s/g, "").length;
}

/** 历史版本的摘要（一行，最多 90 字） */
function versionPreview(note: Note): string {
  if (note.kind === "vault") {
    const labels = note.items.map((item) => item.label.trim()).filter(Boolean);
    if (!labels.length) return "空随身笔记";
    const text = labels.slice(0, 3).join(" · ") + "（已打码）";
    return text.length > 90 ? text.slice(0, 90) + "…" : text;
  }
  if (note.kind === "todo") {
    const shown = note.todos
      .slice(0, 2)
      .map((item) => (item.done ? "✓ " : "") + item.text)
      .filter((text) => text.trim());
    const text = shown.join(" · ") || "空待办";
    return text.length > 90 ? text.slice(0, 90) + "…" : text;
  }
  return mdToPlain(note.content).replace(/\s+/g, " ").trim().slice(0, 90);
}

/** 把旧快照推进修改记录，每张便签只留最近 20 条 */
function pushVersion(store: MockStore, note: Note): void {
  store.versions.unshift({ note: cloneNote(note), ts: Date.now() });
  let seen = 0;
  store.versions = store.versions.filter((entry) => {
    if (entry.note.id !== note.id) return true;
    seen += 1;
    return seen <= 20;
  });
}

/** 给种子便签造 3-5 条历史，浏览器里点开「修改记录」就能看到东西 */
function seedVersions(notes: Note[]): VersionEntry[] {
  const gaps = [40 * 60_000, 3 * 3_600_000, 26 * 3_600_000, 3 * 86_400_000, 8 * 86_400_000];
  const out: VersionEntry[] = [];
  notes.forEach((note, index) => {
    const base = note.updated_at || Date.now();
    const count = 3 + ((index + note.id.length) % 3);
    // 差异演示便签用写好的三稿，保证每一版之间都有明确的增删（task-33）
    if (note.id === "seed-diff") {
      const texts = DIFF_SAMPLE_VERSIONS.slice().reverse();
      texts.forEach((text, step) => {
        const version = cloneNote(note);
        version.content = text;
        version.created_at = note.created_at;
        version.updated_at = base - gaps[step];
        out.push({ note: version, ts: version.updated_at });
      });
      return;
    }
    for (let step = 0; step < count; step += 1) {
      const version = cloneNote(note);
      version.created_at = note.created_at;
      version.updated_at = base - gaps[step];
      if (note.kind === "memo") {
        version.content = olderContent(note.content, step + 1);
      } else if (note.kind === "vault") {
        version.items = note.items.slice(0, Math.max(0, note.items.length - step - 1));
      } else {
        version.todos = note.todos
          .slice(0, Math.max(0, note.todos.length - step - 1))
          .map((item, order) => ({ ...item, order }));
      }
      out.push({ note: version, ts: version.updated_at });
    }
  });
  return out;
}

/** 造一批假数据：长文便签用于验证滚动，待办用于验证勾选/进度，空便签用于验证空状态。 */
function seed(): MockStore {
  const t = Date.now();
  const paragraphs = [
    "深秋的午后，阳光斜斜地落在桌角，像一张被晒暖的纸。我把它折起来，夹进今天要做的事情里。",
    "这是一段用来测试滚动的长内容。便签只有一屏高，但字可以写很长，超出的部分就在正文里滚，像一张写满了字的纸。",
    "把鼠标放在正文上滚滚轮，纸的上下边缘会淡淡地压一点，提示你下面还有内容。",
    "内容还在继续：写长一点的读书笔记、会议记录、随手想到的句子，都不会把便签撑坏，也不会多出页码。",
    "试着在中间随便改几个字，然后按 Ctrl+S，右下角会轻轻提示“已保存”。停手 0.8 秒也会自动保存。",
    "滚正文的时候不会选中文字、也不会把便签窗口一起滚走，这是刻意的：滚动是滚动，编辑是编辑。",
    "如果你喜欢，可以把字号调小一点，一页就能放下更多字；也可以换成薄荷绿或者天空蓝，换一种心情。",
    "再往下还有很多。没有页码、没有翻页手势，只有滚到底时自然停住。",
    "有些便签是贴着不动的，有些会随着时间往下沉。置顶的那张会一直待在面板最上面。楼下的猫在窗台上喵了一声。",
    "这一段只是为了让内容足够长，方便验证窗口尺寸变化后滚动区域会重新算，不会把最后一行裁掉。",
    "顺便也可以检查一下：滚动正文时，标题栏和工具栏是安静的，不会被一起滚走。",
    "滚到最下面会停住，不会滚出空白；滚到最上面也一样会停住。",
    "顺手把上周的报告归档，标题写成一句话，以后在面板里一搜就能找到。",
    "写到这里差不多够了。愿你的每一条待办，都有被轻轻划掉的一刻。",
  ];
  const longMemo = paragraphs.join("\n\n") + "\n\n";
  // 契约 §16.1 筛选的假数据：今天 / 逾期 / 明天各一条，方便一眼看出筛选有没有生效
  const todayDue = new Date(t);
  todayDue.setHours(18, 0, 0, 0);
  const overdueDue = new Date(t);
  overdueDue.setDate(overdueDue.getDate() - 1);
  overdueDue.setHours(18, 0, 0, 0);
  const tomorrowDue = new Date(t);
  tomorrowDue.setDate(tomorrowDue.getDate() + 1);
  tomorrowDue.setHours(10, 0, 0, 0);
  const todoItems: TodoItem[] = [
    { id: uid(), text: "买牛奶、鸡蛋和一把小葱", done: true, due_at: null, order: 0 },
    { id: uid(), text: "给阳台的薄荷浇水", done: false, due_at: todayDue.getTime(), order: 1 },
    { id: uid(), text: "把上周的读书笔记整理成三句话", done: false, due_at: overdueDue.getTime(), order: 2 },
    { id: uid(), text: "预约周五的牙医", done: false, due_at: tomorrowDue.getTime(), order: 3 },
    { id: uid(), text: "给妈妈打个电话", done: true, due_at: null, order: 4 },
  ];
  // 首启欢迎便签：标题和正文跟 Rust 端 store.rs 的 seed_welcome_note 完全一致，
  // 这样浏览器 mock 和真机看到的第一屏是同一张纸。
  const welcome: Note = {
    ...newNote("memo", DEFAULT_SETTINGS, { x: 260, y: 180 }),
    id: "seed-welcome",
    title: "你好，我是小梦",
    content:
      "欢迎来到小梦备忘录！\n\n1. 直接在这里写字，按 Ctrl+S 保存（每次改动也会自动保存）\n2. 内容写长了，直接在正文里滚鼠标滚轮，纸边会淡出去\n3. 任何时候按 Ctrl+Alt+N，都能在鼠标位置新建一张便签\n\n关掉便签不会丢数据，右键托盘上的小图标就能找回来。",
    color: "yellow",
    pinned: false,
    created_at: t - 86_400_000,
    updated_at: t - 60_000,
  };
  // 浏览器里单独打开提醒窗调试时没有后端的"到点"事件，
  // 给欢迎便签补一个一小时后的提醒，这样 ?surface=reminder&id=seed-welcome 才能看到真实的排版。
  if (location.search.includes("surface=reminder")) {
    welcome.reminder_at = t + 60 * 60_000;
    welcome.reminder_done = false;
  }
  // Markdown 排版调试便签：契约 §10.2 里的语法各来一条，方便截图和目检渲染/还原
  const mdSample = [
    "# 周末计划",
    "",
    "把想做的小事写下来，做完一件就勾掉一件。",
    "",
    "## 上午",
    "",
    "- 买牛奶和鸡蛋",
    "- **整理书桌**",
    "- 给阳台的薄荷浇水",
    "",
    "## 下午",
    "",
    "1. 写周报",
    "2. 去公园走一圈",
    "3. 读二十页书",
    "",
    "> 出门记得带伞。",
    "",
    "---",
    "",
    "命令备忘：`npm run build` 先把类型检查跑一遍。",
    "",
    "```",
    "git status",
    "git add -A",
    "```",
  ].join("\n");
  const notes: Note[] = [
    welcome,
    {
      ...newNote("memo", DEFAULT_SETTINGS, { x: 160, y: 120 }),
      id: "seed-long-memo",
      title: "读书笔记 · 长内容滚动测试",
      content: longMemo,
      color: "yellow",
      created_at: t - 3 * 86_400_000,
      updated_at: t - 12 * 60_000,
    },
    {
      ...newNote("memo", DEFAULT_SETTINGS, { x: 360, y: 260 }),
      id: "seed-md",
      title: "Markdown 排版示例",
      content: mdSample,
      color: "lavender",
      created_at: t - 6 * 3_600_000,
      updated_at: t - 3_600_000,
    },
    {
      ...newNote("memo", DEFAULT_SETTINGS, { x: 260, y: 340 }),
      id: "seed-diff",
      title: "改稿示例 · 看差异",
      content: DIFF_SAMPLE_CONTENT,
      color: "rose",
      created_at: t - 3 * 86_400_000,
      updated_at: t - 10 * 60_000,
    },
    {
      ...newNote("todo", DEFAULT_SETTINGS, { x: 520, y: 120 }),
      id: "seed-todo",
      title: "周末采购清单",
      todos: todoItems,
      color: "mint",
      created_at: t - 2 * 86_400_000,
      updated_at: t - 47 * 60_000,
    },
    {
      ...newNote("vault", DEFAULT_SETTINGS, { x: 660, y: 260 }),
      id: "seed-vault",
      title: "我的小本子",
      items: [
        { id: "vault-vpn", label: "公司 VPN", value: "vpn.xiaomeng.example 端口 8443", note: "出差时用" },
        { id: "vault-code", label: "快递取件码", value: "8-2-4417", note: "小区门口丰巢" },
        { id: "vault-addr", label: "宿舍地址", value: "梧桐路 12 号 3 栋 502", note: "寄快递用" },
      ],
      color: "pink",
      created_at: t - 5 * 3_600_000,
      updated_at: t - 30 * 60_000,
    },
    {
      ...newNote("memo", DEFAULT_SETTINGS, { x: 760, y: 320 }),
      id: "seed-empty",
      title: "",
      content: "",
      color: "sky",
      created_at: t - 3_600_000,
      updated_at: t - 3_600_000,
    },
  ];
  return {
    notes,
    settings: { ...DEFAULT_SETTINGS },
    autostart: false,
    trash: seedTrash(),
    versions: seedVersions(notes),
  };
}

/** 每个操作都从 localStorage 重新读，保证多标签页调试时看到的是同一份数据。 */
function load(): MockStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MockStore>;
      if (parsed && Array.isArray(parsed.notes) && parsed.settings) {
        const settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
        // 老数据里没有 markdown_enabled：按 true 读，和后端 serde 默认值一致
        if (typeof settings.markdown_enabled !== "boolean") settings.markdown_enabled = true;
        // 契约 §16.10：老数据缺这三个字段时按默认值补齐，避免界面出现 undefined
        if (typeof settings.reminder_sound !== "boolean") settings.reminder_sound = true;
        if (settings.theme_mode !== "day" && settings.theme_mode !== "night") settings.theme_mode = "auto";
        if (typeof settings.hotkey_quick !== "string" || !settings.hotkey_quick) {
          settings.hotkey_quick = "Ctrl+Alt+Space";
        }
        // 老数据里没有 repeat：补空串，和后端 serde 默认值一致
        const notes = parsed.notes.map((note) => ({
          ...note,
          repeat: typeof note.repeat === "string" ? note.repeat : "",
          items: normalizeItems(note.items),
          reveal: !!note.reveal,
          locked: !!note.locked,
          collapsed: !!note.collapsed,
        }));
        // 老 storage 没有 trash 字段：补两条样例，方便直接验收回收站视图
        const trash = Array.isArray(parsed.trash)
          ? parsed.trash.map((entry) => ({
              ...entry,
              note: {
                ...entry.note,
                repeat: typeof entry.note.repeat === "string" ? entry.note.repeat : "",
                items: normalizeItems(entry.note.items),
                reveal: !!entry.note.reveal,
              },
            }))
          : seedTrash();
        // 老 storage 没有 versions：按当前便签补种，保证「修改记录」第一次点开不是空的
        const versions: VersionEntry[] = Array.isArray(parsed.versions)
          ? parsed.versions
              .filter((entry) => entry && entry.note && typeof entry.note.id === "string")
              .map((entry) => ({
                ts: Number(entry.ts) || 0,
                note: {
                  ...entry.note,
                  repeat: typeof entry.note.repeat === "string" ? entry.note.repeat : "",
                  items: normalizeItems(entry.note.items),
                  reveal: !!entry.note.reveal,
                  todos: Array.isArray(entry.note.todos)
                    ? entry.note.todos.map((item) => ({ ...item }))
                    : [],
                },
              }))
          : seedVersions(notes);
        return { notes, settings, autostart: !!parsed.autostart, trash, versions };
      }
    }
  } catch {
    /* localStorage 不可用（隐私模式等）就退回内存 */
  }
  const seeded = seed();
  save(seeded);
  return seeded;
}

let warnedStorage = false;
function save(store: MockStore): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (error) {
    // 隐私模式/配额满了时只警告一次，别每次保存都刷屏
    if (!warnedStorage) {
      warnedStorage = true;
      console.warn("mock 数据写不进 localStorage，本次只在内存里生效。", error);
    }
  }
}

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  channel ??= new BroadcastChannel("xm-mock");
  channel.onmessage = (event: MessageEvent<{ name: string; payload?: unknown }>) => {
    dispatchLocal(event.data.name, event.data.payload);
  };
  return channel;
}

/** 派发事件：同窗口 CustomEvent + 跨标签页 BroadcastChannel。 */
function emit(name: string, payload?: unknown): void {
  dispatchLocal(name, payload);
  getChannel()?.postMessage({ name, payload });
}

function dispatchLocal(name: string, payload?: unknown): void {
  window.dispatchEvent(new CustomEvent("xm-mock:" + name, { detail: payload }));
}

function findNote(store: MockStore, id: string): Note | undefined {
  return store.notes.find((n) => n.id === id);
}

/** mock 版的命令分发：签名和 src/shared/api.ts 的 api 一一对应。 */
export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await sleep(LATENCY);
  const store = load();
  const a = args ?? {};
  switch (cmd) {
    case "get_snapshot": {
      return { notes: store.notes, settings: store.settings } as Snapshot as T;
    }
    case "save_note": {
      const note = a.note as Note;
      let saved: Note = {
        ...note,
        repeat: typeof note.repeat === "string" ? note.repeat : "",
        items: normalizeItems(note.items),
        reveal: !!note.reveal,
        updated_at: Date.now(),
      };
      const index = store.notes.findIndex((n) => n.id === saved.id);
      // 跟 Rust 端一致（契约 §13.1）：锁定后 save_note 不认 title/content/todos，
      // 只接受几何、颜色、置顶、收起这些。浏览器 mock 也照做，
      // 否则前端"锁定后旧草稿覆盖内容"的 bug 在 mock 下看不出来。
      const prev = index >= 0 ? store.notes[index] : null;
      if (prev && prev.locked) {
        saved = {
          ...saved,
          title: prev.title,
          content: prev.content,
          todos: prev.todos.map((item) => ({ ...item })),
          // 锁定只锁内容；reveal（这张便签要不要显示明文）仍然让用户自己切
          items: prev.items.map((item) => ({ ...item })),
          locked: true,
        };
      }
      // 内容真的变了，才把旧快照留进修改记录（纯改窗口位置/颜色不占历史）
      if (
        prev &&
        !prev.locked &&
        (prev.title !== saved.title ||
          prev.content !== saved.content ||
          JSON.stringify(prev.todos) !== JSON.stringify(saved.todos) ||
          JSON.stringify(prev.items) !== JSON.stringify(saved.items))
      ) {
        pushVersion(store, prev);
      }
      if (index >= 0) store.notes[index] = saved;
      else store.notes.push(saved);
      save(store);
      emit("notes-changed", { id: saved.id });
      return saved as T;
    }
    case "delete_note": {
      // 删除 = 移进回收站（契约 §12.2），不再直接丢数据
      const id = a.id as string;
      const note = findNote(store, id);
      if (note) {
        store.notes = store.notes.filter((n) => n.id !== id);
        store.trash.unshift({ note: { ...note, hidden: true }, deleted_at: Date.now() });
        save(store);
        emit("notes-changed", { id });
      }
      return undefined as T;
    }
    case "list_trash": {
      // 按删除时间倒序，标题/摘要在这里算好，前端拿到就能直接渲染
      const items: TrashItem[] = store.trash
        .slice()
        .sort((x, y) => y.deleted_at - x.deleted_at)
        .map((entry) => ({
          id: entry.note.id,
          kind: entry.note.kind,
          title: trashTitle(entry.note),
          preview: previewOf(entry.note),
          deleted_at: entry.deleted_at,
        }));
      return items as T;
    }
    case "restore_note": {
      const id = a.id as string;
      const index = store.trash.findIndex((entry) => entry.note.id === id);
      if (index >= 0) {
        const entry = store.trash[index];
        store.trash.splice(index, 1);
        // 恢复：取消隐藏、取消置顶、更新时间刷新（契约 §12.2）
        const note: Note = { ...entry.note, hidden: false, pinned: false, updated_at: Date.now() };
        store.notes.push(note);
        save(store);
        emit("notes-changed", { id });
      }
      return undefined as T;
    }
    case "empty_trash": {
      const count = store.trash.length;
      store.trash = [];
      save(store);
      emit("notes-changed", {});
      return count as T;
    }
    case "get_note_version": {
      const id = a.id as string;
      const ts = a.ts as number;
      const entry = store.versions.find((version) => version.note.id === id && version.ts === ts);
      if (!entry) throw new Error("这个版本已经不在了");
      return {
        ts: entry.ts,
        title: versionTitle(entry.note),
        content: entry.note.content,
        todos: entry.note.todos.map((item) => ({ ...item })),
        items: entry.note.items.map((item) => ({ ...item })),
        chars: versionChars(entry.note),
      } as T;
    }
    case "list_note_versions": {
      const id = a.id as string;
      const list = store.versions
        .filter((entry) => entry.note.id === id)
        .sort((x, y) => y.ts - x.ts)
        .map((entry) => ({
          ts: entry.ts,
          title: versionTitle(entry.note),
          chars: versionChars(entry.note),
          preview: versionPreview(entry.note),
        }));
      return list as T;
    }
    case "restore_note_version": {
      const id = a.id as string;
      const ts = a.ts as number;
      const version = store.versions.find((entry) => entry.note.id === id && entry.ts === ts);
      if (!version) throw new Error("这个版本已经不在了");
      const index = store.notes.findIndex((note) => note.id === id);
      if (index < 0) throw new Error("便签不存在");
      const current = store.notes[index];
      // 恢复前先把当前内容也留一份：恢复错了还能再撤回来
      if (
        current.title !== version.note.title ||
        current.content !== version.note.content ||
        JSON.stringify(current.todos) !== JSON.stringify(version.note.todos) ||
        JSON.stringify(current.items) !== JSON.stringify(version.note.items)
      ) {
        pushVersion(store, current);
      }
      const restored: Note = {
        ...current,
        title: version.note.title,
        content: version.note.content,
        todos: version.note.todos.map((item) => ({ ...item })),
        items: version.note.items.map((item) => ({ ...item })),
        updated_at: Date.now(),
      };
      store.notes[index] = restored;
      save(store);
      emit("notes-changed", { id });
      return restored as T;
    }
    case "create_note": {
      const note = newNote(
        a.kind as "memo" | "todo" | "vault",
        store.settings,
        (a.at as { x: number; y: number } | null) ?? null,
      );
      store.notes.push(note);
      save(store);
      emit("notes-changed", { id: note.id });
      return note as T;
    }
    case "open_note_window":
    case "close_note_window": {
      return undefined as T;
    }
    case "save_window_state": {
      const id = a.id as string;
      const state = a.state as { x: number; y: number; width: number; height: number };
      const note = findNote(store, id);
      if (note) {
        note.x = state.x;
        note.y = state.y;
        note.width = state.width;
        note.height = state.height;
        save(store); // 窗口移动只存盘，不派发 notes-changed，避免面板反复刷新
      }
      return undefined as T;
    }
    case "set_pinned": {
      const id = a.id as string;
      const note = findNote(store, id);
      if (note) {
        note.pinned = a.pinned as boolean;
        note.updated_at = Date.now();
        save(store);
        emit("notes-changed", { id });
      }
      return undefined as T;
    }
    case "set_note_collapsed": {
      const id = a.id as string;
      const note = findNote(store, id);
      if (note) {
        note.collapsed = !!a.collapsed;
        note.updated_at = Date.now();
        save(store);
        emit("notes-changed", { id });
        return note as T;
      }
      return undefined as T;
    }
    case "set_note_size": {
      const id = a.id as string;
      const note = findNote(store, id);
      if (note) {
        note.width = a.width as number;
        note.height = a.height as number;
        note.updated_at = Date.now();
        save(store);
        emit("notes-changed", { id });
        return note as T;
      }
      return undefined as T;
    }
    case "set_note_locked": {
      const id = a.id as string;
      const note = findNote(store, id);
      if (note) {
        note.locked = !!a.locked;
        note.updated_at = Date.now();
        save(store);
        emit("notes-changed", { id });
        return note as T;
      }
      return undefined as T;
    }
    case "export_notes": {
      console.info("[mock] 导出便签（浏览器里只打印，桌面端会写到桌面）");
      return "（浏览器 mock）桌面\\小梦备忘录导出" as T;
    }
    case "restore_from_backup": {
      console.info("[mock] 从备份恢复（浏览器里没有备份文件）");
      return 0 as T;
    }
    case "import_notes_file": {
      // 浏览器里没有系统的文件选择框，按“用户取消”处理（契约 §16.8：取消要静默）
      console.info("[mock] 导入备份文件（浏览器里没有文件选择框，视为取消）");
      return null as T;
    }
    case "open_panel": {
      if (typeof location !== "undefined") location.assign("/?surface=panel");
      return undefined as T;
    }
    case "open_settings": {
      if (typeof location !== "undefined") location.assign("/?surface=settings");
      return undefined as T;
    }
    case "open_quick": {
      if (typeof location !== "undefined") location.assign("/?surface=quick");
      return undefined as T;
    }
    case "close_quick": {
      if (typeof window !== "undefined") window.close();
      return undefined as T;
    }
    case "set_reminder": {
      const id = a.id as string;
      const at = a.at as number | null;
      const note = findNote(store, id);
      if (note) {
        note.reminder_at = at;
        note.reminder_done = false;
        note.updated_at = Date.now();
        save(store);
        emit("notes-changed", { id });
      }
      return undefined as T;
    }
    case "snooze_reminder": {
      const id = a.id as string;
      const minutes = a.minutes as number;
      const note = findNote(store, id);
      if (note) {
        note.reminder_at = Date.now() + minutes * 60_000;
        note.reminder_done = false;
        note.updated_at = Date.now();
        save(store);
        emit("notes-changed", { id });
      }
      return undefined as T;
    }
    case "dismiss_reminder": {
      const id = a.id as string;
      const note = findNote(store, id);
      if (note) {
        note.reminder_done = true;
        note.updated_at = Date.now();
        save(store);
        emit("notes-changed", { id });
      }
      return undefined as T;
    }
    case "save_settings": {
      const settings = a.settings as Settings;
      store.settings = { ...store.settings, ...settings };
      save(store);
      emit("settings-changed", store.settings);
      return store.settings as T;
    }
    case "get_autostart": {
      return store.autostart as T;
    }
    case "set_autostart": {
      const enabled = a.enabled as boolean;
      store.autostart = enabled;
      store.settings.launch_on_startup = enabled;
      save(store);
      emit("settings-changed", store.settings);
      return enabled as T;
    }
    case "open_data_folder": {
      console.info("[mock] 打开数据目录（浏览器里无操作）");
      return undefined as T;
    }
    case "quit_app": {
      console.info("[mock] 退出应用（浏览器里无操作）");
      return undefined as T;
    }
    default:
      throw new Error("[mock] 未实现的命令: " + cmd);
  }
}