/**
 * @file    compare.ts
 * @brief   生成结果与手写参考文件的比对工具（测试专用）。
 *
 * 两级判据：
 *   1) 语义级：剥掉注释与空行后的代码行序列必须完全一致（含所有宏值与断言 tag）；
 *   2) 原文级：逐行 diff 的每个差异块，只允许"代码部分相同、注释部分不同"
 *      —— 任何代码 token、缩进/列位偏差都会被抓出来。
 *
 * 注意：块注释跨多行，因此"某行有没有代码"必须整文件扫描后按行取，
 *       不能对差异块的片段单独跑状态机（会把注释中间的行误判成代码）。
 */

/** 去掉块注释与 // 行注释（保留换行，保持行号对应） */
export function stripComments(text: string): string {
  let out = '';
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      } else if (ch === '\n') {
        out += '\n';
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 归一化：压缩连续空白、去首尾空白 */
export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

export interface Analysis {
  /** 原始行 */
  raw: string[];
  /** 每行剥掉注释后的代码部分（注释行为空串），与 raw 同长度同下标 */
  code: string[];
}

export function analyze(text: string): Analysis {
  return { raw: text.split('\n'), code: stripComments(text).split('\n') };
}

/** 代码行序列：每行代码部分归一化后去掉空行 */
export function codeLines(text: string): string[] {
  return stripComments(text)
    .split('\n')
    .map(normalizeLine)
    .filter((l) => l !== '');
}

/** 删除 1-based 闭区间行（用于剔除"已知且有意"的差异块） */
export function dropLines(text: string, ranges: Array<[number, number]>): string {
  const lines = text.split('\n');
  const drop = new Set<number>();
  for (const [from, to] of ranges) for (let i = from; i <= to; i++) drop.add(i);
  return lines.filter((_, idx) => !drop.has(idx + 1)).join('\n');
}

export interface DiffHunk {
  /** 参考侧被删除的行（行号 + 原文） */
  removed: Array<{ no: number; text: string }>;
  /** 生成侧新增的行 */
  added: Array<{ no: number; text: string }>;
}

/** 行级 LCS diff，返回连续差异块 */
export function diffHunks(actual: string[], expected: string[]): DiffHunk[] {
  const n = actual.length;
  const m = expected.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        actual[i] === expected[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  const start = () => {
    cur = { removed: [], added: [] };
    hunks.push(cur);
    return cur;
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (actual[i] === expected[j]) {
      cur = null;
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      (cur ?? start()).added.push({ no: i + 1, text: actual[i]! });
      i++;
    } else {
      (cur ?? start()).removed.push({ no: j + 1, text: expected[j]! });
      j++;
    }
  }
  while (i < n) {
    (cur ?? start()).added.push({ no: i + 1, text: actual[i]! });
    i++;
  }
  while (j < m) {
    (cur ?? start()).removed.push({ no: j + 1, text: expected[j]! });
    j++;
  }
  return hunks;
}

/**
 * 差异块是否"只改了注释"：两侧涉及行的代码部分完全相同。
 * 这样"值不动、只改行尾说明"算允许；值/缩进/列位/标点的变化一律不许。
 */
export function hunkIsCommentOnly(h: DiffHunk, actual: Analysis, expected: Analysis): boolean {
  const pick = (lines: Array<{ no: number }>, src: Analysis) =>
    lines
      .map((l) => normalizeLine(src.code[l.no - 1] ?? ''))
      .filter((l) => l !== '');
  const a = pick(h.added, actual);
  const r = pick(h.removed, expected);
  return a.length === r.length && a.every((x, i) => x === r[i]);
}

/** 找出"不允许的差异块"并渲染成可读报告 */
export function codeDiffs(hunks: DiffHunk[], actual: Analysis, expected: Analysis): string[] {
  return hunks.filter((h) => !hunkIsCommentOnly(h, actual, expected)).map((h) => {
    const minus = h.removed.map((l) => `  - [参考 ${l.no}] ${l.text}`).join('\n');
    const plus = h.added.map((l) => `  + [生成 ${l.no}] ${l.text}`).join('\n');
    return [minus, plus].filter(Boolean).join('\n');
  });
}

/** 把差异块渲染成便于阅读的报告 */
export function formatHunks(hunks: DiffHunk[], maxHunks = 20): string {
  return hunks
    .slice(0, maxHunks)
    .map((h) => {
      const minus = h.removed.map((l) => `  - [参考 ${l.no}] ${l.text}`).join('\n');
      const plus = h.added.map((l) => `  + [生成 ${l.no}] ${l.text}`).join('\n');
      return [minus, plus].filter(Boolean).join('\n');
    })
    .join('\n');
}
