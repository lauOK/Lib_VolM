/**
 * @file    compile.test.ts
 * @brief   把生成的 vol_cfg.h / vol_cfg.c 换进库副本，用宿主机 gcc 真编译。
 *
 * 这一步验证的是"生成的文件能编译"这件事本身：
 *   - 不再有"最多 2 通道"与"CH1 状态表未实现"的 #error；
 *   - 全部 c3~c11 断言在 12 状态 / 1 状态 / 多通道配置下都能通过；
 *   - C99（负数组长度断言）与 C11（_Static_assert）两条路径都零告警。
 *
 * 所有中间产物写到系统临时目录，不污染库目录。
 */
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { emitFiles } from '../src/core/emit';
import type { ConfigModel } from '../src/model/types';
import { presetDefault } from '../src/model/presets';
import { modelAllStateful, modelFiveChannels, modelTwelveStates } from './helpers/models';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORK = mkdtempSync(path.join(tmpdir(), 'volcfg-p1-'));

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

/** 把库源码拷进临时工程，并覆盖两份配置文件 */
function prepare(model: ConfigModel, tag: string): string {
  const dir = path.join(WORK, tag);
  cpSync(path.join(REPO_ROOT, 'inc'), path.join(dir, 'inc'), { recursive: true });
  cpSync(path.join(REPO_ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  const { h, c } = emitFiles(model);
  writeFileSync(path.join(dir, 'inc', 'vol_cfg.h'), h, 'utf8');
  writeFileSync(path.join(dir, 'src', 'vol_cfg.c'), c, 'utf8');
  return dir;
}

describe('生成的文件能被 gcc 编译（C99 / C11 两条断言路径）', () => {
  const cases: Array<[string, ConfigModel]> = [
    ['12v', presetDefault()],
    ['five', modelFiveChannels()],
    ['all-stateful', modelAllStateful()],
    ['twelve', modelTwelveStates()],
  ];

  for (const [tag, model] of cases) {
    for (const std of ['c99', 'c11'] as const) {
      it(`${tag} / ${std}：零告警编译通过`, () => {
        const dir = prepare(model, tag);
        const res = spawnSync(
          'gcc',
          [
            `-std=${std}`,
            '-Wall',
            '-Wextra',
            '-Werror',
            '-Iinc',
            '-Isrc',
            '-c',
            ...readdirSync(path.join(dir, 'src'))
              .filter((f) => f.endsWith('.c'))
              .map((f) => path.join('src', f)),
          ],
          { cwd: dir, encoding: 'utf8' },
        );
        expect(res.stderr || '', `${tag}/${std} 编译输出：\n${res.stderr}`).toBe('');
        expect(res.status, `${tag}/${std} 编译失败：\n${res.stderr}`).toBe(0);
      });
    }
  }

  it('状态通道配置不应出现任何 #error', () => {
    const { c } = emitFiles(modelAllStateful());
    expect(c.includes('#error')).toBe(false);
  });

  it('仅测量通道保留一条 #error 守卫（手改成 stateful 时才触发）', () => {
    const { c } = emitFiles(presetDefault());
    expect(c.includes('#error')).toBe(true);
  });
});
