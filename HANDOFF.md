# 小梦备忘录 · 交接与代码审查文档

> 版本 **v0.2.2** · 生成于 2026-11-12 · 仓库 https://github.com/star620/XiaoMengMEMO
> 这份文档写给「接手审查的 AI 或工程师」。**它只描述现状，不含任何代码改动**；文中所有 `文件:行号` 都以 v0.2.2 的代码为准。

---

## 0. 先读这一段

### 0.1 需要审查的三件事

| 优先级 | 主题 | 为什么值得查 |
| --- | --- | --- |
| **P0** | 快捷键打开便签「时不时打不开」 | 用户实际遇到过，且**失败是静默的**：界面上没有任何提示，只有日志 |
| **P1** | 动画流畅度 | 便签入场、面板弹出、提醒浮层、窗口尺寸变化、滚动纸边；透明窗口 + 大量 CSS 阴影，存在掉帧风险 |
| **P2** | 其余 | 数据安全（原子写/备份/回收站）、多显示器与 DPI、提醒可靠性、内存占用、无障碍 |

### 0.2 硬约束（改动前必读）

1. **IPC 契约**：32 个 Tauri 命令、4 个事件名属于前后端契约。前端唯一入口是 `src/shared/api.ts`，改任何命令必须同步改这里。
2. **数据兼容**：`Note` / `Settings` 的 JSON 字段已经存在于用户数据里。新增字段必须带 serde default，**不得修改既有字段语义**。
3. **安全最小集**：`src-tauri/tauri.conf.json` 的 CSP 与 `src-tauri/capabilities/default.json` 的权限是最小集合，不要为了省事放开。
4. **版本号四处同步**：`package.json:3`、`src-tauri/Cargo.toml:3`、`src-tauri/tauri.conf.json:4`、`src/surfaces/settings.ts:18`（`APP_VERSION`）。
5. **视觉零素材**：纸张渐变、纸纹、折角、复选框、图标全部是 CSS + 内联 SVG，**不要引入图片素材或网络字体**。
6. **界面语言**：简体中文，语气是「纸和笔」的安静感，不要改成软件腔。

### 0.3 期望的问题报告格式

```
现象（一句话） → 复现步骤 → 证据（文件:行 + 日志片段） → 最小改动建议（能贴 patch 更好） → 风险级别 P0/P1/P2
```

---

## 1. 项目是什么

一个 Windows 桌面便签 / 待办小工具。目标是「开机就在、随手记、置顶看」，**不是笔记软件**。

| 项 | 值 |
| --- | --- |
| 技术栈 | Tauri 2（Rust 后端）+ TypeScript + Vite，纯 CSS 纸面视觉 |
| 安装包 | NSIS，约 **3.07 MiB**；便携版 exe 约 5.9 MB |
| 启动 | 冷启动约 0.5–1 s 出第一张便签；常驻托盘 |
| 数据 | 纯本地 `%APPDATA%\XiaoMengMemo\`，**不联网、无账号、无遥测** |
| 系统要求 | Windows 10/11 x64，需 WebView2（Win11 自带） |
| 许可 | MIT |
| 版本 | v0.2.2（Release：https://github.com/star620/XiaoMengMEMO/releases/tag/v0.2.2） |

**明确不做**：云同步、账号体系、富文本编辑器、主题商店、多端。

---

## 2. 代码地图

### 2.1 前端（TypeScript，无框架，直接操作 DOM）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/main.ts` | 44 | 按 URL 的 `?surface=` 分发到五个界面模块 |
| `src/shared/api.ts` | 124 | **唯一 IPC 入口**；DEV 或 `globalThis.__XM_MOCK__` 时才走 mock |
| `src/shared/types.ts` | — | `Note` / `TodoItem` / `Settings` / `Snapshot` 类型 |
| `src/shared/mock.ts` | — | 浏览器调试用假数据（独立 chunk，生产非 Tauri 环境会抛「当前不在桌面应用里」） |
| `src/surfaces/sticky.ts` | 2424 | 便签窗口：标题/正文编辑、待办、菜单、尺寸档位、吸边、滚动、保存、撤销删除 |
| `src/surfaces/panel.ts` | 1919 | 管理面板：搜索、筛选、列表、回收站、修改记录、新建立即打开 |
| `src/surfaces/settings.ts` | 541 | 设置页：自启、音效、纸色、字号、导出/导入、快捷键录制 |
| `src/surfaces/reminder.ts` | 180 | 提醒浮层：稍后 10 分钟 / 知道了 / 重复规则 |
| `src/surfaces/quick.ts` | 152 | 快速记录浮层：回车保存并打开便签 |
| 其余 shared | — | `dom / env / events / format / icons / sound / window / colors / diff / markdown / undo / clipboard / vault / theme` |

