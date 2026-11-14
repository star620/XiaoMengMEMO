# 便签贴照片 · 实现契约（v1）

> 目的：让便签正文里能贴照片（截图/手机图/拖进来的图片文件），纸面上按「相纸贴在纸上」的样子排版，点开能看大图，面板能看到缩略图，导出 Markdown 时图片跟着走。
> 本文是 frontend-ui / backend-rust / visual-paper 三方唯一对接标准。**命令名、参数名、DOM 类名、语法一旦写定就不要改名**，要改先在共享任务里说。

---

## 1. 正文语法（唯一事实来源：便签正文纯文本）

图片在正文里占**单独一行**，形式：

```text
![](xmimg:img_3f9a2c7d51b84e60.png)
![](xmimg:img_3f9a2c7d51b84e60.png "楼下新开的面包店")
```

- `xmimg:` 是协议前缀，后面是**文件名**（不是路径、不是 URL）。
- 文件名格式固定：`img_[0-9a-f]{16}.(png|jpg|webp)`。
- 可选说明用**半角双引号**包起来，写在同一行方括号里（`![]` 的方括号始终留空，说明放圆括号末尾的引号里）。说明里不要换行。
- 只有当**整行**匹配 `^!\[\]\(xmimg:NAME(\s+"(.+)")?\)$`（允许行首尾空白）时才当图片；行中间夹着的 token 按普通文字处理（原样显示），不做替换。
- 编辑态（`data-md="0"`）显示**原始 token 文本**，这是刻意设计：写的时候看到源码，失焦后看到照片。不要求把 token 变成小卡片。

---

## 2. 存储（backend-rust）

- 图片目录：`%APPDATA%\XiaoMengMemo\images\`，随用随建。
- 文件名由后端生成（前端不命名）：`img_<16 位小写 hex>.<ext>`，扩展名按**字节头嗅探**：
  - `89 50 4E 47` → `png`
  - `FF D8 FF` → `jpg`
  - `RIFF....WEBP` → `webp`
  - 其他 → 返回错误「这个图片格式还不支持（png / jpg / webp）」。
- 原样落盘，**不重编码、不压缩、不生成缩略图**（不引入 image crate）。
- 单张上限 **15 MB**（解码后字节数），超了返回错误「图片太大了（单张上限 15 MB）」。
- 写入用「临时文件 + rename」原子落盘，参考 store.rs 里 notes.json 的写法。

---

## 3. IPC 命令（backend-rust 实现，frontend-ui 封装）

### 3.1 新增
```rust
/// 存一张图片，返回文件名（形如 img_xxxx.png）。data 是 base64（不带 data: 前缀）
#[tauri::command]
pub fn save_image(app: AppHandle, data: String) -> Result<String, String>
```
- 参数名必须叫 `data`（前端 `invoke("save_image", { data })`）。
- 成功返回文件名；失败返回中文错误（直接 toast 给用户看）。
- 命令要注册进 `src-tauri/src/lib.rs` 的 `generate_handler!`。

### 3.2 改动
- `model.rs` 的 `Snapshot` 增加字段：
  ```rust
  /// 图片目录的绝对路径（前端拼 asset URL 用）；取不到时为空串
  pub image_dir: String,
  ```
  `get_snapshot` 里填 `%APPDATA%\XiaoMengMemo\images` 的绝对路径（字符串，Windows 反斜杠即可）。
- `tauri.conf.json` → `app.security` 增加 asset protocol（Windows 走 `http://asset.localhost`）：
  ```json
  "assetProtocol": { "enable": true, "scope": ["$APPDATA/XiaoMengMemo/images/**"] }
  ```
  CSP 的 `img-src` 追加 `asset: http://asset.localhost`，最终形如：
  `"img-src 'self' data: blob: asset: http://asset.localhost; ..."`
- `export_notes()`：导出目录里建 `images/`，把导出内容里引用到的图片**复制**过去（同名），并把导出的 .md 里 token 改写成 `![](images/<name>)`（说明保留）。复制失败不致命，继续导出并在返回日志里记一行。
- 清理：`empty_trash()` 之后（或彻底删除便签时）扫描所有 notes + trash + 版本历史正文里的 `xmimg:NAME`，把 images 目录里**没人引用**的文件删掉。宁可不删也不要误删；实现简单为先。

### 3.3 前端封装（src/shared/api.ts）
```ts
/** 存一张图片（base64，不带 data: 前缀），返回文件名 */
export function saveImage(data: string): Promise<string>
```
mock 模式（src/shared/mock.ts）返回 `img_${随机 16 hex}.png` 之类的假名，并把 data URL 存进模块内 Map，供 `__mockImageUrl(name)` 取。

---

## 4. 前端（frontend-ui）

