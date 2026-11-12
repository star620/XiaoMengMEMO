/**
 * 运行环境判断。
 * - 桌面端（Tauri）：window 上有 __TAURI_INTERNALS__，所有命令走真实 IPC；
 * - 浏览器：没有它，开发模式下按需走 src/shared/mock.ts 的 localStorage 假数据，方便直接 npm run dev 调 UI；生产包里不会包含 mock。
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