### 2.2 Rust 后端

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src-tauri/src/lib.rs` | 393 | 启动装配、事件常量、日志、单实例、RunEvent |
| `src-tauri/src/store.rs` | 2167 | 内存快照 + notes.json / trash.json / history 读写、原子写、备份、导入导出 |
| `src-tauri/src/windows.rs` | 1285 | 所有窗口创建/显示/置顶/重绘、位置计算、尺寸动画驱动线程 |
| `src-tauri/src/commands.rs` | 357 | 32 个 `#[tauri::command]`（2026-11-13 校正：原写 34，实测 `grep -c "#\[tauri::command\]"` 为 32） |
| `src-tauri/src/model.rs` | 370 | 数据结构与默认值（含旧数据兼容测试） |
| `src-tauri/src/tray.rs` | 282 | 托盘图标与菜单 |
| `src-tauri/src/hotkey.rs` | 110 | 全局快捷键注册与分发 |
| `src-tauri/src/reminder.rs` | 251 | 提醒扫描线程 |

### 2.3 样式

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/styles/tokens.css` | 618 | 设计变量、时长/缓动、`@font-face`（霞鹜文楷子集） |
| `src/styles/paper.css` | 4568 | 纸面、折角、阴影、所有组件视觉、**全部动画关键帧** |
| `src/styles/app.css` | 364 | 布局骨架与少量全局样式 |

### 2.4 其它

- `.github/workflows/ci.yml`：web job（`npm ci` → `typecheck` → `build`）+ rust job（`fmt --check` / `clippy -D warnings` / `test --lib`），均 windows-latest。
- `.github/workflows/release.yml`：推 `v*` tag 自动构建 NSIS + 便携 exe + `SHA256SUMS.txt` 并发 Release。
- `tools/`：构建脚本（`cargo.ps1` / `npm.ps1` / `tauri.ps1` / `sign.ps1`）、CDP 调试（`cdp-run.mjs` / `cdp-shot.mjs` / `cdp-console.mjs`）、截图（`wins.ps1` / `raise-window.ps1` / `shot-screen.ps1`）、字体子集化。
- `licenses/`：LXGW WenKai 的 OFL 文本。`assets/screenshots/`：README 用的七张真机截图。

---

## 3. 架构

### 3.1 进程与窗口模型

- 一个 Rust 主进程 + 一个共享的 WebView2 浏览器进程；**每个便签窗口一个 WebView2 渲染器**。
- 窗口 label 规则：便签 `note-<id>`；面板 `panel`；设置 `settings`；提醒 `reminder`；快速记录 `quick`。
- 便签窗口：`decorations(false) + transparent(true) + shadow(false) + skip_taskbar(true) + resizable(false)`，圆角/纸边/阴影全由前端 CSS 画。
- 面板与设置是无边框透明纸窗（`open_aux`，`windows.rs:738-794`），已存在时 `restore_and_focus + raise_to_front + force_repaint`，并给面板派发 `xm-panel-open` 让它回到列表首页。
- 快速记录窗常驻不销毁（`close_quick`，`windows.rs:847` 只 hide），复用时派发 `xm-quick-open`（前端 `quick.ts:115-124` 负责清空输入和复位状态）。

### 3.2 启动顺序（`lib.rs:220-304`）

1. `Store::open`（226）——读 notes.json / trash.json，建目录
2. `tray::create`（236）——托盘图标与菜单
3. `hotkey::apply_all`（240）——注册三个全局快捷键（**失败只写日志**）
4. 自启状态同步（243）
5. `tray::set_visible`（248）
6. 恢复上次可见的便签窗口（253-258，`focus=false`）
7. 首启逻辑（260-292）——空数据开面板、未完成引导开设置
8. 若 `visible_windows == 0` 则 `show_startup_failure`（295-297）
9. `reminder::spawn`（299）——提醒线程
10. `windows::spawn_snap_worker`（301）——吸边/尺寸动画驱动

### 3.3 数据流

- 前端任何改动 → `api.saveNote/saveSettings` → Rust 改内存快照 → 事件 `notes-changed` / `settings-changed` → 其他窗口重新拉 `get_snapshot` 全量刷新。
- **没有增量 diff**：一次保存写整份 notes.json（原子写），全量广播。便签数量少时没问题，几百张便签时是潜在性能点。
- 窗口移动/缩放经 `save_window_state` 回写几何信息（`capture_geometry`，`windows.rs:654-679`）。

### 3.4 存储

| 文件 | 说明 |
| --- | --- |
| `notes.json` | 全部便签（`store.rs:201`） |
| `notes.bak.json` | 每日备份（`store.rs:202`） |
| `trash.json` | 回收站，保留 30 天（`store.rs:203`） |
| `history/<id>.json` | 单张便签的历史版本，`HISTORY_KEEP` 条上限（`store.rs:463`、:522`） |
| `boot.log` / `app.log` | 运行日志，超 1 MB 轮转（`lib.rs:37-104`） |

