import type { Settings } from "./types";
import { api } from "./api";
import { onAppEvent } from "./events";

/**
 * 纸色（契约 §16.5）。
 * - auto：19:00–07:00 之间用夜间纸色，其余时间浅色
 * - day / night：用户明确选了就一直用
 */
export type ThemeMode = Settings["theme_mode"];

const CACHE_KEY = "xm-theme-mode";
let currentMode: ThemeMode = "auto";
let timerStarted = false;
let themeTimer = 0;

function normalizeMode(mode: unknown): ThemeMode {
  return mode === "day" || mode === "night" ? mode : "auto";
}

/** 根据模式和时间算出真正要用的纸色。 */
function resolveTheme(mode: ThemeMode, now = new Date()): "day" | "night" {
  if (mode === "day" || mode === "night") return mode;
  const hour = now.getHours();
  return hour >= 19 || hour < 7 ? "night" : "day";
}

/** 把纸色写到 html[data-theme]（CSS 变量在 tokens.css 里按这个属性切换）。 */
export function applyTheme(mode: ThemeMode): void {
  currentMode = normalizeMode(mode);
  const resolved = resolveTheme(currentMode);
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem(CACHE_KEY, currentMode);
  } catch {
    // 隐私模式/配额满了都不影响本次显示，下次启动退回 auto
  }
}

function readCachedMode(): ThemeMode {
  try {
    return normalizeMode(localStorage.getItem(CACHE_KEY));
  } catch {
    return "auto";
  }
}

/**
 * 启动时先按上次缓存的模式上色（避免先闪一下浅色），
 * 再读后端设置校正；设置里换了纸色会收到 settings-changed。
 */
export async function initTheme(): Promise<void> {
  applyTheme(readCachedMode());

  if (!timerStarted) {
    timerStarted = true;
    // auto 模式跨过 19:00 / 07:00 时不用重启也能换色
    themeTimer = window.setInterval(() => {
      if (currentMode === "auto") document.documentElement.dataset.theme = resolveTheme("auto");
    }, 60_000);
  }

  void onAppEvent<Settings>("settings-changed", (settings) => {
    if (settings && settings.theme_mode) applyTheme(settings.theme_mode);
  }).catch(() => {
    // 事件通道不可用时只影响即时切换，下次启动仍会读到设置
  });

  try {
    const snapshot = await api.getSnapshot();
    applyTheme(snapshot.settings.theme_mode);
  } catch (error) {
    console.warn("读取纸色设置失败，先用 auto", error);
  }
}

// 窗口关闭/进 bfcache 时停掉定时器，别让已经离开的页面继续跑
window.addEventListener("pagehide", () => {
  if (themeTimer) {
    window.clearInterval(themeTimer);
    themeTimer = 0;
  }
  timerStarted = false;
});
