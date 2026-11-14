/**
 * 便签照片：文件名 <-> 可放进 <img src> 的 URL。
 *
 * 契约见 docs/images-contract.md §4.1。
 * 正文里只存文件名（xmimg:img_xxx.png），真实文件由 Rust 端存在
 * %APPDATA%\XiaoMengMemo\images\；桌面端用 Tauri 的 asset 协议读，
 * 浏览器 mock 用内存里的 data URL。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "./env";

/** 整行图片 token 的正则（不含换行；说明可有可无） */
export const IMG_LINE_RE = /^\s*!\[\]\(xmimg:([A-Za-z0-9_.-]+)(?:\s+"([^"]*)")?\)\s*$/;

/** 图片目录；空串表示非 Tauri / mock 还没有目录 */
let imageDir = "";

/** Snapshot 加载后调用一次。传空串表示当前环境没有图片目录。 */
export function setImageDir(dir: string): void {
  imageDir = String(dir ?? "").trim().replace(/[\\/]+$/, "");
}

/** 这一行是不是一张图片（整行才算，行中间夹的 token 当普通文字） */
export function isImageLine(line: string): boolean {
  return IMG_LINE_RE.test(line);
}

/**
 * 文件名 -> <img src> 能用的 URL。
 * - 桌面端：asset 协议；目录未知时返回 ""，markdown 会画「图片暂时打不开」占位。
 * - 浏览器 mock：mock 模块把解析器挂在 globalThis.__XM_MOCK_IMAGE_URL__ 上，
 *   这里动态取，避免 images.ts 反过来把整个 mock 包进主包。
 */
export function imageUrl(name: string): string {
  if (!name) return "";
  if (isTauri()) {
    if (!imageDir) return "";
    // 不要用 path.join：Windows 反斜杠会混进 asset URL
    return convertFileSrc(imageDir + "/" + name);
  }
  const resolver = (globalThis as { __XM_MOCK_IMAGE_URL__?: (file: string) => string })
    .__XM_MOCK_IMAGE_URL__;
  return typeof resolver === "function" ? resolver(name) : "";
}

/** 正文里引用到的图片文件名，按出现顺序去重 */
export function imageNames(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of String(content ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const match = IMG_LINE_RE.exec(line);
    if (!match) continue;
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** 取某张图片在正文里的说明（没有就空串） */
export function imageCaption(content: string, name: string): string {
  for (const line of String(content ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const match = IMG_LINE_RE.exec(line);
    if (match && match[1] === name) return match[2] ?? "";
  }
  return "";
}

/**
 * 把正文里的图片行换掉：面板摘要用 [图片]，搜索时用空串（避免搜 xmimg 命中）。
 * 只换整行 token，普通段落里的 token 原样保留。
 */
export function replaceImageLines(content: string, replacement = "[图片]"): string {
  return String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (isImageLine(line) ? replacement : line))
    .join("\n");
}
