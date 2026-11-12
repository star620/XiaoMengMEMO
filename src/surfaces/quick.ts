import { api } from "../shared/api";
import { closeCurrent } from "../shared/window";

/**
 * 快速记录浮层（契约 §16.4）。
 * 一个只有输入框的小窗：Enter 保存并打开便签，Shift+Enter 换行，Esc 直接关。
 * 不套窗口壳，窗体和纸面都在 .xm-quick 里，样式由 paper.css 负责。
 */
export function mount(root: HTMLElement): void {
  root.innerHTML = `
    <div class="xm-quick">
      <div class="xm-quick__paper">
        <div
          class="xm-quick__input"
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          aria-label="快速记录"
          data-placeholder="记点什么…"
          spellcheck="false"
        ></div>
        <div class="xm-quick__bar">
          <span class="xm-quick__hint">Enter 保存 · Shift+Enter 换行 · Esc 关闭</span>
          <div class="xm-quick__actions">
            <button class="xm-btn" type="button" data-act="save">记下来</button>
            <button class="xm-btn xm-btn--ghost" type="button" data-act="close">取消</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // 模板就在上面，节点一定存在；这里用断言免得闭包里反复判空
  const input = root.querySelector<HTMLElement>(".xm-quick__input")!;
  const hint = root.querySelector<HTMLElement>(".xm-quick__hint")!;
  const saveBtn = root.querySelector<HTMLButtonElement>('[data-act="save"]')!;
  const closeBtn = root.querySelector<HTMLButtonElement>('[data-act="close"]')!;

  const defaultHint = hint.textContent ?? "";
  let busy = false;
  let closing = false;

  function placeCaretAtEnd(): void {
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function setBusy(next: boolean): void {
    busy = next;
    saveBtn.disabled = next;
    closeBtn.disabled = next;
    saveBtn.textContent = next ? "保存中…" : "记下来";
    hint.textContent = next ? "正在保存…" : defaultHint;
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    try {
      await api.closeQuick();
    } catch (error) {
      console.error("关闭快速记录失败", error);
      try {
        await closeCurrent();
      } catch {
        // 关不掉也不该卡住，后端窗口管理器会兜底
      }
    }
  }

  async function save(): Promise<void> {
    if (busy) return;
    const content = input.innerText.replace(/\u00a0/g, " ").trim();
    if (!content) {
      // 空内容不建便签，直接关掉（契约 §16.4）
      await close();
      return;
    }
    setBusy(true);
    let createdId = "";
    let savedOk = false;
    try {
      const note = await api.createNote("memo");
      createdId = note.id;
      const saved = await api.saveNote({ ...note, content, updated_at: Date.now() });
      savedOk = true;
      await api.openNoteWindow(saved.id);
      await close();
    } catch (error) {
      console.error("快速记录保存失败", error);
      // 先建后存失败会留下一张空纸：把刚建的便签删掉，别让面板里多一条垃圾。
      if (createdId && !savedOk) {
        try {
          await api.deleteNote(createdId);
        } catch (cleanupError) {
          console.error("清理快速记录空便签失败", cleanupError);
        }
      }
      setBusy(false);
      hint.textContent = createdId && !savedOk ? "没存上，已经撤掉了" : "没存上，再按一次 Enter 试试";
      window.setTimeout(() => {
        if (!busy) hint.textContent = defaultHint;
      }, 2400);
    }
  }

  /**
   * 后端把浮层藏起来而不是销毁，下次按快捷键会复用同一个窗口并派发 xm-quick-open。
   * 这里必须把上次的输入和状态清干净，否则再打开还是旧文字、按钮还卡在"保存中"。
   */
  function resetForReopen(): void {
    closing = false;
    setBusy(false);
    input.textContent = "";
    hint.textContent = defaultHint;
    requestAnimationFrame(() => {
      input.focus();
      placeCaretAtEnd();
    });
  }
  window.addEventListener("xm-quick-open", resetForReopen);

  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) void close();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
  });

  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (text == null) return;
    event.preventDefault();
    document.execCommand("insertText", false, text);
  });

  saveBtn.addEventListener("click", () => void save());
  closeBtn.addEventListener("click", () => void close());

  requestAnimationFrame(() => {
    input.focus();
    placeCaretAtEnd();
  });
  window.addEventListener(
    "focus",
    () => {
      if (document.activeElement !== input && !busy) input.focus();
    },
    { once: true },
  );
}