写盘统一走 `write_atomic`（`store.rs:1679`）：临时文件 + `sync_all` + `rename` 重试 3 次，每次间隔 40 ms。上层用 `persist_then_clean`（`store.rs:1340`）保证「写成功才清 dirty 标记」。

### 3.5 命令与事件

32 个命令（`commands.rs`，2026-11-13 校正为实测值）：

- 快照/保存：`get_snapshot`、`save_note`、`create_note`、`delete_note`
- 回收站：`list_trash`、`restore_note`、`empty_trash`
- 窗口：`open_note_window`、`close_note_window`、`save_window_state`、`set_pinned`、`set_note_collapsed`、`set_note_size`、`set_note_locked`
- 历史/导入导出：`list_note_versions`、`get_note_version`、`restore_note_version`、`export_notes`、`restore_from_backup`、`import_notes_file`
- 其它窗口：`open_panel`、`open_settings`、`open_quick`、`close_quick`
- 提醒：`set_reminder`、`snooze_reminder`、`dismiss_reminder`
- 设置/系统：`save_settings`、`get_autostart`、`set_autostart`、`apply_autostart`、`open_data_folder`、`quit_app`、`quit_now`

4 个事件（`lib.rs:24-28`）：`notes-changed`、`settings-changed`、`reminder-due`、`note-focus`。

### 3.6 提醒

`reminder.rs` 起一个线程，每 20 s 扫一次到期便签；命中就开（或复用）`reminder` 窗口并广播 `reminder-due`。过期未弹的会在下次扫描补发。

⚠ 提醒窗单例复用曾有一个真 bug：同一个 URL 复用时 WebView2 不重新挂载，第二轮按钮是灰的。现在的修法是 `reminder_url` 追加 `&ts=<ms>` 强制新文档（`windows.rs:854-864`），前端还会监听 `visibilitychange` 复位按钮（`reminder.ts`）。**如果动这一段，务必回归「同一张便签连续提醒两次」。**

### 3.7 全局快捷键（审查重点，见第 5 节）

`hotkey.rs` 只有 110 行：

- `apply_all`（14-35）：先全部反注册，再按设置逐个注册；重复/空串跳过。
- `register_one`（37-49）：错误被格式化成中文提示「XX快捷键「Ctrl+Alt+N」注册失败，可能被其他软件占用：…」——**但只进日志**。
- `on_hotkey_state`（52-67）：只响应 Pressed，按当前设置 parse 后比对分发。
- 三个回调各自 `std::thread::spawn`（70-107），不阻塞事件循环。

---

## 4. 构建、运行、调试

### 4.1 命令

```bash
npm ci
npm run typecheck
npm run build                 # tsc --noEmit + vite build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run tauri build           # 出 NSIS 安装包 + 便携 exe（首次约 3–6 分钟）
```

### 4.2 这台开发机特有的五个坑

1. **系统代理**：注册表里有个失效代理 `127.0.0.1:26001`，cargo 会因此报 `Failed to connect to index.crates.io`。解法：跑 cargo 前设 `NO_PROXY=*`（仓库里 `tools/env.ps1` 已封装）。
2. **npm.ps1 被执行策略禁止**：PowerShell 里只能调 `C:\Program Files\nodejs\npm.cmd`，或走 `tools/npm.ps1`。
3. **自动化会话起不了窗口**：从受限的自动化进程里创建 WebView2 窗口会报 `os error 5（拒绝访问）`，也不能写 `%APPDATA%`。这**不是程序 bug**，审查时请以你本机手动运行为准。
4. **未签名 exe 会被 SmartScreen 拦**：点「更多信息 → 仍要运行」。数据不影响。
5. **中文路径**：仓库路径含中文（`…\12_备忘录`），个别旧工具链对非 ASCII 路径敏感。

### 4.3 日志（排「打不开」的第一现场）

- `%APPDATA%\XiaoMengMemo\boot.log`：启动与窗口动作，含 `raise <label>: before(vis,min,focus)=… after=…`、`open_note_window …`、`open_aux …`、失败原因。
- `%APPDATA%\XiaoMengMemo\app.log`：`log_line` 输出（含快捷键注册失败）。
- 便携目录下还可能有一份 `xiaomeng-boot.log`（exe 同目录，用于捕获「连 APPDATA 都没写进去」的更早期故障）。

