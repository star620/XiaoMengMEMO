/** 一些很小的 DOM / 函数工具，保持可读，不引第三方库。 */

/** 防抖：连续触发时只在停下来 ms 毫秒后执行一次；cancel() 可以取消。 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  readonly pending: boolean;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: number | undefined;
  const wrapped = ((...args: A) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  }) as Debounced<A>;
  wrapped.cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  Object.defineProperty(wrapped, "pending", { get: () => timer !== undefined });
  return wrapped;
}

/** 把数字限制在 [min, max] 区间内。 */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 转义 HTML，避免用户输入被当成标签（例如面板摘要）。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 生成一个本地唯一 id（新建待办行时用）。 */
export function uid(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return Math.random().toString(36).slice(2, 10);
}

/** $ 的简写：在容器里找元素，找不到直接抛错，方便早发现结构写错。 */
export function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error("找不到元素: " + selector);
  return el;
}

