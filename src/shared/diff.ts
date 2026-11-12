/**
 * 字符级差异（任务 33，契约 §15.1）
 *
 * 修改记录里要把「这一版比上一版改了哪几个字」标出来：
 *  - 相同部分保持原样；
 *  - 新增的字墨绿下划线，删除的字朱红删除线；
 *  - 不左右并排，所以只要一条线性的编辑脚本。
 *
 * 做法：先裁掉公共前后缀（中文长文往往只改中间几个字），
 * 中间用 Myers 最短编辑路径；规模太大就退回「整段删 + 整段增」，宁可粗也不卡 UI。
 * 全程按 Unicode 码点切分（Array.from），emoji 不会被切成两个孤立的代理项。
 * 纯函数，不碰 DOM，也不依赖 Tauri，方便单独调试。
 */

export type DiffType = "same" | "add" | "del";

export interface DiffOp {
  type: DiffType;
  /** 这一段连续文本；相邻同类会合并，不会被拆成一堆碎片 */
  text: string;
}

/** Myers 的编辑距离上限；超过就降级，避免长文把主线程拖住 */
const MAX_D = 3000;
/** 中段的格子数上限（n * m）；超过直接整块增删 */
const MAX_CELLS = 2_000_000;

/** 相邻同类合并：生成的 DOM 里 span 越少越清楚 */
function pushOp(ops: DiffOp[], type: DiffType, text: string): void {
  if (!text) return;
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}

/**
 * 比较两段文字，返回从 prev 到 next 的连续操作。
 * 返回值按原文顺序排列，空白和换行都原样保留（渲染层用 pre-wrap）。
 */
export function diffText(prev: string, next: string): DiffOp[] {
  if (prev === next) return prev ? [{ type: "same", text: prev }] : [];

  // 1. 按码点拆开：中文一个字、emoji 一个字符，都不会被从中间切开
  const prevChars = Array.from(prev);
  const nextChars = Array.from(next);

  // 2. 公共前缀 / 后缀：按字符比较，不在 UTF-16 码元上切
  let start = 0;
  const maxStart = Math.min(prevChars.length, nextChars.length);
  while (start < maxStart && prevChars[start] === nextChars[start]) start += 1;

  let endPrev = prevChars.length;
  let endNext = nextChars.length;
  while (
    endPrev > start &&
    endNext > start &&
    prevChars[endPrev - 1] === nextChars[endNext - 1]
  ) {
    endPrev -= 1;
    endNext -= 1;
  }

  const prefix = prevChars.slice(0, start).join("");
  const suffix = prevChars.slice(endPrev).join("");
  const a = prevChars.slice(start, endPrev);
  const b = nextChars.slice(start, endNext);

  const ops: DiffOp[] = [];
  pushOp(ops, "same", prefix);

  if (a.length === 0) {
    pushOp(ops, "add", b.join(""));
  } else if (b.length === 0) {
    pushOp(ops, "del", a.join(""));
  } else if (a.length * b.length > MAX_CELLS) {
    // 大段重写：不去算最小编辑，直接告诉用户「这里整段换了」
    pushOp(ops, "del", a.join(""));
    pushOp(ops, "add", b.join(""));
  } else {
    const middle = myers(a, b);
    if (middle) middle.forEach((op) => pushOp(ops, op.type, op.text));
    else {
      pushOp(ops, "del", a.join(""));
      pushOp(ops, "add", b.join(""));
    }
  }

  pushOp(ops, "same", suffix);
  return ops;
}

/** 统计增删了多少个「字」：空白不计，换行和空格不算改动量 */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added += countChars(op.text);
    else if (op.type === "del") removed += countChars(op.text);
  }
  return { added, removed };
}

function countChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!/\s/.test(char)) count += 1;
  }
  return count;
}

/**
 * Myers O(ND) 贪心：只处理已经裁掉公共前后缀的中段。
 * a / b 都是按码点切好的字符数组，比较时直接比字符串。
 * 返回 null 表示编辑距离超过 MAX_D（调用方会降级成整块增删）。
 */
function myers(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  // v[k] = 走到对角线 k 时最远的 x；从 k=1 开始是 Myers 的惯例，方便 k=0 起步
  const v = new Map<number, number>();
  v.set(1, 0);
  /** 每一轮开始前的 v 快照，回溯时用；只存 k 在 [-d,d] 内的有效值 */
  const trace: Map<number, number>[] = [];

  for (let d = 0; d <= max; d += 1) {
    if (d > MAX_D) return null;
    trace.push(new Map(v));

    for (let k = -d; k <= d; k += 2) {
      const kMinus = v.get(k - 1);
      const kPlus = v.get(k + 1);
      let x: number;
      if (k === -d || (k !== d && (kMinus ?? -Infinity) < (kPlus ?? -Infinity))) {
        x = kPlus ?? 0;
      } else {
        x = (kMinus ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a, b, n, m);
    }
  }
  return null;
}

/** 顺着 trace 倒着走，还原出 same / add / del 序列 */
function backtrack(
  trace: Map<number, number>[],
  a: string[],
  b: string[],
  n: number,
  m: number,
): DiffOp[] {
  const reversed: DiffOp[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d];
    const k = x - y;

    if (d === 0) {
      // 走到底：剩下的都是公共前缀（裁过前后缀，通常已经没有了）
      while (x > 0 && y > 0) {
        reversed.push({ type: "same", text: a[x - 1] });
        x -= 1;
        y -= 1;
      }
      break;
    }

    const kMinus = v.get(k - 1);
    const kPlus = v.get(k + 1);
    const prevK =
      k === -d || (k !== d && (kMinus ?? -Infinity) < (kPlus ?? -Infinity)) ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    // 先退掉这一段对角线上的相同字
    while (x > prevX && y > prevY) {
      reversed.push({ type: "same", text: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      reversed.push({ type: "add", text: b[y - 1] });
      y -= 1;
    } else {
      reversed.push({ type: "del", text: a[x - 1] });
      x -= 1;
    }
  }

  reversed.reverse();
  const ops: DiffOp[] = [];
  reversed.forEach((op) => pushOp(ops, op.type, op.text));
  return ops;
}
