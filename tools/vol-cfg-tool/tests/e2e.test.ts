/**
 * @file    e2e.test.ts
 * @brief   P5 端到端验收：生成物换进真实库副本，按库自己的构建流程跑一遍。
 *
 * 默认跳过（要拷库 + 起 gcc + bash，约 3~5 s），用 `npm run e2e` 或
 * `VOLCFG_E2E=1 npx vitest run tests/e2e.test.ts` 打开。
 *
 * 两条互补的路径，缺一不可：
 *
 *   A. 等价性 —— 用 presetLibrary() 生成的两份文件覆盖库原件，跑 `bash UnitTest/build.sh`。
 *      库自带的 test_cfg / test_calc / test_sm 全部写死了原件配置的期望值
 *      （363593728、S2=[9000,16000)、CH1 量程 44000…），所以**只有**生成物与原件
 *      完全等价时这套用例才会全绿。跑通即证明"生成器能完整替代手写文件"。
 *
 *   B. 换配置 —— 用板上真实参数（presetDefault）、5 通道混合、12 状态三种配置覆盖，
 *      gcc 编译全部源文件，再用探针程序把 Vol_ChannelCfgTable 打印成 JSON，
 *      与工具侧派生值逐项比对。库的单元测试在 B 里跑不了（它们认的是旧配置的数值），
 *      所以改用探针——探针校验的是另一件事：**配置表与工具显示的值一致**。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { emitFiles } from '../src/core/emit';
import { filterWindow, offsetUv, scaleQ16 } from '../src/core/scale';
import {
  hystDownOf,
  hystUpOf,
  stateCount,
  stateRange,
  voltageMaxMvOf,
  type ChannelCfg,
  type ConfigModel,
} from '../src/model/types';
import { presetDefault, presetLibrary } from '../src/model/presets';
import { modelFiveChannels, modelTwelveStates } from './helpers/models';

/** npm run e2e 会把 npm_lifecycle_event 设成 e2e，免装 cross-env */
const ENABLED = process.env['VOLCFG_E2E'] === '1' || process.env['npm_lifecycle_event'] === 'e2e';
const describeE2E = ENABLED ? describe : describe.skip;

/** Lib_VolM/Lib_VolM（库根，含 inc / src / UnitTest） */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORK = mkdtempSync(path.join(tmpdir(), 'volcfg-e2e-'));

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

/**
 * 把库拷进临时目录并覆盖两份配置。
 *
 * 只拷 inc / src / UnitTest —— 整树拷会把 tools/node_modules 几百 MB 拖进来。
 */
function prepare(model: ConfigModel, tag: string): string {
  const dir = path.join(WORK, tag);
  for (const sub of ['inc', 'src', 'UnitTest']) {
    cpSync(path.join(REPO_ROOT, sub), path.join(dir, sub), { recursive: true });
  }
  rmSync(path.join(dir, 'UnitTest', 'build'), { recursive: true, force: true });

  const { h, c } = emitFiles(model);
  writeFileSync(path.join(dir, 'inc', 'vol_cfg.h'), h, 'utf8');
  writeFileSync(path.join(dir, 'src', 'vol_cfg.c'), c, 'utf8');
  return dir;
}

/* ==========================================================================
 * A. 等价性：生成物替代手写原件，跑库自带的整套单元测试
 * ========================================================================== */

describeE2E('A. 生成物替代手写原件：库自带 UnitTest 全部通过', () => {
  it('bash UnitTest/build.sh 全绿（C11 编译检查 + C99 五个用例）', () => {
    const dir = prepare(presetLibrary(), 'a-lib');

    const res = spawnSync('bash', [path.join(dir, 'UnitTest', 'build.sh')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
    });

    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(res.status, `build.sh 失败：\n${out}`).toBe(0);

    // 逐条确认五个用例都真的跑过，而不是"一个都没跑却退出 0"。
    // 各用例的收尾标记格式不统一（这是库里的既有事实，不是本工具能改的）：
    // test_api / test_filter / test_sm 打 "== name: 全部通过 =="，
    // test_calc / test_cfg 打 "P1 换算用例通过（失败 0 项）" / "P0 自检通过（失败 0 项）"。
    const passed: Array<[string, RegExp]> = [
      ['test_api', /== test_api: 全部通过 ==/],
      ['test_calc', /P1 换算用例通过（失败 0 项）/],
      ['test_cfg', /P0 自检通过（失败 0 项）/],
      ['test_filter', /== test_filter: 全部通过 ==/],
      ['test_sm', /== test_sm: 全部通过 ==/],
    ];
    for (const [name, mark] of passed) {
      expect(out, `没看到 ${name} 的运行输出`).toContain(`-> ${name}`);
      expect(out, `${name} 没打印通过标记`).toMatch(mark);
    }
    expect(out).toContain('全部用例通过');
  }, 180_000);
});

/* ==========================================================================
 * B. 换配置：编译 + 探针把配置表打印出来逐项比对
 * ========================================================================== */