### 4.4 CDP 调试（可选）

程序支持通过环境变量开远程调试：设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 再启动，然后：

```bash
node tools/cdp-run.mjs --expr probe.js --match "surface=sticky" --first
node tools/cdp-shot.mjs --match "surface=panel" --out shot.png --wait 800
node tools/cdp-console.mjs            # 抓 console 错误
```

---

## 5. 重点一：快捷键打开便签「时不时打不开」

### 5.1 现象（用户原话）

> 「快捷打开便签（时不时打不开的）」

具体特征（用户口述，未做系统化复现）：用 `Ctrl+Alt+N` 新建便签时，**有时按了没反应**；不是每次，也说不清规律。

### 5.2 完整调用链（按住快捷键之后发生了什么）

```
键盘按下
  └─ hotkey.rs on_hotkey_state (52-67)         只处理 Pressed
      └─ std::thread::spawn (70-86)            异步，异常不会冒泡到 UI
          ├─ cursor_logical (110-120)          取鼠标位置（按显示器 scale 换算）
          ├─ store.create_note(Memo, at)       建便签（落盘）
          └─ windows::open_note_window(app, &note, false)   ← focus = false
              ├─ 已存在：set_always_on_top(pinned) → 视 focus 走 restore_and_focus / raise_to_front
              └─ 新建：WebviewWindowBuilder(visible(false), focused(false)) → build()
                        → capture_geometry → show()          ← 只有 show()，没有 raise
```

### 5.3 可疑原因清单（按我的判断排序）

| # | 机制 | 为什么可疑 | 怎么验证 | 日志线索 |
| --- | --- | --- | --- | --- |
| **A1** | **失败完全静默** | 整条链路在 detached 线程里，错误只 `log_line`；用户侧无 toast、无托盘提示 | 复现后立刻看 app.log | 「新建便签失败」「快捷键新建便签失败」「创建窗口失败」 |
| **A2** | **新建路径不 raise** | 新建窗口 `focused(false) + show()`，不抢前台。按 Windows 前台锁定规则，若当前前台是提权程序/全屏程序/UAC 之后的进程，新窗口可能直接开在下面 | 打开一个最大化窗口（尤其以管理员运行的程序）→ 按快捷键 → 看便签是否被压在下面 | boot.log 里只有 `open_note_window` 记录，没有 `raise` 记录 |
| **A3** | **热键注册失败后不再重试** | `apply_all` 只在启动和保存设置时调用。启动时若组合被占（输入法、QQ、游戏、录屏工具），该功能会**一直**不可用，直到用户改一次设置或重启 | 启动后 10 s 内 grep 日志；或故意用另一程序占住 Ctrl+Alt+N | 「快捷键「Ctrl+Alt+N」注册失败，可能被其他软件占用」 |
| **A4** | **置顶 hack 有 700 ms 空窗** | `raise_to_front` 用「临时 topmost → 700 ms 后取消」抢前台（`windows.rs:297-330`）。若对方窗口周期性置顶（悬浮工具、某些会议软件），仍会被压 | 开着 Always-on-top 的工具再按快捷键 | boot.log 的 `raise …: before/after` 里 focus=true 但用户仍看不见 |
| **A5** | **WebView2 渲染器崩了，窗口还在** | 窗口 HWND 存在、便签「打开了」，但内容是白的/空的，用户认为「没打开」 | 白屏时查 `tasklist /fi "imagename eq msedgewebview2.exe"` 数量；CDP 抓 DOM 是否空 | 页面 console 报错；渲染进程退出 |
| **A6** | **多显示器 + 缩放导致坐标漂移** | 位置来自 `save_window_state` 的历史几何（物理像素 ÷ scale），换显示器/改缩放后 `note_geometry`（`windows.rs:212-278`）会 clamp 到某块屏边缘；极端情况下落在屏幕外或屏幕缝里 | 在 150% 与 100% 缩放间切换、拔插外接屏后复现 | boot.log 的 `new note placed at (x,y)` 与多屏布局对照 |
| **A7** | **连按两次** | 两次 Pressed 会并发两个线程，建两张便签叠在一起；观感像「出错了」 | 快速连按两次，看 notes.json 是否多两条 | `create_note` 两条记录 |
| **A8** | **重复启动 exe** | 单实例插件只在第二次启动时唤起既有界面；若它唤起的目标窗口此时不可见/在屏幕外，看起来就是「没反应」 | 双击 exe 两次 | 单实例相关日志 |
| **A9** | **睡眠/会话切换后热键失效** | Windows 上 global-hotkey 在锁屏/睡眠恢复后偶发失效，代码里**没有重新注册逻辑** | 睡眠 10 分钟唤醒后立刻试 | 无日志（这才是问题） |