### 4.1 新文件 `src/shared/images.ts`
```ts
/** 整行图片 token 的正则（不含换行） */
export const IMG_LINE_RE = /^\s*!\[\]\(xmimg:([A-Za-z0-9_.-]+)(?:\s+"([^"]*)")?\)\s*$/;

/** Snapshot 加载后调用一次；dir 为空串表示非 Tauri / mock */
export function setImageDir(dir: string): void;

/** 文件名 → 可放进 <img src> 的 URL。
 *  Tauri：convertFileSrc(dir + "/" + name)；mock：__mockImageUrl(name)；都没有："" */
export function imageUrl(name: string): string;

/** 正文里引用到的图片文件名，按出现顺序去重 */
export function imageNames(content: string): string[];
```
- `convertFileSrc` 从 `@tauri-apps/api/core` 导入；拼路径时先把 dir 末尾的 `/\` 去掉再加 `/`，不要用 path.join（会出反斜杠和 asset URL 冲突）。
- **markdown.ts 不能直接 import 浏览器/Tauri API**：`mdToHtml(src, opts?: { imageUrl?: (name: string) => string })` 由调用方注入解析器。sticky 调用时传 `{ imageUrl }`。
- 非 Tauri 且 mock 没数据时 `imageUrl` 返回 `""`，markdown 渲染成占位块（见 4.3）。

### 4.2 markdown.ts
整行 token 输出（块级，带源码行号）：
```html
<figure class="xm-photo" data-md-line="12" data-img="img_xxx.png">
  <img class="xm-photo__img" src="..." alt="说明" loading="lazy" decoding="async" draggable="false">
  <figcaption class="xm-photo__cap">说明</figcaption>   <!-- 没说明就不输出 -->
</figure>
```
没有 URL 时输出：
```html
<figure class="xm-photo xm-photo--missing" data-md-line="12" data-img="img_xxx.png">
  <div class="xm-photo__missing">图片暂时打不开</div>
</figure>
```
说明文字要 `escapeHtml`。不要把 `data-img` 里的名字再 escape 掉（文件名是受控的），但仍建议统一走 escapeHtml 保持习惯。

### 4.3 sticky.ts
1. `renderMarkdown()`：`mdToHtml(draft.content, { imageUrl })`。
2. **点图开灯箱**：渲染态点击目前走 `restoreFromClick(x, y)`（约 :1326）。在里面先判断命中：`el?.closest(".xm-photo")`，命中且 `data-img` 存在 → `openLightbox(noteId, names, index)` 后 **直接 return**，不要进编辑态、不要 placeCaret。
3. **粘贴**：`editor` 上加 `paste` 监听（只在编辑态 `data-md="0"` 时处理）：
   - 从 `e.clipboardData?.items` 找 `type.startsWith("image/")` 的项 → `preventDefault()`；
   - `getAsFile()` → FileReader 读 dataURL → 去掉 `data:...;base64,` 前缀 → `api.saveImage(b64)`；
   - 成功后在该位置插入 `\n![](xmimg:<name>)\n`（保证独占一行：若光标前后不是换行就补换行），`markDirty()` + `scheduleSave()`，toast「图片已贴到便签上」（沿用现有 toast）；
   - 失败 toast 后端返回的中文错误。
   - **不要抢输入**：粘贴成功不要让编辑器失焦；光标停在 token 之后的新行。
4. **拖入图片文件**：`editor`（或整张纸 `.xm-note__paper`）监听 `dragover`（`preventDefault`）与 `drop`：`e.dataTransfer.files` 里有 `type.startsWith("image/")` 的文件 → 同上流程，插入位置用 `caretRangeFromPoint(e.clientX, e.clientY)`（拿不到就插到正文末尾）。
5. **灯箱（同文件实现即可）**：
   - 结构挂到 `document.body`：`.xm-lightbox[data-open="1"] > .xm-lightbox__stage > img.xm-lightbox__img + .xm-lightbox__count + button.xm-lightbox__close + button.xm-lightbox__prev + button.xm-lightbox__next`；`.xm-lightbox__cap` 放说明（没有就隐藏）。
   - 同一个便签内的图片按正文顺序成册；← / → 切换，Esc 关闭；点背景关闭；按钮别把点击冒泡到纸面。
   - **Esc 层级**：有灯箱时 Esc 只关灯箱（并 `stopPropagation`），不要再触发「退出编辑 / 关窗口」；灯箱关闭后焦点回纸面。
   - 打开灯箱时给 `documentElement` 加 `data-xm-lightbox="1"`（视觉层用来禁掉纸面 hover 效果），关掉时移除。
6. 便签底部字数统计、滚动状态这些函数**不要因为图片块而算错**：图片行不计入字数（沿用现有实现即可，若现有实现按 DOM 文本取字数，需改成继续用 `draft.content` 过滤掉图片行）。

### 4.4 panel.ts
- 卡片正文预览：把图片行替换成 `[图片]`（避免一大串 token 占满两行）。
- 卡片缩略图：`.xm-card__head` 之后、`.xm-card__text` 之前插入
  ```html
  <div class="xm-card__thumbs" data-count="3">
    <img class="xm-card__thumb" src="..." alt="" loading="lazy">
    ...
  </div>
  ```
  最多 **3 张**（取正文里前 3 个图片），多于 3 时 `data-count` 写真实数量，CSS 用 `::after` 显示 `+N`。没有图片就不输出这个 div。
- 搜索：正文里图片 token 不参与拼音/关键字匹配（避免搜 "xmimg" 命中）；标题/普通正文照旧。

### 4.5 mock.ts
- 让 `?surface=sticky` 的示例便签里带 1~2 张图（用内置 data URL，例如 1x1 透明 png 太丑，用 300x200 的 SVG data URL 画一个占位图），这样浏览器里能直接看到相纸排版与灯箱。

---

## 5. 视觉（visual-paper，写 src/styles/paper.css）

新开一节「## 24. 便签照片（相纸 / 灯箱 / 面板缩略图）」，要求：

### 5.1 纸面照片 `.xm-photo`
- 相纸感：近白纸底（`#fffdf8`）、内边距 `7px 7px 0`、底部多留 `26px` 放说明、`border-radius: 3px`、`box-shadow: 0 1px 2px rgba(90,70,30,.16), 0 6px 14px -8px rgba(90,70,30,.35)`。
- 轻微倾斜：`.xm-photo:nth-of-type(odd) { transform: rotate(-1deg) }`、`even { rotate(.8deg) }`；`:hover` 回正到 0 并略微抬起（transition 200ms）。
- 图片：`display:block; width:100%; border-radius:2px; max-height:132px; object-fit:cover; background:#e8e0cf`（高度上限保证一张便签里文字仍有空间）。
- 说明：`font-size:11.5px; color: var(--xm-ink-meta); text-align:center; margin-top:6px; font-family:var(--xm-font-hand)`。
- 缺图占位 `.xm-photo--missing`：虚线边 + `图片暂时打不开` 居中灰字，斜度同上。
- 夜间（`[data-theme="night"]`）：相纸底压到 `#f3ecdd`、阴影加深、说明字色用夜间 meta 色；照片本身不变亮。

