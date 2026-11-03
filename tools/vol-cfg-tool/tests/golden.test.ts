/**
 * @file    golden.test.ts
 * @brief   以库当前的两份参考文件为黄金基准，验证 presetLibrary() 的生成结果。
 *
 * 判据：
 *   ① 语义级：剥掉注释与空行后，代码行序列必须与参考文件完全一致
 *      （所有宏值、所有断言表达式与 tag、所有 #if 结构都在内）；
 *   ② 原文级：逐行 diff 的每个差异块，只允许"代码部分相同、注释文字不同"
 *      —— 任何缩进、列位、标点偏差都会让代码部分不同，从而被抓出来。
 *
 * 参考 .c 第 125..131 行是"VOL_CHANNEL_NUM > 2 就 #error"的旧限制块，
 * 工具已解除该限制，故意不生成，故比对前先剔除。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { emitFiles } from '../src/core/emit';
import { presetLibrary } from '../src/model/presets';
import { analyze, codeDiffs, codeLines, diffHunks, dropLines, formatHunks, normalizeLine } from './helpers/compare';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const readRef = (rel: string) => readFileSync(REPO_ROOT + rel, 'utf8');

/** #error 的文案允许不同（工具会给出更贴合配置的说明），比对时统一归一 */
function canon(text: string): string {
  return text
    .split('\n')
    .map((l) => (/^\s*#\s*error\b/.test(l) ? '#error' : l))
    .join('\n');
}

describe('库自带示例（golden 基准）', () => {
  const model = presetLibrary();
  const gen = emitFiles(model);

  it('文件以单个 LF 结尾、无 CR（与库文件一致）', () => {
    for (const text of [gen.h, gen.c]) {
      expect(text.includes('\r')).toBe(false);
      expect(text.endsWith('\n')).toBe(true);
      expect(text.endsWith('\n\n')).toBe(false);
    }
  });

  it('vol_cfg.h 的代码行序列与参考文件完全一致', () => {
    const expected = codeLines(readRef('inc/vol_cfg.h'));
    const actual = codeLines(gen.h);
    const hunks = diffHunks(actual, expected);
    expect(hunks.length, `代码行不一致：\n${formatHunks(hunks)}`).toBe(0);
    expect(actual).toEqual(expected);
  });

  it('vol_cfg.c 的代码行序列与参考文件完全一致（已剔除旧的 2 通道限制块）', () => {
    const refC = dropLines(readRef('src/vol_cfg.c'), [[125, 131]]);
    const expected = codeLines(canon(refC));
    const actual = codeLines(canon(gen.c));
    const hunks = diffHunks(actual, expected);
    expect(hunks.length, `代码行不一致：\n${formatHunks(hunks)}`).toBe(0);
    expect(actual).toEqual(expected);
  });

  it('vol_cfg.h 的原文差异只出现在注释上', () => {
    const expected = analyze(readRef('inc/vol_cfg.h'));
    const actual = analyze(gen.h);
    const hunks = diffHunks(actual.raw, expected.raw);
    const bad = codeDiffs(hunks, actual, expected);
    expect(bad.length, `存在非注释差异：\n${bad.slice(0, 10).join('\n')}`).toBe(0);
  });

  it('vol_cfg.c 的原文差异只出现在注释上', () => {
    const expected = analyze(canon(dropLines(readRef('src/vol_cfg.c'), [[125, 131]])));
    const actual = analyze(canon(gen.c));
    const hunks = diffHunks(actual.raw, expected.raw);
    const bad = codeDiffs(hunks, actual, expected);
    expect(bad.length, `存在非注释差异：\n${bad.slice(0, 10).join('\n')}`).toBe(0);
  });

  it('迟滞宏的行尾注释给出实际跳变门限（防方向误读）', () => {
    const h = normalizeLine(gen.h);
    expect(h).toContain('10.0 V 才进正常');
    expect(h).toContain('5.5 V 才掉回严重欠压');
    expect(h).toContain('16.5 V 才进高压');
    expect(h).toContain('15.5 V 才回正常');
  });
});
