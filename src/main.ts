import "./styles/tokens.css";
import "./styles/paper.css";
import "./styles/app.css";
import { initTheme } from "./shared/theme";
import type { Surface } from "./shared/types";

/**
 * 小梦备忘录 · 单页多窗口入口
 * URL 参数 surface 决定当前窗口渲染什么：
 *   ?surface=sticky&id=<noteId>   便签窗口
 *   ?surface=panel                召唤面板（全部便签 + 搜索）
 *   ?surface=settings             设置页
 *   ?surface=reminder&id=<noteId> 提醒弹窗
 *   ?surface=quick                快速记录浮层
 */
const params = new URLSearchParams(location.search);
const requested = params.get("surface") ?? "sticky";
const noteId = params.get("id") ?? "";

type SurfaceModule = { mount: (root: HTMLElement, ctx: { noteId: string }) => Promise<void> | void };

const surfaces: Record<Surface, () => Promise<SurfaceModule>> = {
  sticky: () => import("./surfaces/sticky"),
  panel: () => import("./surfaces/panel"),
  settings: () => import("./surfaces/settings"),
  reminder: () => import("./surfaces/reminder"),
  quick: () => import("./surfaces/quick"),
};

async function boot(): Promise<void> {
  const app = document.getElementById("app")!;
  // 先上色再加载界面：有缓存时同步生效，不会先闪一下浅色
  void initTheme();
  app.dataset.surface = requested;
  const loader = surfaces[requested as Surface];
  if (!loader) {
    app.textContent = "未知窗口类型: " + requested;
    return;
  }
  try {
    const mod = await loader();
    await mod.mount(app, { noteId });
  } catch (error) {
    // 某个窗口没加载起来时至少给一句人话，别留一片透明的空白
    console.error("窗口加载失败", error);
    app.textContent = "小梦备忘录打开失败了，关掉这个窗口再试一次。";
  }
}

void boot();
