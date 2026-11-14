/**
 * 设置（surface=settings）
 *
 * 这里只做三件事：读设置、改设置、立刻存。
 * 没有"保存"按钮——用户是编程小白，改完就应该生效。
 */
import { api } from "../shared/api";
import { mountChrome } from "../shared/chrome";
import { query } from "../shared/dom";
import { icons } from "../shared/icons";
import { subscribe } from "../shared/events";
import { NOTE_COLORS } from "../shared/colors";
import { hideCurrent } from "../shared/window";
import { applyTheme } from "../shared/theme";
import type { Settings } from "../shared/types";

/** 版本号由 vite.config.ts 从 package.json 注入，避免两处手改不同步 */
const APP_VERSION = __APP_VERSION__;


export async function mount(root: HTMLElement, _ctx: { noteId: string }): Promise<void> {
  // 无边框窗口：窗口壳负责标题、拖动和最小化/关闭；这里只排设置内容
  const body = mountChrome(root, { surface: "settings" });
  body.innerHTML =
    '<section class="xm-settings">' +
    // 新手引导：第一次用会自动展开；"关于"里可以再看
    '<section class="xm-settings__group" data-guide hidden>' +
    '<h3 class="xm-settings__group-title">新手引导</h3>' +
    '<div class="xm-row"><div class="xm-row__label">点纸面就能写</div></div>' +
    '<div class="xm-row"><div class="xm-row__label">保存</div>' +
    '<kbd class="xm-kbd">Ctrl + S</kbd></div>' +
    '<div class="xm-row"><div class="xm-row__label">长内容</div>' +
    '<span class="xm-keys"><kbd class="xm-kbd">滚轮</kbd></span></div>' +
    '<div class="xm-row"><div class="xm-row__label">搜索便签</div>' +
    '<kbd class="xm-kbd">Ctrl + F</kbd></div>' +
    '<div class="xm-row"><div class="xm-row__label">开始用吧</div>' +
    '<button class="xm-btn xm-btn--primary" type="button" data-act="guide-done">知道了</button></div>' +
    "</section>" +
    '<section class="xm-settings__group">' +
    '<h3 class="xm-settings__group-title">启动与行为</h3>' +
    '<div class="xm-row"><div class="xm-row__label">开机自动启动</div>' +
    '<button class="xm-switch" type="button" role="switch" aria-checked="0" aria-label="开机自动启动" data-act="autostart"></button>' +
    "</div>" +
    '<div class="xm-row"><div class="xm-row__label">勾选音效</div>' +
    '<button class="xm-switch" type="button" role="switch" aria-checked="0" aria-label="勾选音效" data-act="sound"></button>' +
    "</div>" +
    '<div class="xm-row"><div class="xm-row__label">提醒声音</div>' +
    '<button class="xm-switch" type="button" role="switch" aria-checked="0" aria-label="提醒声音" data-act="reminder-sound"></button>' +
    "</div>" +
    '<div class="xm-row"><div class="xm-row__label">纸色</div>' +
    '<div class="xm-seg" role="group" aria-label="纸色" data-act="theme">' +
    '<button class="xm-seg__item" type="button" data-theme="auto">跟随时间</button>' +
    '<button class="xm-seg__item" type="button" data-theme="day">浅色</button>' +
    '<button class="xm-seg__item" type="button" data-theme="night">深色</button>' +
    "</div></div>" +
    '<div class="xm-row"><div class="xm-row__label">大小切换' +
    "<small>直接跳最稳、最快；柔光先把纸盖一下再淡开，每次多约 0.2 秒。</small></div>" +
    '<div class="xm-seg" role="group" aria-label="大小切换" data-act="size-feel">' +
    '<button class="xm-seg__item" type="button" data-feel="snap">直接跳</button>' +
    '<button class="xm-seg__item" type="button" data-feel="veil">柔光</button>' +
    "</div></div>" +
    "</section>" +
    '<section class="xm-settings__group">' +
    '<h3 class="xm-settings__group-title">新建便签</h3>' +
    '<div class="xm-row"><div class="xm-row__label">默认配色</div>' +
    '<div class="xm-colors" role="group" aria-label="默认配色" data-act="colors"></div>' +
    "</div>" +
    '<div class="xm-row"><div class="xm-row__label">默认字号</div>' +
    '<div class="xm-seg" role="group" aria-label="默认字号" data-act="scale">' +
    '<button class="xm-seg__item" type="button" data-scale="0.9">小</button>' +
    '<button class="xm-seg__item" type="button" data-scale="1">中</button>' +
    '<button class="xm-seg__item" type="button" data-scale="1.15">大</button>' +
    "</div></div>" +
    '<div class="xm-row"><div class="xm-row__label">Markdown 排版</div>' +
    '<button class="xm-switch" type="button" role="switch" aria-checked="0" aria-label="Markdown 排版" data-act="markdown"></button>' +
    "</div>" +
    "</section>" +
    '<section class="xm-settings__group">' +
    '<h3 class="xm-settings__group-title">数据</h3>' +
    '<div class="xm-row"><div class="xm-row__label">数据文件夹' +
    "<small>便签都在这里，复制走就是备份。</small></div>" +
    '<button class="xm-btn" type="button" data-act="data-folder">' + icons.folder + " 打开</button>" +
    "</div>" +
    '<div class="xm-row"><div class="xm-row__label">导出全部便签' +
    "<small>在桌面建一个文件夹，里面是可读的 Markdown 和一份 json。</small></div>" +
    '<button class="xm-btn" type="button" data-act="export">' + icons.download + " 导出</button>" +
    "</div>" +
    '<div class="xm-row"><div class="xm-row__label">备份文件' +
    "<small>从导出的 json 里补回便签，同一条会跳过。</small></div>" +
    '<button class="xm-btn" type="button" data-act="import-file">' + icons.restore + " 导入备份文件…</button>" +
    "</div>" +
    '<div class="xm-row"><div class="xm-row__label">从备份恢复' +
    "<small>补回误删或丢掉的便签，不会覆盖现有的。</small></div>" +
    '<button class="xm-btn" type="button" data-act="restore-backup" data-confirm="0">' + icons.restore + " 恢复</button>" +
    "</div>" +
    "</section>" +
    '<section class="xm-settings__group">' +
    '<h3 class="xm-settings__group-title">快捷键</h3>' +
    '<div class="xm-row"><div class="xm-row__label">新建便签' +
    "<small>按下后光标直接落在正文，可以马上打字。</small></div>" +
    // 键帽本身就是按钮：点一下进入"按下新组合"的捕获状态（契约 §12.4）
    '<button class="xm-kbd xm-kbd--edit" type="button" data-hotkey data-hotkey-edit="new" ' +
    'title="点一下，换一个组合" aria-label="新建便签快捷键，点一下修改">Ctrl + Shift + Space</button></div>' +
    '<div class="xm-row"><div class="xm-row__label">打开面板' +
    "<small>随时把便签列表叫出来。</small></div>" +
    '<button class="xm-kbd xm-kbd--edit" type="button" data-hotkey data-hotkey-edit="panel" ' +
    'title="点一下，换一个组合" aria-label="打开面板快捷键，点一下修改">Ctrl + Alt + M</button></div>' +
    '<div class="xm-row"><div class="xm-row__label">快速记录' +
    "<small>在任何地方按一下，弹出一张小纸。</small></div>" +
    '<button class="xm-kbd xm-kbd--edit" type="button" data-hotkey data-hotkey-edit="quick" ' +
    'title="点一下，换一个组合" aria-label="快速记录快捷键，点一下修改">Ctrl + Alt + Space</button></div>' +
    '<div class="xm-row"><div class="xm-row__label">保存当前便签</div>' +
    '<kbd class="xm-kbd">Ctrl + S</kbd></div>' +
    '<div class="xm-row"><div class="xm-row__label">面板里搜索</div>' +
    '<kbd class="xm-kbd">Ctrl + F</kbd></div>' +
    '<div class="xm-row"><div class="xm-row__label">关闭当前窗口</div>' +
    '<kbd class="xm-kbd">Esc</kbd></div>' +
    "</section>" +
    '<section class="xm-settings__group">' +
    '<h3 class="xm-settings__group-title">关于</h3>' +
    '<div class="xm-row"><div class="xm-row__label">小梦备忘录 · 版本 ' + APP_VERSION +
    "<small>数据只在本机。</small></div></div>" +
    '<div class="xm-row"><div class="xm-row__label">新手引导</div>' +
    '<button class="xm-btn" type="button" data-act="guide">查看引导</button></div>' +
    '<div class="xm-row"><div class="xm-row__label">面板</div>' +
    '<button class="xm-btn" type="button" data-act="panel">打开面板</button></div>' +
    "</section>" +
    '<div class="xm-toast" data-show="0">已保存</div>' +
    "</section>";

  const settingsEl = query<HTMLElement>(body, ".xm-settings");
  const dotsEl = query<HTMLElement>(body, '[data-act="colors"]');
  const newHotkeyEl = query<HTMLButtonElement>(body, '[data-hotkey-edit="new"]');
  const panelHotkeyEl = query<HTMLButtonElement>(body, '[data-hotkey-edit="panel"]');
  const quickHotkeyEl = query<HTMLButtonElement>(body, '[data-hotkey-edit="quick"]');
  const reminderSoundSwitch = query<HTMLButtonElement>(body, '[data-act="reminder-sound"]');
  const themeSeg = query<HTMLElement>(body, '[data-act="theme"]');
  const guideEl = query<HTMLElement>(body, "[data-guide]");
  const guideBtn = query<HTMLButtonElement>(body, '[data-act="guide"]');
  const toastEl = query<HTMLElement>(body, ".xm-toast");

  // 圆点用 JS 生成，省掉六段重复 HTML
  dotsEl.innerHTML = NOTE_COLORS.map(
    (color) =>
      '<button class="xm-color-dot" type="button" data-color="' +
      color.key +
      '" data-active="0" title="' +
      color.label +
      '" aria-label="' +
      color.label +
      '"></button>',
  ).join("");

  /** 当前设置（读出来之前是 null） */
  let current: Settings | null = null;
  /** 开机自启是系统状态，不在 settings.json 里，单独存一份 */
  let autostart = false;
  /** 新手引导是否展开 */
  let guideOpen = false;
  let toastTimer = 0;
  /** 正在录制哪一颗键帽（null = 没在录制）；此时键帽显示"按下新的组合…" */
  let captureTarget: HTMLButtonElement | null = null;
  /** 当前录制的设置字段 */
  let captureField: "hotkey_new_note" | "hotkey_show_panel" | "hotkey_quick" = "hotkey_new_note";

  function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.dataset.show = "1";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.dataset.show = "0";
    }, 1400);
  }

  /** 失败原因压缩成一句能看懂的短话（toast 放不下整段报错） */
  function errorBrief(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? "");
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return "再试一次";
    if (/权限|拒绝|denied|access|permission/i.test(text)) return "写不进桌面，检查权限或杀毒软件";
    return text.length > 28 ? text.slice(0, 28) + "…" : text;
  }

  /** 尺寸切换观感：与便签窗口共用同一个 localStorage 键 */
  function readSizeFeel(): "snap" | "veil" {
    try {
      return window.localStorage.getItem("xm.size-feel") === "veil" ? "veil" : "snap";
    } catch {
      return "snap";
    }
  }

  /** 把 current 的状态同步到界面 */
  function sync(): void {
    if (!current) return;

    const autostartSwitch = query<HTMLButtonElement>(body, '[data-act="autostart"]');
    const soundSwitch = query<HTMLButtonElement>(body, '[data-act="sound"]');
    const markdownSwitch = query<HTMLButtonElement>(body, '[data-act="markdown"]');
    autostartSwitch.setAttribute("aria-checked", autostart ? "1" : "0");
    soundSwitch.setAttribute("aria-checked", current.play_sound ? "1" : "0");
    // 老数据没有这些字段时按默认值兜底（和后端默认一致）
    reminderSoundSwitch.setAttribute("aria-checked", current.reminder_sound !== false ? "1" : "0");
    markdownSwitch.setAttribute("aria-checked", current.markdown_enabled !== false ? "1" : "0");

    // 纸色三档：先按设置值高亮，再真正把主题应用到 <html data-theme>
    const mode = current.theme_mode ?? "auto";
    // 只挑纸色那组：字号也是 .xm-seg__item，别把它的高亮清掉
    themeSeg.querySelectorAll<HTMLElement>(".xm-seg__item[data-theme]").forEach((item) => {
      const active = item.dataset.theme === mode;
      item.dataset.active = active ? "1" : "0";
      item.setAttribute("aria-pressed", active ? "true" : "false");
    });
    applyTheme(mode);

    const feel = readSizeFeel();
    body.querySelectorAll<HTMLElement>(".xm-seg__item[data-feel]").forEach((item) => {
      const active = item.dataset.feel === feel;
      item.dataset.active = active ? "1" : "0";
      item.setAttribute("aria-pressed", active ? "true" : "false");
    });

    body.querySelectorAll<HTMLElement>(".xm-color-dot").forEach((dot) => {
      dot.dataset.active = dot.dataset.color === current!.default_color ? "1" : "0";
    });

    body.querySelectorAll<HTMLElement>(".xm-seg__item[data-scale]").forEach((item) => {
      const scale = Number(item.dataset.scale);
      const active = Math.abs(scale - current!.default_font_scale) < 0.001;
      item.dataset.active = active ? "1" : "0";
      item.setAttribute("aria-pressed", active ? "true" : "false");
    });

    // 捕获状态下键帽显示提示语，别被刷新覆盖掉
    if (!captureTarget) {
      newHotkeyEl.textContent = (current.hotkey_new_note || "Ctrl+Shift+Space").replace(/\+/g, " + ");
      panelHotkeyEl.textContent = (current.hotkey_show_panel || "Ctrl+Alt+M").replace(/\+/g, " + ");
      quickHotkeyEl.textContent = (current.hotkey_quick || "Ctrl+Alt+Space").replace(/\+/g, " + ");
    }

    guideEl.hidden = !guideOpen;
    guideBtn.textContent = guideOpen ? "收起引导" : "查看引导";
  }

  /** 保存队列：连续点两下（比如先改配色再改字号）时排队写，避免后一次拿着旧值把前一次覆盖掉 */
  let saveQueue: Promise<void> = Promise.resolve();

  /** 改一项设置：先落到界面上，再排队保存；失败就重新读一遍，不打断用户 */
  function update(patch: Partial<Settings>, message = "已保存"): void {
    if (!current) return;
    // 先更新本地快照并刷新界面：手指还没离开屏幕，圆点/开关就该亮到新位置
    current = { ...current, ...patch };
    sync();
    const payload: Settings = { ...current };
    saveQueue = saveQueue.then(async () => {
      try {
        current = await api.saveSettings(payload);
        sync();
        toast(message);
      } catch (error) {
        console.error("保存设置失败", error);
        toast("保存失败");
        await load();
      }
    });
  }

  async function load(): Promise<void> {
    try {
      const [snapshot, autostartValue] = await Promise.all([api.getSnapshot(), api.getAutostart()]);
      current = snapshot.settings;
      autostart = autostartValue;
      // 开机自启的真实状态以系统为准：对齐一次，避免之后保存别的设置时把自启又改回去
      current.launch_on_startup = autostartValue;
      // 第一次用：直接把引导展开
      guideOpen = !current.first_run_done;
      sync();
    } catch (error) {
      console.error("读取设置失败", error);
      toast("读取失败");
    }
  }

  // ---------- 快捷键录制（契约 §12.4） ----------
  /** 把 KeyboardEvent.key 转成 Tauri accelerator 里的主键；不认识的键返回空串 */
  function mainKeyOf(event: KeyboardEvent): string {
    const key = event.key;
    if (key.length === 1) {
      if (/^[a-z]$/i.test(key)) return key.toUpperCase();
      if (/^[0-9]$/.test(key)) return key;
      return "";
    }
    if (/^F([1-9]|1[0-2])$/.test(key)) return key;
    if (key === " " || key === "Spacebar") return "Space";
    if (key === "ArrowUp") return "Up";
    if (key === "ArrowDown") return "Down";
    if (key === "ArrowLeft") return "Left";
    if (key === "ArrowRight") return "Right";
    return "";
  }

  function beginCapture(
    btn: HTMLButtonElement,
    field: "hotkey_new_note" | "hotkey_show_panel" | "hotkey_quick",
  ): void {
    if (!current || captureTarget) return;
    captureTarget = btn;
    captureField = field;
    btn.dataset.capturing = "1";
    btn.textContent = "按下新的组合…";
    btn.focus();
  }

  /** 取消录制：键帽回到当前设置值 */
  function cancelCapture(): void {
    if (captureTarget) delete captureTarget.dataset.capturing;
    captureTarget = null;
    sync();
  }

  /** 保存新组合：失败（比如被系统或其他软件占用）就回滚并给出明确提示 */
  function submitHotkey(accelerator: string): void {
    if (!current) return;
    const payload: Settings = { ...current, [captureField]: accelerator };
    current = payload;
    if (captureTarget) delete captureTarget.dataset.capturing;
    captureTarget = null;
    sync();
    saveQueue = saveQueue.then(async () => {
      try {
        current = await api.saveSettings(payload);
        sync();
        toast("已保存");
      } catch (error) {
        console.error("保存快捷键失败", error);
        // 后端会回滚到旧组合；这里给一句人话，并重新读一遍真实状态
        toast("这个组合被占用了，换一个");
        await load();
      }
    });
  }

  newHotkeyEl.addEventListener("click", (event) => {
    event.preventDefault();
    beginCapture(newHotkeyEl, "hotkey_new_note");
  });
  panelHotkeyEl.addEventListener("click", (event) => {
    event.preventDefault();
    beginCapture(panelHotkeyEl, "hotkey_show_panel");
  });
  quickHotkeyEl.addEventListener("click", (event) => {
    event.preventDefault();
    beginCapture(quickHotkeyEl, "hotkey_quick");
  });
  // 点到别处就放弃录制，不留一个永远"正在等按键"的键帽
  for (const keyEl of [newHotkeyEl, panelHotkeyEl, quickHotkeyEl]) {
    keyEl.addEventListener("blur", () => {
      if (captureTarget === keyEl) cancelCapture();
    });
  }

  // 捕获阶段拦下按键：录制时不能让 Ctrl+S 之类触发别的功能
  document.addEventListener(
    "keydown",
    (event) => {
      if (!captureTarget) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        cancelCapture();
        return;
      }
      const main = mainKeyOf(event);
      if (!main) return; // 按住 Shift / Ctrl 本身不提交
      const parts: string[] = [];
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Alt");
      if (event.shiftKey) parts.push("Shift");
      if (event.metaKey) parts.push("Super");
      if (parts.length === 0) {
        toast("要带 Ctrl 或 Alt");
        return;
      }
      parts.push(main);
      submitHotkey(parts.join("+"));
    },
    true,
  );

  // ---------- 事件 ----------
  settingsEl.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!target) return;
    const act = target.dataset.act;

    // 六色圆点 / 分段字号：由子元素冒泡上来
    if (act === "colors") {
      const dot = (event.target as HTMLElement).closest<HTMLElement>(".xm-color-dot");
      if (dot?.dataset.color) void update({ default_color: dot.dataset.color });
      return;
    }
    if (act === "scale") {
      const item = (event.target as HTMLElement).closest<HTMLElement>(".xm-seg__item");
      const scale = Number(item?.dataset.scale);
      if (Number.isFinite(scale) && scale > 0) void update({ default_font_scale: scale });
      return;
    }

    if (act === "autostart") {
      void (async () => {
        const next = !autostart;
        try {
          autostart = await api.setAutostart(next);
          // 后端已把 launch_on_startup 写进设置，这里同步本地快照，
          // 否则接下来改别的设置会带着旧值保存，把开机自启又关回去
          if (current) current = { ...current, launch_on_startup: autostart };
          sync();
          toast(autostart ? "已开启自启" : "已关闭自启");
        } catch (error) {
          console.error("设置开机自启失败", error);
          toast("设置失败");
        }
      })();
      return;
    }

    if (act === "sound") {
      void update({ play_sound: !(current?.play_sound ?? true) });
      return;
    }

    if (act === "markdown") {
      const enabled = current?.markdown_enabled ?? true;
      void update({ markdown_enabled: !enabled });
      return;
    }

    if (act === "reminder-sound") {
      // 老数据没这个字段时按默认开启算，点一下变成关闭
      void update({ reminder_sound: !(current?.reminder_sound !== false) });
      return;
    }

    if (act === "size-feel") {
      const item = (event.target as HTMLElement).closest<HTMLElement>(".xm-seg__item");
      const feel = item?.dataset.feel;
      if (feel === "snap" || feel === "veil") {
        try {
          window.localStorage.setItem("xm.size-feel", feel);
        } catch {
          toast("这个开关存不下来");
          return;
        }
        sync();
        toast(feel === "veil" ? "已切到柔光" : "已切到直接跳");
      }
      return;
    }

    if (act === "theme") {
      const item = (event.target as HTMLElement).closest<HTMLElement>(".xm-seg__item");
      const mode = item?.dataset.theme;
      if (mode === "auto" || mode === "day" || mode === "night") {
        void update({ theme_mode: mode });
      }
      return;
    }

    if (act === "data-folder") {
      void (async () => {
        try {
          await api.openDataFolder();
          toast("已打开");
        } catch (error) {
          console.error("打开数据文件夹失败", error);
          toast("打开失败");
        }
      })();
      return;
    }

    if (act === "export") {
      // 导出到桌面：文件写在哪由后端决定，这里只报结果（契约 §13.5）
      const btn = target as HTMLButtonElement;
      void (async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await api.exportNotes();
          toast("已导出到桌面");
        } catch (error) {
          console.error("导出便签失败", error);
          toast("导出失败：" + errorBrief(error));
        } finally {
          btn.disabled = false;
        }
      })();
      return;
    }

    if (act === "import-file") {
      // 选文件由后端弹系统对话框；用户取消时返回 null，这里安静收场
      const btn = target as HTMLButtonElement;
      void (async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = "导入中…";
        try {
          const result = await api.importNotesFile();
          if (!result) return;
          toast("导入 " + result.imported + " 条，跳过 " + result.skipped + " 条");
        } catch (error) {
          console.error("导入备份失败", error);
          toast("导入失败：" + errorBrief(error));
        } finally {
          btn.disabled = false;
          btn.innerHTML = icons.restore + " 导入备份文件…";
        }
      })();
      return;
    }

    if (act === "restore-backup") {
      // 两步确认：第一次点变成"确认恢复？"，5 秒内再点一次才真恢复（砖红底）
      const btn = target as HTMLButtonElement;
      void (async () => {
        if (btn.disabled) return;
        if (btn.dataset.confirm !== "1") {
          btn.dataset.confirm = "1";
          btn.textContent = "确认恢复？";
          window.setTimeout(() => {
            if (btn.isConnected && btn.dataset.confirm === "1") {
              btn.dataset.confirm = "0";
              btn.innerHTML = icons.restore + " 恢复";
            }
          }, 5000);
          return;
        }
        btn.dataset.confirm = "0";
        btn.disabled = true;
        btn.textContent = "正在恢复…";
        try {
          const count = await api.restoreFromBackup();
          toast("已恢复 " + count + " 条便签");
        } catch (error) {
          console.error("从备份恢复失败", error);
          const msg = error instanceof Error ? error.message : String(error ?? "");
          toast(msg.includes("备份") ? "还没有备份文件" : "恢复失败");
        } finally {
          btn.disabled = false;
          btn.innerHTML = icons.restore + " 恢复";
        }
      })();
      return;
    }

    if (act === "guide") {
      guideOpen = !guideOpen;
      sync();
      if (guideOpen) guideEl.scrollIntoView({ block: "nearest" });
      return;
    }

    if (act === "guide-done") {
      guideOpen = false;
      void update({ first_run_done: true }, "已保存");
      return;
    }

    if (act === "panel") {
      // 回到面板：设置窗先藏起来，面板由后端唤起（浏览器 mock 里同样可用）
      void (async () => {
        try {
          await api.openPanel();
        } catch (error) {
          console.error("打开面板失败", error);
        }
        await hideCurrent();
      })();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") void hideCurrent();
  });

  // 别处改了设置（比如面板），这里跟着刷新
  void subscribe("settings-changed", () => void load());

  // ---------- 启动 ----------
  await load();
  // 设置窗是复用窗口（关掉只是藏起来），上次的滚动位置会留着；
  // 每次打开都从顶上开始，除非正展开着新手引导（那就把引导滚进视野）。
  requestAnimationFrame(() => {
    body.scrollTop = 0;
    if (guideOpen) guideEl.scrollIntoView({ block: "nearest" });
  });
}