### 5.3.1 一条线索（原写"高置信度"，2026-11-13 降级为"待验证假设"）

> **校正（AI-B 反驳，AI-A 接受）**：快捷键新建每次都走 `create_note` 生成**新的 note id**，`open_note_window` 不经过「已有窗口」分支，
> 因此"缺 `force_repaint`"**不能**直接推出"合成器停在暂停态导致空白"。原来的时序吻合只是相关，不是因果。
> 这条线索保留为**待验证假设**，验证方式见下方「建议的最小验证」；不得作为已确诊结论传给下一轮。

`force_repaint`（`windows.rs:359`，用 opacity 微调 + 高度 ±1px 逼 WebView2 重建绘制表面）**只被三处调用**：`open_aux` 已存在窗口（:760）、`open_aux` 新建窗口（:792）、`open_quick`（:814）。

**`open_note_window`（`windows.rs:598-651`）一次都没调。** 而它上面 355-357 行的注释自己写明了为什么需要这个函数：

> 「即使关掉了 Chromium 的遮挡检测，仍有少数路径（**显示器休眠唤醒、DWM 会话切换**、最小化再恢复）会让 WebView2 的合成器停在暂停状态。」

于是有一个很具体的失效路径：

1. 便签窗口开着，用户合盖睡眠 / 切换用户 / 锁屏一段时间；
2. WebView2 合成器停在暂停态（窗口还在，但不再出帧）；
3. 用户按 `Ctrl+Alt+N` 唤出便签 → `open_note_window` 走「已存在」分支 → `set_always_on_top` + `show`/unminimize；
4. 窗口被「显示」了，但没有 `force_repaint` → 屏幕上是一张**空白/发白的纸**，或者干脆看不出变化；
5. 用户在日志里看不到任何错误 —— 因为确实没有错误。

这与用户说的「时不时打不开」在**时序上高度吻合**（睡眠 / 长时间不用之后更容易出现），也能解释为什么这类故障常常「重启程序就好」（合成器重新初始化）—— 后一句同样是推断，需要验证。

**建议的最小验证**：睡眠 10 分钟 → 唤醒 → 按 `Ctrl+Alt+N` → 截图看窗口内容。

**建议的最小修复**：`open_note_window` 显示已有窗口后补一行 `force_repaint(&window)`（一行调用，风险极低）。

### 5.4 建议的复现矩阵（交给审查者/用户填）

| 场景 | 期望 | 实际 | 备注 |
| --- | --- | --- | --- |
| 冷启动后第一次按 | 弹便签 | | 关注注册是否成功 |
| 前台是记事本 | 便签出现在最上层 | | 验证 A2 |
| 前台是管理员权限程序 | 便签可见 | | 验证前台锁定 |
| 前台是全屏视频/游戏 | 便签可见 | | |
| 便签已打开、最小化后按 | 恢复到前台 | | 走 `restore_and_focus` |
| 连按两次 | 只多一张 | | 验证 A7 |
| 睡眠唤醒后按 | 正常 | | 验证 A9 |
| 双屏（不同缩放）按 | 出现在鼠标所在屏 | | 验证 A6 |
| 关闭全部便签后按 | 新建一张 | | |
| 托盘「隐藏全部」后按 | 新建一张并显示 | | |

### 5.5 修复方向（只是建议，未实施）

1. **让失败可见**：新建/显示失败时给托盘气泡或一个 toast（前端已有 toast 能力，缺的是从 Rust 侧把错误带回 UI）。
2. **新建也走 raise + 强制重绘**：给 `open_note_window(focus=false)` 的两个分支（新建 / 已存在）都补一次 `force_repaint`（`windows.rs:359`）和「无 topmost 的 raise」，而不是完全依赖 Windows 给予前台权限。
3. **热键自愈**：注册失败时定时重试（比如 30 s 一次、最多 3 次），或在窗口获得焦点/托盘点击时补注册。
4. **唤醒后重注册**：监听 `WM_WTSSESSION_CHANGE`/电源事件或简单地在 `focus` 事件里调一次 `apply_all`。
5. **一键归位**：托盘菜单加「把所有便签移回当前屏幕」，作为 A6 的兜底。
6. **去重**：快捷键回调里加 300 ms 节流，避免 A7。

