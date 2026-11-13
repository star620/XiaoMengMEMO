import { api } from "./api";
import { onAppEvent } from "./events";

/** 原生瞬切作为对照；smooth 在固定承载窗口内改变真实布局宽高，不缩放文字。 */
type FeelMode = "snap" | "fade" | "veil" | "smooth";
type Target = { width: number; height: number };

export function createSizeFeel(note: HTMLElement, paper: HTMLElement, initial: Target & { id: string }) {
  const configured = (globalThis as { __XM_SIZE_FEEL__?: FeelMode }).__XM_SIZE_FEEL__;
  const mode: FeelMode = configured === "fade" || configured === "veil" || configured === "smooth" ? configured : "snap";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const veil = document.createElement("div");
  veil.className = "xm-size-veil";
  veil.setAttribute("aria-hidden", "true");
  veil.hidden = true;
  paper.append(veil);
  let generation = 0;
  let abort = new AbortController();
  let paperAnimation: Animation | null = null;
  let veilAnimation: Animation | null = null;
  let pressed: HTMLElement | null = null;
  let pressTimer = 0;
  let geometryAnimation: Animation | null = null;
  let revision = 0;
  let anchored = false;
  let listenerReady = Promise.resolve();

  function finishEntry() {
    for (const animation of paper.getAnimations({ subtree: true })) {
      if (animation instanceof CSSAnimation && animation.playState === "running" &&
          (animation.animationName === "xm-pop-in" || animation.animationName === "xm-note-in")) animation.finish();
    }
  }

  if (mode === "smooth") {
    const size = (globalThis as { __XM_SIZE_INITIAL__?: Target }).__XM_SIZE_INITIAL__ ?? initial;
    note.dataset.sizeHost = "fixed";
    note.style.width = `${size.width}px`;
    note.style.height = `${size.height}px`;
    listenerReady = onAppEvent<Target & { revision: number }>("note-size-goal", goal => {
      if (goal.revision <= revision) return;
      revision = goal.revision;
      finishEntry();
      if (!anchored) {
        // 改变旋转原点时补偿一次静态平移，保留当前纸面位置，之后右上角不随宽高漂移。
        const before = paper.getBoundingClientRect();
        paper.style.transformOrigin = "100% 0";
        const after = paper.getBoundingClientRect();
        paper.style.translate = `${before.left - after.left}px ${before.top - after.top}px`;
        anchored = true;
      }
      const from = { width: getComputedStyle(note).width, height: getComputedStyle(note).height };
      geometryAnimation?.cancel();
      note.style.width = `${goal.width}px`;
      note.style.height = `${goal.height}px`;
      note.dataset.sizeFeel = reduced.matches ? "snap" : "smooth";
      note.dataset.resizing = "";
      const animation = !reduced.matches &&
          (Math.abs(parseFloat(from.width) - goal.width) > .1 || Math.abs(parseFloat(from.height) - goal.height) > .1)
        ? note.animate([from, { width: `${goal.width}px`, height: `${goal.height}px` }], {
          duration: 160, easing: "cubic-bezier(.22,.61,.36,1)",
        }) : null;
      geometryAnimation = animation;
      void (async () => {
        try {
          await animation?.finished;
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          if (revision !== goal.revision) return;
          geometryAnimation = null;
          await api.finishNoteResize(initial.id, goal.revision, note.offsetWidth, note.offsetHeight);
          if (revision === goal.revision) delete note.dataset.resizing;
        } catch (error) {
          if (revision === goal.revision) console.warn("便签尺寸收尾失败", error);
        }
      })();
    }).then(() => {});
  }

  function press(button: HTMLElement): void {
    if (pressed && pressed !== button) delete pressed.dataset.sizePressed;
    pressed = button;
    button.dataset.sizePressed = "";
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = window.setTimeout(() => {
      if (pressed) delete pressed.dataset.sizePressed;
      pressed = null;
      pressTimer = 0;
    }, 80);
  }
  note.addEventListener("pointerdown", event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-size]");
    if (button) press(button);
  }, true);

  function stop(): void {
    abort.abort();
    paperAnimation?.cancel();
    paperAnimation = null;
    // 保留遮罩已达到的覆盖程度，连续请求不能中途露出旧布局。
    const opacity = veil.hidden ? "0" : getComputedStyle(veil).opacity;
    veilAnimation?.cancel();
    veilAnimation = null;
    veil.style.opacity = opacity;
  }

  function layoutReady(target: Target, signal: AbortSignal) {
    let checkUnchanged = () => {};
    const ready = new Promise<boolean>(resolve => {
      let done = false;
      let scheduled = false;
      const timer = window.setTimeout(() => finish(false), 1200);
      const matches = () => Math.abs(innerWidth - target.width) < 1 && Math.abs(innerHeight - target.height) < 1;
      function finish(ok: boolean) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        removeEventListener("resize", resize);
        signal.removeEventListener("abort", cancelled);
        resolve(ok);
      }
      function cancelled() { finish(false); }
      function resize() {
        if (scheduled || !matches()) return;
        scheduled = true;
        requestAnimationFrame(() => requestAnimationFrame(() => finish(!signal.aborted && matches())));
      }
      checkUnchanged = resize;
      addEventListener("resize", resize);
      signal.addEventListener("abort", cancelled, { once: true });
    });
    return { ready, checkUnchanged: () => checkUnchanged() };
  }

  async function animateVeil(from: number, to: number, duration: number) {
    const animation = veil.animate([{ opacity: from }, { opacity: to }], {
      duration, easing: "cubic-bezier(.22,.61,.36,1)", fill: "forwards",
    });
    veilAnimation = animation;
    try { await animation.finished; } catch { return false; }
    if (veilAnimation !== animation) return false;
    veil.style.opacity = String(to);
    animation.cancel();
    veilAnimation = null;
    return true;
  }

  async function run<T>(change: () => Promise<T>, target: Target): Promise<T> {
    if (mode === "smooth") {
      await listenerReady;
      return change();
    }
    const own = ++generation;
    stop();
    abort = new AbortController();
    const signal = abort.signal;
    const effective = reduced.matches ? "snap" : mode;
    note.dataset.sizeFeel = effective;
    note.dataset.resizing = "";
    // 快速点中尚在入场的菜单时，也不让旧 scale 动画叠到尺寸切换上。
    finishEntry();
    if (effective === "veil") {
      veil.hidden = false;
      const opacity = Number.parseFloat(veil.style.opacity || "0");
      if (opacity < 1 && !await animateVeil(opacity, 1, 40)) {
        if (reduced.matches) return change();
        throw new Error("尺寸切换已取消");
      }
      if (own !== generation || signal.aborted) throw new Error("尺寸切换已取消");
    } else {
      veil.hidden = true;
      veil.style.opacity = "0";
    }
    const layout = layoutReady(target, signal);
    if (effective === "fade") {
      paperAnimation = paper.animate([{ opacity: 0.8 }, { opacity: 1 }], {
        duration: 60, easing: "cubic-bezier(.22,.61,.36,1)",
      });
    }
    try {
      const result = await change();
      // 同档重复选择可能没有 resize 事件；调用返回后仍可用双rAF完成清理。
      layout.checkUnchanged();
      void (async () => {
        const ready = await layout.ready;
        if (own !== generation) return;
        if (effective === "veil" && ready) await animateVeil(1, 0, 80);
        if (own !== generation) return;
        veil.hidden = true;
        veil.style.opacity = "0";
        delete note.dataset.resizing;
      })();
      return result;
    } catch (error) {
      if (own === generation) {
        stop(); veil.hidden = true; delete note.dataset.resizing;
      }
      throw error;
    }
  }
  note.dataset.sizeFeel = reduced.matches ? "snap" : mode;
  reduced.addEventListener("change", () => {
    if (mode === "smooth") {
      note.dataset.sizeFeel = reduced.matches ? "snap" : "smooth";
      if (reduced.matches && geometryAnimation?.playState === "running") geometryAnimation.finish();
      return;
    }
    if (reduced.matches) {
      ++generation; stop(); veil.hidden = true; delete note.dataset.resizing;
      note.dataset.sizeFeel = "snap";
    }
  });
  return { run, press };
}
