/**
 * 自绘窗口壳（面板 / 设置 / 提醒共用）
 *
 * 为什么需要它：这三个窗口是"无边框 + 透明"的纸窗口，没有系统标题栏，
 * 所以品牌名、拖动区、最小化/关闭都得自己画。便签窗口不用它（便签自带上沿拖动区）。
 *
 * 结构（视觉 paper.css 按这个选择器写样式）：
 *   .xm-chrome[data-surface]
 *     > header.xm-chrome__head          ← 拖动区（按住标题条任意空白处拖窗）
 *         > span.xm-chrome__title
 *         > div.xm-chrome__actions > button.xm-winbtn--min / .xm-winbtn--close
 *     > div.xm-chrome__body             ← 各个 surface 的根节点放这里
 *
 * 拖动为什么不用 data-tauri-drag-region：Tauri 只认"鼠标按下的那个元素自己身上"
 * 有没有这个属性，按在标题文字（子元素 span）上就不算拖动区 —— 于是整条标题条
 * 基本只剩左右两小段空白能拖。这里改成自己监听 pointerdown 再调 startDragging()，
 * 整条标题条都能拖（按钮除外）。
 *
 * 浏览器 mock 里窗口动作是安全的 no-op，可以先调 UI。
 */
import { escapeHtml } from "./dom";
import { closeCurrent, hideCurrent, minimizeCurrent, startDragging } from "./window";

export type ChromeSurface = "panel" | "settings" | "reminder";

/** 三种窗口的默认标题 */
const TITLES: Record<ChromeSurface, string> = {
  panel: "小梦备忘录",
  settings: "设置",
  reminder: "提醒",
};

export interface ChromeOptions {
  surface: ChromeSurface;
  /** 标题，不传就用默认 */
  title?: string;
  /** 点关闭按钮前先做的事（提醒窗口用它先把提醒标记掉），做完再关窗 */
  beforeClose?: () => Promise<void> | void;
}

/**
 * 把窗口壳挂到 #app 上，返回放内容的容器。
 * 调用后 surface 只需要往返回的 body 里写自己的 DOM。
 */
export function mountChrome(root: HTMLElement, options: ChromeOptions): HTMLElement {
  const { surface } = options;
  const title = options.title ?? TITLES[surface];

  root.classList.add("xm-shell");
  root.innerHTML =
    '<div class="xm-chrome" data-surface="' + surface + '">' +
    '<header class="xm-chrome__head">' +
    '<span class="xm-chrome__title">' + escapeHtml(title) + "</span>" +
    '<div class="xm-chrome__actions">' +
    '<button type="button" class="xm-winbtn xm-winbtn--min" data-act="min" aria-label="最小化" title="最小化"></button>' +
    '<button type="button" class="xm-winbtn xm-winbtn--close" data-act="close" aria-label="关闭" title="关闭"></button>' +
    "</div>" +
    "</header>" +
    '<div class="xm-chrome__body"></div>' +
    "</div>";

  const head = root.querySelector<HTMLElement>(".xm-chrome__head");
  const body = root.querySelector<HTMLElement>(".xm-chrome__body");
  const actions = root.querySelector<HTMLElement>(".xm-chrome__actions");
  if (!head || !body || !actions) {
    throw new Error("窗口壳结构没有搭出来");
  }

  // 整条标题条都能拖窗：按下就交给系统拖动，按钮和输入框除外
  head.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest("button, a, input, textarea, select, [data-no-drag]")) return;
    event.preventDefault();
    void startDragging();
  });

  // 按钮在拖动区里面：按下时别冒泡给标题条，否则会被当成拖动窗口
  actions.addEventListener("pointerdown", (event) => event.stopPropagation());

  actions.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!button || button.dataset.act === "min") {
      if (button) void minimizeCurrent();
      return;
    }
    if (button.dataset.act !== "close") return;
    event.preventDefault();
    button.setAttribute("disabled", "1");
    void (async () => {
      try {
        if (options.beforeClose) await options.beforeClose();
      } catch (error) {
        // 关闭前的收尾失败也不能把窗口卡住
        console.error("关闭前处理失败", error);
      }
      // 纸窗轻轻收一下再消失（视觉的 .xm-chrome[data-closing="1"] 动画，约 140ms）
      const chromeEl = root.querySelector<HTMLElement>(".xm-chrome");
      if (chromeEl) {
        chromeEl.dataset.closing = "1";
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        await new Promise<void>((resolve) => window.setTimeout(resolve, reduceMotion ? 0 : 150));
      }
      // 提醒窗是真关（后端是单例，下次会重建）；面板/设置是藏起来，下次打开更快
      if (surface === "reminder") await closeCurrent();
      else await hideCurrent();
    })();
  });

  return body;
}
