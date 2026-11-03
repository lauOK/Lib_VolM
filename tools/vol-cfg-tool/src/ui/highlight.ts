/**
 * @file    highlight.ts
 * @brief   极简 C / YAML 高亮：把每行切成带类名的片段，交给 React 渲染。
 *
 * 不用 highlight.js / Prism：只为两种固定文件、几百行代码，多一个依赖不值当。
 * 块注释要跨行维持状态，所以按"整文件顺序扫描"而不是逐行独立处理。
 */

export interface Seg {
  text: string;
  cls?: string;
}

const KEYWORDS = new Set([
  'void',
  'const',
  'static',
  'if',
  'else',
  'return',
  'typedef',
  'struct',
  'union',
  'enum',
  'extern',
  'volatile',
  'int',
  'char',
  'unsigned',
  'signed',
  'long',
  'short',
  'sizeof',
  'for',
  'while',
  'switch',
  'case',
  'break',
]);

function classifyWord(w: string): string | undefined {
  if (KEYWORDS.has(w)) return 'kw';
  if (/^[A-Z][A-Z0-9_]{1,}$/.test(w)) return 'mac';
  if (/^\d+$/.test(w)) return 'num';
  if (/^(uint8_t|uint16_t|uint32_t|int16_t|int32_t|uint64_t|int64_t|bool|size_t)$/.test(w)) return 'type';
  return undefined;
}

/** 把普通片段再按"单词"拆开，做宏名/关键字/数字着色 */
function splitPlain(text: string, out: Seg[]): void {
  const re = /[A-Za-z_][A-Za-z0-9_]*|\d+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const w = m[0];
    out.push({ text: w, cls: classifyWord(w) });
    last = m.index + w.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
}

export function highlightC(lines: string[]): Seg[][] {
  let inBlock = false;

  return lines.map((line) => {
    // 预处理指令整行按一类着色，避免 #define 里的宏名把整行染花
    if (!inBlock && /^\s*#/.test(line)) {
      const m = /^(\s*)(#\s*\w+)([\s\S]*)$/.exec(line);
      if (m) {
        const out: Seg[] = [{ text: m[1]! }, { text: m[2]!, cls: 'pp' }];
        splitPlain(m[3]!, out);
        return out;
      }
    }

    const out: Seg[] = [];
    let plain = '';
    let cmt = '';
    let i = 0;

    const flush = (): void => {
      if (plain) {
        splitPlain(plain, out);
        plain = '';
      }
    };
    const flushCmt = (): void => {
      if (cmt) {
        out.push({ text: cmt, cls: 'cmt' });
        cmt = '';
      }
    };

    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) {
          cmt += line.slice(i);
          i = line.length;
        } else {
          cmt += line.slice(i, end + 2);
          i = end + 2;
          inBlock = false;
          flushCmt();
        }
        continue;
      }
      const c = line[i]!;
      const d = line[i + 1];
      if (c === '/' && d === '*') {
        flush();
        inBlock = true;
        cmt = '/*';
        i += 2;
        continue;
      }
      if (c === '/' && d === '/') {
        flush();
        out.push({ text: line.slice(i), cls: 'cmt' });
        i = line.length;
        continue;
      }
      if (c === '"' || c === "'") {
        flush();
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === c) {
            j++;
            break;
          }
          j++;
        }
        out.push({ text: line.slice(i, j), cls: 'str' });
        i = j;
        continue;
      }
      plain += c;
      i++;
    }
    flush();
    flushCmt();
    return out;
  });
}

/** YAML：注释 + 键名 + 数字 */
export function highlightYaml(lines: string[]): Seg[][] {
  return lines.map((line) => {
    const hash = line.indexOf('#');
    const head = hash >= 0 ? line.slice(0, hash) : line;
    const tail = hash >= 0 ? line.slice(hash) : '';
    const out: Seg[] = [];
    const m = /^(\s*(?:- )?)([A-Za-z_][\w-]*)(:)([\s\S]*)$/.exec(head);
    if (m) {
      out.push({ text: m[1]! });
      out.push({ text: m[2]!, cls: 'key' });
      out.push({ text: m[3]! });
      splitPlain(m[4]!, out);
    } else {
      out.push({ text: head });
    }
    if (tail) out.push({ text: tail, cls: 'cmt' });
    return out;
  });
}

export function highlight(kind: 'c' | 'yaml', text: string): Seg[][] {
  const lines = text.split('\n');
  return kind === 'c' ? highlightC(lines) : highlightYaml(lines);
}