### 5.6 需要用户补充的三个信息

1. 「打不开」时是**完全没窗口**，还是**窗口在但空白**？
2. 当时前台是什么程序（是否管理员权限 / 全屏）？
3. 出问题后用托盘菜单能不能把便签叫出来（能 → 倾向 A2/A4/A6；不能 → 倾向 A1/A3/A5）？

---

## 6. 重点二：动画流畅度

### 6.1 动画清单（全在 `paper.css`，除尺寸动画）

| 动画 | 触发 | 时长 / 缓动 | 属性 | 位置 |
| --- | --- | --- | --- | --- |
| `xm-note-in` | 便签窗口首次渲染 | `--xm-dur-in` 0.22 s / `--xm-ease-out` | transform + opacity | `paper.css:96` |
| `xm-panel-in` | 面板/设置出现 | `--xm-dur-panel` 0.16 s | transform + opacity | `paper.css:1219`、`:1659` |
| `xm-pop-in` | 菜单/气泡 | `--xm-dur-in` 0.22 s / `--xm-ease-spring` | transform + opacity | `paper.css:924` |
| `xm-reminder-in` | 提醒浮层出现 | 0.24 s | transform + opacity | `paper.css:1845` |
| `xm-quick-in` | 快速记录浮层 | 0.14 s | transform + opacity | `paper.css:3922` |
| `xm-chrome-in` / `xm-chrome-out` | 工具栏显隐 | in 0.16 s（`--xm-dur-panel`）/ out 0.14 s | opacity/位移 | `paper.css:2060` / `:2293` |
| `xm-todo-moving` | 待办拖动重排 | 140 ms | transform | `paper.css:4080` |
| `xm-vault-copy` / `copied` | 一键复制反馈 | 900 ms / 120 ms | opacity | `paper.css:3088` / `:3107` |
| `xm-version-in`、`xm-diff-mode-in-a/b` | 修改记录/差异切换 | 120 ms | opacity | `paper.css:2699`、`:3510-3515` |
| `xm-kbd-breathe` | 快捷键捕获提示 | 1.2 s infinite | opacity | `paper.css:1808` |
| 纸色切换 | 设置里切浅色/深色 | `--xm-dur-theme` 0.3 s | 颜色过渡 | `tokens.css` |

缓动只有两条：`--xm-ease-out` = `cubic-bezier(.22,.61,.36,1)`，`--xm-ease-spring` = `cubic-bezier(.34,1.56,.64,1)`。

### 6.2 窗口尺寸动画（唯一的 JS/Rust 双端配合）

便签「紧凑 / 标准 / 大」和折叠展开不是 CSS 动画，而是 **Rust 每帧 SetWindowPos**：

- `windows.rs:386` 起注释与实现：维护「目标尺寸」，用**单个驱动线程**每帧推进窗口宽高并 `SetWindowPos`，避免多线程抢窗口。
- 前端通过 `--xm-*` 变量同步内部布局，避免窗口变了内容还按旧尺寸排版。

⚠ 审查点：如果前端同时用 CSS `transition` 改同一元素的尺寸，就会出现「双驱动」，观感是抖或延迟。建议确认尺寸变化期间前端只改不带动画的高度变量。

### 6.3 性能敏感点（按怀疑度排序）

1. **透明窗口 + 大面积 CSS 阴影/模糊**：`transparent(true)` 的窗口在 DWM 合成上更贵；**基线 v0.2.2** 的 `app.css:381` 有 `filter:blur(1.6px)`（分支 `c6566d6` 已移除），`paper.css` 里阴影层数很多。
2. **纸纹是运行时生成的噪点/渐变**：每张便签都在绘制多层 background，动画期间会重复栅格化。
3. **`--disable-features=CalculateNativeWinOcclusion`**（`windows.rs:384`）：好处是被遮挡的便签不会变白，代价是**被遮挡窗口仍继续合成**，多便签时更吃 GPU/CPU。
4. **WebView2 实例与渲染进程不是 1:1**：20 张便签不等于 20 个渲染进程（Chromium 可能合并部分进程）。要按 `tasklist /fi "imagename eq msedgewebview2.exe"` 实测进程数与内存，不能按窗口数推算。
5. **纸张纹理 + 字体的首次加载**：首次打开便签时字体（霞鹜文楷子集 woff2）与纸纹栅格化会带来一帧抖动。
6. **滚动时的纸边渐隐**：滚动条区域用渐变/遮罩实现，滚动过程中可能触发重绘（`sticky.ts` 里 data-scroll 三态切换）。

### 6.4 怎么量（可直接照做）

