/**
 * 后端事件的统一订阅口。
 * - Tauri：监听 Rust 端 emit 的 notes-changed / settings-changed / reminder-due / note-focus；
 * - 浏览器 mock：监听 mock.ts 派发的同名 CustomEvent（同窗口/跨标签页都能收到）。
 * 事件名与 Rust 端保持一致，见 docs/ui-contract.md 与任务书。
 */
import { isTauri } from "./env";

export type Unlisten = () => void;

export async function onAppEvent<T = unknown>(name: string, cb: (payload: T) => void): Promise<Unlisten> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    const un = await listen<T>(name, (event) => cb(event.payload));
    return () => un();
  }
  const handler = (event: Event) => cb((event as CustomEvent<T>).detail);
  const key = "xm-mock:" + name;
  window.addEventListener(key, handler);
  return () => window.removeEventListener(key, handler);
}

/**
 * 订阅事件，订阅失败只记一条警告，不影响页面本身。
 * 界面模块都用它，省得每个调用点都写一遍 .catch。
 */
export async function subscribe<T = unknown>(
  name: string,
  cb: (payload: T) => void,
): Promise<Unlisten> {
  try {
    return await onAppEvent<T>(name, cb);
  } catch (error) {
    console.warn("订阅事件失败：" + name, error);
    return () => {};
  }
}