/** 探针源码：把 Vol_ChannelCfgTable 整个打成一行 JSON，供 Node 侧逐项比对 */
const PROBE_C = `/* 由 tests/e2e.test.ts 生成：打印编译期配置表，供工具侧比对 */
#include <stdio.h>

#include "vol_cfg.h"

int main(void)
{
    unsigned ch;
    unsigned s;

    printf("{\\"state_num_max\\":%u,\\"channel_num\\":%u,\\"channels\\":[",
           (unsigned)VOL_STATE_NUM_MAX, (unsigned)VOL_CHANNEL_NUM);
    for (ch = 0u; ch < (unsigned)VOL_CHANNEL_NUM; ch++)
    {
        const Vol_ChannelCfgType *c = &Vol_ChannelCfgTable[ch];
        if (ch != 0u) { printf(","); }
        printf("{\\"scale_q16\\":%lu,\\"offset_uv\\":%ld,\\"voltage_max_mv\\":%u,"
               "\\"window\\":%u,\\"state_num\\":%u,\\"states\\":[",
               (unsigned long)c->scale_q16, (long)c->offset_uv,
               (unsigned)c->voltage_max_mv, (unsigned)c->window, (unsigned)c->state_num);
        for (s = 0u; s < (unsigned)c->state_num; s++)
        {
            const Vol_StateCfgType *st = &c->state_cfg[s];
            if (s != 0u) { printf(","); }
            printf("{\\"lower\\":%u,\\"upper\\":%u,\\"up\\":%u,\\"down\\":%u}",
                   (unsigned)st->lower_mv, (unsigned)st->upper_mv,
                   (unsigned)st->hyst_up_mv, (unsigned)st->hyst_down_mv);
        }
        printf("]}");
    }
    printf("]}\\n");
    return 0;
}
`;

interface ProbeChannel {
  scale_q16: number;
  offset_uv: number;
  voltage_max_mv: number;
  window: number;
  state_num: number;
  states: Array<{ lower: number; upper: number; up: number; down: number }>;
}

interface ProbeOut {
  state_num_max: number;
  channel_num: number;
  channels: ProbeChannel[];
}

/** 工具侧期望值：与界面、YAML、C 文件同源（都走 model 的访问器与 scale.ts） */
function expected(model: ConfigModel): ProbeOut {
  return {
    state_num_max: model.module.stateNumMax,
    channel_num: model.channels.length,
    channels: model.channels.map((ch: ChannelCfg) => ({
      scale_q16: scaleQ16(ch.adc, ch.divider, ch.calib),
      offset_uv: offsetUv(ch.calib),
      voltage_max_mv: voltageMaxMvOf(ch),
      window: filterWindow(ch.filter, model.module.samplePeriodMs),
      state_num: stateCount(ch),
      states: Array.from({ length: stateCount(ch) }, (_, i) => {
        const r = stateRange(ch, i)!;
        return { lower: r.lowerMv, upper: r.upperMv, up: hystUpOf(ch, i), down: hystDownOf(ch, i) };
      }),
    })),
  };
}

const CASES: Array<[string, () => ConfigModel]> = [
  ['b-default', presetDefault],
  ['b-five', modelFiveChannels],
  ['b-twelve', modelTwelveStates],
];

describeE2E('B. 换配置后：库可编译，且配置表与工具派生值逐项一致', () => {
  for (const [tag, make] of CASES) {
    it(`${tag}：C99/C11 零告警编译 + 探针比对`, () => {
      const model = make();
      const dir = prepare(model, tag);
      const sources = readdirSync(path.join(dir, 'src'))
        .filter((f) => f.endsWith('.c'))
        .map((f) => path.join('src', f));

      // B1. 两个标准各编译一遍（断言在 C99 走负数组长度、C11 走 _Static_assert）
      for (const std of ['c99', 'c11']) {
        const res = spawnSync(
          'gcc',
          [`-std=${std}`, '-Wall', '-Wextra', '-Werror', '-Iinc', '-Isrc', '-c', ...sources],
          { cwd: dir, encoding: 'utf8' },
        );
        expect(res.status, `${tag}/${std} 编译失败：\n${res.stderr}`).toBe(0);
        expect(res.stderr.trim(), `${tag}/${std} 有告警：\n${res.stderr}`).toBe('');
      }

      // B2. 编探针并运行
      writeFileSync(path.join(dir, 'probe.c'), PROBE_C, 'utf8');
      const build = spawnSync(
        'gcc',
        ['-std=c99', '-Wall', '-Wextra', '-Werror', '-Iinc', '-Isrc', 'probe.c', ...sources, '-o', 'probe'],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(build.status, `${tag} 探针编译失败：\n${build.stderr}`).toBe(0);

      const run = spawnSync(path.join(dir, 'probe.exe'), [], { cwd: dir, encoding: 'utf8' });
      expect(run.status, `${tag} 探针运行失败：\n${run.stderr}`).toBe(0);

      const actual = JSON.parse(run.stdout) as ProbeOut;
      const want = expected(model);

      // 逐通道、逐状态比较；失败信息给出"第几通道第几个状态哪个字段"
      expect(actual.state_num_max, 'VOL_STATE_NUM_MAX').toBe(want.state_num_max);
      expect(actual.channel_num, 'VOL_CHANNEL_NUM').toBe(want.channel_num);
      expect(actual.channels.length).toBe(want.channels.length);

      for (let ci = 0; ci < want.channels.length; ci++) {
        const a = actual.channels[ci]!;
        const w = want.channels[ci]!;
        const where = `CH${ci}`;
        expect(a.scale_q16, `${where} scale_q16`).toBe(w.scale_q16);
        expect(a.offset_uv, `${where} offset_uv`).toBe(w.offset_uv);
        expect(a.voltage_max_mv, `${where} voltage_max_mv`).toBe(w.voltage_max_mv);
        expect(a.window, `${where} window`).toBe(w.window);
        expect(a.state_num, `${where} state_num`).toBe(w.state_num);
        expect(a.states.length, `${where} 状态表条数`).toBe(w.states.length);

        for (let si = 0; si < w.states.length; si++) {
          const as = a.states[si]!;
          const ws = w.states[si]!;
          const at = `${where} S${si}`;
          expect(as.lower, `${at} lower`).toBe(ws.lower);
          expect(as.upper, `${at} upper`).toBe(ws.upper);
          expect(as.up, `${at} hyst_up`).toBe(ws.up);
          expect(as.down, `${at} hyst_down`).toBe(ws.down);
        }
      }
    }, 120_000);
  }
});
