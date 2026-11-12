/**
 * 极简 Markdown 解析（零依赖、纯函数）
 *
 * 只做契约 §10.2 列出的那几种语法；别的写法一律当普通文字。
 * 所有文本都先做 HTML 转义，绝不透传原始 HTML —— 便签内容来自用户剪贴板，
 * 这里只要有一个地方漏转义，整张纸就可能被注入脚本。
 *
 * 输出块元素都带 data-md-line（源码行号，0 起），
 * 渲染态点回编辑时靠它把光标放到"点的那一块"对应的源码行行尾。
 */
import { escapeHtml } from "./dom";


/**
 * 行内语法：**粗** __粗__ *斜* _斜_ ~~删~~ `行内代码`
 * 先按行内代码切段，代码里的星号/下划线原样保留，不会再被解析。
 */
function inline(raw: string): string {
  // 反引号里的内容单独处理，避免代码里的 * _ ~~ 被误当语法
  const parts = raw.split(/(`[^`\n]+`)/g);
  let html = "";
  for (const part of parts) {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      html += '<code class="xm-md-code">' + escapeHtml(part.slice(1, -1)) + "</code>";
      continue;
    }
    let s = escapeHtml(part);
    // 顺序有讲究：先粗体（两个星号），再删除线，最后单个星号/下划线
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    // 下划线要求两侧不是字母数字，避免把 snake_case 这种变量名变成斜体
    s = s.replace(/(^|[^\w_])_([^_]+)_(?![_\w])/g, "$1<em>$2</em>");
    html += s;
  }
  return html;
}

/** 这一行是不是块的开始（段落遇到它就要收尾） */
function startsBlock(line: string): boolean {
  if (/^\s*```/.test(line)) return true;
  if (/^\s{0,3}#{1,3}\s+/.test(line)) return true;
  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (/^\s{0,3}[-*+]\s+/.test(line)) return true;
  if (/^\s{0,3}\d+\.\s+/.test(line)) return true;
  return false;
}

/**
 * Markdown 源码 -> 安全的 HTML
 * 支持的块：# ~ ### 标题、- * + 无序列表、1. 有序列表、> 引用、--- 分隔线、``` 代码块、普通段落。
 */
export function mdToHtml(src: string): string {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  /** 每个块都记下源码行号，点回来时才知道光标该放哪一行 */
  const lineAttr = (line: number): string => ' data-md-line="' + line + '"';

  while (i < lines.length) {
    const line = lines[i];

    // 代码块：围栏之间的内容原样保留（只转义，不再解析）
    if (/^\s*```/.test(line)) {
      const start = i;
      i += 1;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过收尾围栏
      out.push('<pre class="xm-md-pre"' + lineAttr(start) + "><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
      continue;
    }

    // 空行：只起分段作用
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // 标题：# -> h2，## -> h3，### -> h4
    const heading = /^\s{0,3}(#{1,3})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const tag = level === 1 ? "h2" : level === 2 ? "h3" : "h4";
      out.push("<" + tag + ' class="xm-md-' + tag + '"' + lineAttr(i) + ">" + inline(heading[2]) + "</" + tag + ">");
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr class="xm-md-hr"' + lineAttr(i) + ">");
      i += 1;
      continue;
    }

    // 引用：连续的 > 行合成一个 blockquote，行之间用 <br> 断开
    if (/^\s{0,3}>/.test(line)) {
      const start = i;
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoted.push(inline(lines[i].replace(/^\s{0,3}>\s?/, "")));
        i += 1;
      }
      out.push('<blockquote class="xm-md-quote"' + lineAttr(start) + ">" + quoted.join("<br>") + "</blockquote>");
      continue;
    }

    // 无序列表
    if (/^\s{0,3}[-*+]\s+/.test(line)) {
      const start = i;
      const items: string[] = [];
      while (i < lines.length && /^\s{0,3}[-*+]\s+/.test(lines[i])) {
        items.push('<li class="xm-md-li">' + inline(lines[i].replace(/^\s{0,3}[-*+]\s+/, "")) + "</li>");
        i += 1;
      }
      out.push('<ul class="xm-md-ul"' + lineAttr(start) + ">" + items.join("") + "</ul>");
      continue;
    }

    // 有序列表
    if (/^\s{0,3}\d+\.\s+/.test(line)) {
      const start = i;
      const items: string[] = [];
      while (i < lines.length && /^\s{0,3}\d+\.\s+/.test(lines[i])) {
        items.push('<li class="xm-md-li">' + inline(lines[i].replace(/^\s{0,3}\d+\.\s+/, "")) + "</li>");
        i += 1;
      }
      out.push('<ol class="xm-md-ol"' + lineAttr(start) + ">" + items.join("") + "</ol>");
      continue;
    }

    // 普通段落：连续的非空普通行合成一段，行与行之间保留 <br>。
    // 严格 Markdown 会把单换行当空格，但这是便签：用户按下的回车就是想要的换行，
    // 保存后又被「缩回去」很难理解，所以这里按硬换行渲染（GFM breaks 的行为）。
    const start = i;
    const paragraph: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !startsBlock(lines[i])) {
      paragraph.push(lines[i].replace(/\s+$/, ""));
      i += 1;
    }
    if (paragraph.length > 0) {
      out.push('<p class="xm-md-p"' + lineAttr(start) + ">" + paragraph.map(inline).join("<br>") + "</p>");
    } else {
      // 理论上不会走到这里；保底跳过这一行，避免死循环
      i += 1;
    }
  }

  return out.join("");
}

/**
 * Markdown 源码 -> 去标记的纯文本
 * 面板卡片摘要、字数统计用。不追求排版，只保证"读起来是人话"。
 */
export function mdToPlain(src: string): string {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(raw);
      continue;
    }
    if (/^\s*$/.test(raw)) {
      out.push("");
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      out.push("");
      continue;
    }
    let line = raw;
    line = line.replace(/^\s{0,3}#{1,3}\s+/, "");
    line = line.replace(/^\s{0,3}>\s?/, "");
    line = line.replace(/^\s{0,3}[-*+]\s+/, "");
    line = line.replace(/^\s{0,3}\d+\.\s+/, "");
    line = line.replace(/`([^`]*)`/g, "$1");
    line = line.replace(/\*\*([^*]+)\*\*/g, "$1");
    line = line.replace(/__([^_]+)__/g, "$1");
    line = line.replace(/~~([^~]+)~~/g, "$1");
    line = line.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
    line = line.replace(/(^|[^\w_])_([^_]+)_(?![_\w])/g, "$1$2");
    out.push(line);
  }
  return out.join("\n");
}

/** 内容是不是"空的"（只有空白或只有分隔线/空代码块） */
export function mdIsEmpty(src: string): boolean {
  return mdToPlain(src).trim() === "";
}