### 5.2 灯箱 `.xm-lightbox`
- 全屏 fixed 覆盖，`background: rgba(24,20,12,.82)` + `backdrop-filter: blur(6px)`；`z-index` 高于便签菜单。
- 图：白相纸框（`padding:10px 10px 30px`）+ 大阴影，`max-width:86vw; max-height:78vh; object-fit:contain`；说明在图下，浅色。
- 计数 chip 左上（`1 / 3`），关闭右上（`×`），左右箭头垂直居中，圆形半透明底、hover 变亮；都支持键盘焦点可见。
- 打开/关闭动效：`opacity` + `scale(.98→1)` 180ms；`prefers-reduced-motion` 下取消。

### 5.3 面板缩略图 `.xm-card__thumbs`
- 一行、`gap:6px`、`margin: 2px 0 6px`；单张 `48x36`、`border-radius:4px`、`object-fit:cover`、1px 暖色描边；超过 3 张时第 3 张右下角盖 `+N` 小角标。
- 夜间：描边用夜间纸边色。

### 5.4 交付物
- 样式直接写进 `src/styles/paper.css` 末尾（**追加定位必须用文件真实末尾**）。
- 另写一张对照样张 `docs/style-lab/photo-lab.html`（纯 CSS/SVG 假图即可），并截图 `docs/shots/photo/lab.png` 自查（相纸斜度、说明字、灯箱、缩略图、夜间）。

---

## 6. 验收清单（Lead 负责真机跑）
1. `Ctrl+Alt+N` 新建便签 → 截图工具/文件复制图片 → 便签里 `Ctrl+V` → 失焦后纸面上出现相纸照片（倾斜、白边、说明）。
2. 点照片 → 灯箱打开、←/→ 切图、Esc 关闭且不退出编辑/不关窗口。
3. 拖一张 png 进便签 → 同样贴上去。
4. 面板里该卡片出现缩略图，点开便签能看到图。
5. 设置 → 导出全部便签 → 导出目录里有 `images/`，md 里是 `![](images/xxx.png)` 且能被 Markdown 阅读器显示。
6. 回收站清空后，没人引用的图片文件被清掉（`%APPDATA%\XiaoMengMemo\images` 数量下降）。
7. 夜间纸色下照片/灯箱/缩略图都可读。

---

## 7. 构建与真机（所有人）
- 只用 `tools\*.ps1` 里的封装；cargo 必须 `$env:NO_PROXY='*'`。
- 不要自己跑 `tauri build`、不要杀正在运行的 xiaomeng-memo 进程（Lead 统一构建/装机/验收）。
- 前端自测：`npm run build`（`tsc --noEmit` 必须过）；浏览器可看 `?surface=sticky&id=<mock id>`。