1. 打开 CDP（见 4.4），在便签页面执行：
   ```js
   // 动画对象是否泄漏
   document.getAnimations().map(a => a.animationName || a.transitionProperty)
   // 3 秒内的帧间隔
   const t=[]; let last=performance.now();
   const loop=()=>{const n=performance.now(); t.push(n-last); last=n; if(t.length<180) requestAnimationFrame(loop); else console.table(t.slice(-20));};
   requestAnimationFrame(loop);
   ```
2. 用 DevTools 的 Performance 面板录 3 秒（`cdp-console.mjs` 可辅助），看：
   - `Recalculate Style / Layout` 是否每帧都发生（说明改了布局属性）；
   - `Composite Layers` 是否过长（阴影/模糊太多）；
   - 长任务 > 16 ms 的位置。
3. 判定标准：60 Hz 下帧间隔中位数应 ≈16.7 ms，**掉帧超过 3 帧/秒**即视为不合格。

> **两条方法学校正（2026-11-13）**
> - `requestAnimationFrame` 回调间隔 ≠ 屏幕实际出帧：主线程空闲但合成器/DP 卡住时，rAF 仍会按时回调。它只能证明"主线程没有长任务"，不能证明"画面流畅"。
> - `document.getAnimations()` 的快照只能说明"此刻列表里有什么"，**不能**证明动画对象没有泄漏（泄漏要看多轮操作后对象数是否单调增长）。
> - 要证明呈现帧率，必须用 PresentMon / ETW 的 present 事件，或至少给出 95 分位帧间隔与丢帧数。

### 6.5 已知的低成本结论（不需要改代码就能验证）

- **不是所有动画都只动 transform/opacity/filter**（2026-11-13 校正）：尺寸动画是后端逐帧 `SetWindowPos` + 前端布局重排，属布局属性；
  纸色切换是颜色过渡。真正"只动合成属性"的只有入场/弹出/菜单/提醒/快速记录那几条。动效结论要按动画分开说，不能一句概括。
- `prefers-reduced-motion` 已有全局兜底（`paper.css` 的 reduced-motion 段），审查时确认新加动画也遵守。
- 夜间纸色切换是「整窗颜色过渡」，如果用户频繁切，会比动画更贵——可以考虑改成瞬时切换。

---

## 7. 其他值得审查的点（逐条给位置）

| # | 主题 | 现状 | 位置 |
| --- | --- | --- | --- |
| 1 | 保存并发 | 前端同一时刻只允许一个保存请求，飞行中的修改会排队重试（`retryAfterSave`）；后端全量写盘 | `sticky.ts` 保存段 |
| 2 | 原子写 | 临时文件 + `fsync` + `rename` 重试 | `store.rs:1679` |
| 3 | 隐藏 vs 关闭 | 「关闭窗口」只是 hide，进程常驻；真正销毁在退出时 | `windows.rs:682-698` |
| 4 | 多显示器 / DPI | 几何存物理像素，用显示器 scale 换算；位置最后 clamp 到目标屏 | `windows.rs:212-278`、:654-679` |
| 5 | 提醒可靠性 | 20 s 轮询；睡眠期间过期会补发；重复规则由 `next_repeat_at` 计算 | `reminder.rs`、`store.rs` |
| 6 | 历史版本 | 每张便签保留 `HISTORY_KEEP = 60` 条，写盘失败不影响主数据 | `store.rs:33`、:463-530 |
| 7 | 导出 | 只导 Markdown + JSON（**不含图片**，目前也没有图片功能） | `store.rs:935` |
| 8 | 导入 | `import_notes_file` 逐条合并，同 id 跳过 | `store.rs:1089` 起 |
| 9 | 托盘 | 托盘重建依赖 `tray.rs`；explorer.exe 重启后是否自动恢复需实测 | `tray.rs` |
| 10 | 无障碍 | contenteditable 正文无 `aria-label`，Tab 焦点顺序未系统验证 | `sticky.ts`、`paper.css` |
| 11 | 键盘 | PageUp/PageDown 已随「翻页改滚动」下线，设置页文案需与实现一致 | `settings.ts` |
| 12 | 崩溃可观测性 | 只有日志，无 panic 上报/崩溃转储 | `lib.rs` |
| 13 | 升级 | 安装包 currentUser 模式，覆盖 exe；数据在 APPDATA 不受影响 | `tauri.conf.json` |
| 14 | 单实例 | 重复启动只唤起已有实例 | `lib.rs` |

---

## 8. 已交付功能（回归基线，改动后请逐项过）

- 桌面便签：置顶/取消置顶、拖动、折叠、锁定、六色纸、字号三档、大小三档、吸边
- 编辑：标题 + 正文、`Ctrl+S`、停输 0.8 s 自动保存、长文滚动（纸边渐隐）
- 待办：勾选划线 + 音效、回车新增、退格删空行、拖动排序、到期时间、底部统计
- 管理面板：搜索（标题/正文/待办）、筛选（时间/类型/颜色，两组之间有分隔线）、键盘上下选择、回收站、修改记录（差异/全文、恢复）
- 提醒：到点浮层、稍后 10 分钟、重复（每天/工作日/每周）、提醒声音开关
- 快速记录：`Ctrl+Alt+Space` 浮层，回车保存并直接打开便签
- 数据：每日备份、从备份恢复、导出（md+json）、导入、打开数据目录
- 系统：开机自启、托盘菜单、三个可自定义全局快捷键、深浅色跟随时间

---

## 9. 验收门禁

**代码门禁（CI 已覆盖）**

```bash
npm run typecheck
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

