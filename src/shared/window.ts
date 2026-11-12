/**
 * 窗口相关的小封装：拖动、隐藏/关闭、监听窗口位置尺寸变化。
 * 浏览器里全部安全地降级成 no-op，方便 mock 调试。
 */
import { isTauri } from "./env";

type WindowApi = typeof import("@tauri-apps/api/window");

async function currentWindow(): Promise<ReturnType<WindowApi["getCurrentWindow"]> | null> {
  if (!isTauri()) return null;
  const w = await import("@tauri-apps/api/window");
  return w.getCurrentWindow();
}

/** 无边框窗口拖动：按住便签顶部拖动区时调用。 */
export async function startDragging(): Promise<void> {
  const win = await currentWindow();
  if (!win) return;
  try {
    await win.startDragging();
  } catch {
    /* 拖动失败不影响使用 */
  }
}

/** 最小化当前窗口（窗口壳的最小化按钮）。 */
export async function minimizeCurrent(): Promise<void> {
  const win = await currentWindow();
  if (!win) return;
  try {
    await win.minimize();
  } catch {
    /* 最小化失败不影响使用 */
  }
}

/** 隐藏当前窗口（面板/设置用 hide 保留实例，下次打开更快）。 */
export async function hideCurrent(): Promise<void> {
  const win = await currentWindow();
  if (win) {
    try {
      await win.hide();
      return;
    } catch {
      /* 继续走浏览器兜底 */
    }
  }
  if (!isTauri()) window.close();
}

/** 关闭当前窗口（提醒弹窗、便签关闭用）。 */
export async function closeCurrent(): Promise<void> {
  const win = await currentWindow();
  if (win) {
    try {
      await win.close();
      return;
    } catch {
      /* ignore */
    }
  }
  if (!isTauri()) window.close();
}

/** 监听窗口移动/缩放，debounce 后回调位置尺寸；返回取消监听的函数。 */
export async function watchWindowState(
  cb: (state: { x: number; y: number; width: number; height: number }) => void,
): Promise<() => void> {
  const win = await currentWindow();
  if (!win) return () => {};
  let timer: number | undefined;
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      try {
        const [pos, size, scale] = await Promise.all([win.outerPosition(), win.innerSize(), win.scaleFactor()]);
        cb({
          x: Math.round(pos.x / scale),
          y: Math.round(pos.y / scale),
          width: Math.round(size.width / scale),
          height: Math.round(size.height / scale),
        });
      } catch {
        /* 窗口可能已经关掉了 */
      }
    }, 600);
  };
  const unMove = await win.onMoved(schedule);
  const unResize = await win.onResized(schedule);
  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    unMove();
    unResize();
  };
}