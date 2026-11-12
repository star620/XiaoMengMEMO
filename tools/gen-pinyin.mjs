// 生成 src/shared/pinyin.ts：常用汉字 -> 拼音首字母表。
// 只跑一次就够；以后要更新常用字表，重新执行 node tools/gen-pinyin.mjs。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { pinyin } from "pinyin-pro";

const here = dirname(fileURLToPath(import.meta.url));
// pinyin-pro 没有导出词表，只能按包内路径取；升级大版本时如果目录变了，这里会给出明确报错
const PINYIN_PRO_DATA_DIR = "../node_modules/pinyin-pro/dist/esm/data/";
const loadDict = async (name) => {
  const url = new URL(PINYIN_PRO_DATA_DIR + name + ".mjs", import.meta.url);
  try {
    const mod = await import(url);
    return mod.default;
  } catch (error) {
    throw new Error("读不到 pinyin-pro 词表（" + name + "）：先运行 npm install，或这个版本的目录结构变了。\n" + String(error));
  }
};
const dicts = [await loadDict("dict2"), await loadDict("dict3"), await loadDict("dict4")];

const seen = new Set();
const chars = [];
for (const dict of dicts) {
  for (const word of Object.keys(dict)) {
    for (const ch of word) {
      if (!/^[\u4e00-\u9fff]$/.test(ch) || seen.has(ch)) continue;
      seen.add(ch);
      chars.push(ch);
    }
  }
}

const kept = [];
for (const ch of chars) {
  const initial = pinyin(ch, { pattern: "first", toneType: "none" });
  if (/^[a-z]$/.test(initial)) kept.push([ch, initial]);
}

const chunk = (text, size = 80) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};
const literal = (text) =>
  chunk(text)
    .map((part) => "  " + JSON.stringify(part))
    .join(" +\n");

// 体积守住：字表太大没必要，太小又搜不全
const MIN_CHARS = 500;
const MAX_CHARS = 4000;
const MAX_BYTES = 20000;
if (kept.length < MIN_CHARS) {
  throw new Error("只收到 " + kept.length + " 个常用字（至少要 " + MIN_CHARS + "），pinyin-pro 词表可能没读到。");
}
if (kept.length > MAX_CHARS) {
  throw new Error("收到 " + kept.length + " 个常用字（上限 " + MAX_CHARS + "），请缩小字表来源。");
}

const content = `// 这个文件由 tools/gen-pinyin.mjs 生成，请勿手改。
// 重新生成：npm run gen:pinyin
// 常用汉字 -> 拼音首字母（zh/ch/sh 已归并为 z/c/s），用于面板拼音首字母搜索（契约 §16.2）。
// 数据来源：pinyin-pro 自带常用词表（dict2/3/4）中出现的单字，未收录的字不参与首字母匹配。
const CHARS =
${literal(kept.map(([ch]) => ch).join(""))};

const INITIALS =
${literal(kept.map(([, initial]) => initial).join(""))};

export const PINYIN_INITIAL: Record<string, string> = {};
for (let i = 0; i < CHARS.length; i += 1) {
  PINYIN_INITIAL[CHARS[i]] = INITIALS[i];
}
`;

const target = resolve(here, "../src/shared/pinyin.ts");
const bytes = Buffer.byteLength(content, "utf8");
if (bytes > MAX_BYTES) {
  throw new Error("生成的拼音表 " + bytes + " 字节，超过 " + MAX_BYTES + " 字节上限，会拖慢启动。");
}
writeFileSync(target, content, "utf8");
console.log("生成 " + target + "： " + kept.length + " 个常用字，" + bytes + " 字节");