**真机冒烟（必须人工）**

1. 冷启动 → 第一张便签出现，托盘图标在
2. `Ctrl+Alt+N` 连按两次：只多一张，且在最前
3. `Ctrl+Alt+M` 面板：搜索、筛选、回车打开
4. `Ctrl+Alt+Space` 快速记录：回车保存并打开
5. 便签里打字 → `Ctrl+S` → 关闭 → 重开，内容与光标位置正常
6. 同一张便签设提醒 → 触发 → 「知道了」→ 再设一次 → 第二次按钮可用（历史 bug 回归点）
7. 折叠/展开、锁定/解锁、六色切换、字号三档
8. 面板里删除 → 5 秒内「撤销」可恢复；回收站恢复/清空
9. 修改记录里恢复旧版本，正文正确
10. 切夜间纸色 → 重启 → 仍是夜间

---

## 10. 附录

### A. 日志关键字（找问题先 grep 这些）

- `快捷键「…」注册失败` —— 热键被占用
- `新建便签失败` / `创建窗口失败` —— 窗口创建失败
- `raise <label>: before(vis,min,focus)=` —— 置顶动作与前后状态
- `open_note_window` / `open_aux` —— 窗口打开路径
- `new note placed at (x,y)` —— 新便签落点（多屏问题看这个）
- `隐藏全部便签失败` / `写入数据失败` —— 存储异常

### B. 三次历史事故（当作 bug 模式参考）

1. **宽正则批量改源码**：曾用一条 `[（(]\s*[）)]` 的正则批量清理注释，把全仓源码里的空括号 `()` 全删了，26 个前端文件语法崩坏。→ **不要用宽正则批量改源码**；改动前先备份。
2. **单例窗口复用不重挂载**：提醒窗复用同一个 URL 时 WebView2 不重新加载，第二轮按钮卡死。→ 复用的窗口要有「重置状态」的显式路径（现在是 URL 加 `ts` + 前端监听事件）。
3. **空列表被误判「已一致」**：待办便签没有待办项时，DOM 对比函数认为「渲染结果和草稿一致」，于是永远不追加「+ 新待办」行，用户无法新增。→ 空集合要单独判断。

### C. 已知限制（不是 bug）

- 无图片支持（设计草图已完成，未实现；不要在审查阶段当成缺陷）
- 无云同步 / 无账号
- 导出不含图片（因为还没有图片）
- 未做代码签名：首次运行会有 SmartScreen 提示（计划申请 SignPath Foundation 的免费开源签名）
- 提醒依赖应用常驻（开机自启 + 托盘）
- 「关闭窗口」只是隐藏，内存不释放（设计取舍：保证秒开）
- 便携版和安装版同时存在时共用同一份 APPDATA 数据

### D. 快速定位表

| 我想看… | 去这里 |
| --- | --- |
| 快捷键为什么没反应 | `hotkey.rs` + `windows.rs:598-651` + `boot.log` |
| 窗口为什么在下面 | `windows.rs:283-330`（restore/raise） |
| 窗口位置为什么奇怪 | `windows.rs:212-278`（note_geometry）、:654-679` |
| 动画在哪 | `paper.css`（搜 `@keyframes`）、`tokens.css`（时长/缓动） |
| 尺寸动画怎么做的 | `windows.rs:386` 起 |
| 数据存在哪、怎么写的 | `store.rs:201-203`、`:1679`（write_atomic） |
| 提醒怎么算下一次 | `store.rs` 的 `next_repeat_at`、`reminder.rs` |
| 前端怎么调后端 | `src/shared/api.ts` |

---

*本文档由开发方在交接时生成，只描述 v0.2.2 的现状，未修改任何源码。*