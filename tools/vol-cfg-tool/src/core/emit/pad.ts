/**
 * @file    pad.ts
 * @brief   列位对齐与数值格式化原语。
 *
 * 生成文件要与人手写的参考文件逐字符一致，因此所有"值/注释落在第几列"的规则
 * 都收敛到这里：宏值统一第 41 列，通道宏的行尾注释第 53 列，配置表字段注释第 45 列。
 */

/** 把一行右侧补空格到指定 1-based 列；已经超长时至少补 1 个空格（防止粘连） */
export function padTo(line: string, col: number): string {
  const need = col - 1 - line.length;
  return line + ' '.repeat(need > 0 ? need : 1);
}

/** 生成 `#define NAME  VALUE`，值从第 41 列开始；有注释时注释从第 53 列开始 */
export function def(name: string, value: string | number, comment?: string, commentCol = 53): string {
  const head = padTo(`#define ${name}`, 41) + String(value);
  return comment ? padTo(head, commentCol) + comment : head;
}

/** 电压格式：整数 V 不带小数（6000 → "6"，15800 → "15.8"） */
export function fmtVoltTrim(mv: number): string {
  const v = mv / 1000;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** 门限电压格式：恒一位小数（10000 → "10.0"，5500 → "5.5"） */
export function fmtVolt1(mv: number): string {
  return (mv / 1000).toFixed(1);
}

/** 电阻格式：≥ 1 kΩ 用 kΩ 表示（5100 → "5.1 kΩ"，820 → "820 Ω"） */
export function fmtKohm(ohm: number): string {
  if (ohm >= 1000 && ohm % 100 === 0) {
    const k = ohm / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)} kΩ`;
  }
  return `${ohm} Ω`;
}

/** 由满量程码值推位数（4095 → 12，65535 → 16）；非 2^n-1 返回 null */
export function adcBits(fs: number): number | null {
  const b = Math.log2(fs + 1);
  return Number.isInteger(b) ? b : null;
}

/** 带符号数值（+500 / -10） */
export function signed(v: number): string {
  return v > 0 ? `+${v}` : String(v);
}

/** 生成 ` * ` 开头的块注释行 */
export function starLines(lines: string[]): string[] {
  return lines.map((l) => (l === '' ? ' *' : ` * ${l}`));
}
