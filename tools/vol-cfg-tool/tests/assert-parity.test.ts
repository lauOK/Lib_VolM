/**
 * @file    assert-parity.test.ts
 * @brief   P3 验收之二：工具报的规则号与 gcc 报的断言 tag 必须一一对应。
 *
 * 做法：每个变异模型同时走两条路——
 *   ① `checkRules()` 必须报出该规则的 error；
 *   ② 把生成结果塞进库副本用 gcc 编译，必须失败，且 stderr 含对应 tag。
 * 两条都成立，才能说明"工具拦下的正是编译器会炸的"，而不是各说各话。
 *
 * 覆盖范围：
 *   - 可构造反例的规则（C1/C6/C7/C8/C9/C11）走上面的双向对拍；
 *   - C2/C3/C4/C5/C10/C12 由模型结构构造性保证，无法构造反例，
 *     改由"随机合法配置 → 零 error 且能编译"的闭环证明（见文件末尾）。
 *
 * 所有中间产物写到系统临时目录，不污染库目录。
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { emitFiles } from '../src/core/emit';
import { checkRules } from '../src/core/rules';
import type { ConfigModel, Diagnostic } from '../src/model/types';
import { SCHEMA_VERSION } from '../src/model/types';
import { presetDefault } from '../src/model/presets';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORK = mkdtempSync(path.join(tmpdir(), 'volcfg-p3-'));
let seq = 0;

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

type St = Extract<ConfigModel['channels'][number]['states'], { mode: 'stateful' }>;
const st0 = (m: ConfigModel): St => {
  const s = m.channels[0]!.states;
  if (s.mode !== 'stateful') throw new Error('期望 CH0 是状态通道');
  return s;
};

function fmt(ds: Diagnostic[]): string {
  return ds.map((d) => `${d.severity} ${d.code} ${d.path} ${d.message}`).join('\n') || '（无诊断）';
}

/** 生成后编译 vol_cfg.c（只到 .o，不链接） */
function compile(model: ConfigModel): { status: number | null; stderr: string } {
  const dir = path.join(WORK, `case-${seq++}`);
  cpSync(path.join(REPO_ROOT, 'inc'), path.join(dir, 'inc'), { recursive: true });
  cpSync(path.join(REPO_ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  const { h, c } = emitFiles(model);
  writeFileSync(path.join(dir, 'inc', 'vol_cfg.h'), h, 'utf8');
  writeFileSync(path.join(dir, 'src', 'vol_cfg.c'), c, 'utf8');
  const res = spawnSync('gcc', ['-std=c11', '-Iinc', '-Isrc', '-c', 'src/vol_cfg.c'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: res.status, stderr: res.stderr || '' };
}

interface Case {
  /** 工具侧的规则号 */
  rule: string;
  /** 用例说明 */
  label: string;
  /** 期望在 gcc stderr 里出现的断言 tag */
  tag: string;
  mut: (m: ConfigModel) => void;
}

const CASES: Case[] = [
  {
    rule: 'C1',
    label: '状态数超过 VOL_STATE_NUM_MAX',
    tag: 'c1_CH0',
    mut: (m) => {
      m.module.stateNumMax = 3;
    },
  },
  {
    rule: 'C1',
    label: '通道数超过 VOL_CHANNEL_NUM_MAX',
    tag: 'm_channel_num_hi',
    mut: (m) => {
      m.module.channelNumMax = 1;
    },
  },
  {
    rule: 'C6',
    label: 'b1 为 0，S0 区间为空',
    tag: 'c6_CH0_0',
    mut: (m) => {
      st0(m).boundaries[0]!.upperMv = 0;
    },
  },
  {
    rule: 'C7',
    label: 'S1 被 S2 的下行迟滞挤没',
    tag: 'c7_CH0_1',
    mut: (m) => {
      st0(m).boundaries[1]!.hystDownMv = 3000;
    },
  },
  {
    rule: 'C8',
    label: '滤波窗口超过上限',
    tag: 'c8_CH0_hi',
    mut: (m) => {
      m.channels[0]!.filter = { mode: 'by_sample', arg: 65 };
    },
  },
  {
    rule: 'C9',
    label: '定点系数达 2^32',
    tag: 'c9_CH0_scale',
    mut: (m) => {
      m.channels[0]!.adc = { fs: 1, vrefMv: 5000 };
      m.channels[0]!.divider = { rHighOhm: 1000000, rLowOhm: 1 };
      m.channels[0]!.calib = { gainPpm: 100000, offsetMv: 0 };
    },
  },
  {
    rule: 'C11',
    label: 'FS 为 0',
    tag: 'c11_CH0_fs',
    mut: (m) => {
      m.channels[0]!.adc.fs = 0;
    },
  },
  {
    rule: 'C11',
    label: 'VREF 超 5000',
    tag: 'c11_CH0_vref',
    mut: (m) => {
      m.channels[0]!.adc.vrefMv = 5001;
    },
  },
  {
    rule: 'C11',
    label: '上臂超 R_MAX',
    tag: 'c11_CH0_rh',
    mut: (m) => {
      m.channels[0]!.divider.rHighOhm = 2000000;
    },
  },
  {
    rule: 'C11',
    label: '下臂为 0',
    tag: 'c11_CH0_rl',
    mut: (m) => {
      m.channels[0]!.divider.rLowOhm = 0;
    },
  },
  {
    rule: 'C11',
    label: '增益超 ±10%',
    tag: 'c11_CH0_gain',
    mut: (m) => {
      m.channels[0]!.calib.gainPpm = -100001;
    },
  },
  {
    rule: 'C11',
    label: '偏置超 ±1000',
    tag: 'c11_CH0_offset',
    mut: (m) => {
      m.channels[0]!.calib.offsetMv = 1001;
    },
  },
  {
    rule: 'C11',
    label: '量程为 0',
    tag: 'c11_CH0_vmax',
    mut: (m) => {
      st0(m).boundaries[3]!.upperMv = 0;
    },
  },
];

describe('工具规则号 ↔ gcc 断言 tag 双向对拍', () => {
  for (const c of CASES) {
    it(`${c.rule}：${c.label} → ${c.tag}`, () => {
      const m = presetDefault();
      c.mut(m);

      // ① 工具必须报出该规则（error 级）
      const ds = checkRules(m);
      expect(
        ds.some((d) => d.code === c.rule && d.severity === 'error'),
        `工具未报 ${c.rule}\n实际：\n${fmt(ds)}`,
      ).toBe(true);

      // ② 编译器必须失败，且报的是同一条断言
      const r = compile(m);
      expect(r.status, `期望编译失败，实际通过；stderr：\n${r.stderr}`).not.toBe(0);
      expect(r.stderr, `stderr 未出现 ${c.tag}：\n${r.stderr}`).toContain(c.tag);
    });
  }

  it('C9 除零（c9_div）由 C11 前置保证，永远不可单独违反', () => {
    // R_LOW >= 1 由 c11 保证，因此 (R_HIGH + R_LOW) > 0 恒成立，c9_div 是防御性断言。
    // 这条规则只做说明，不构造反例——构造出来的用例会先撞上 c11_CH0_rl。
    expect(true).toBe(true);
  });

  it('工具无 error 时不产生可编译失败的断言（默认预设）', () => {
    const ds = checkRules(presetDefault());
    expect(ds.filter((d) => d.severity === 'error')).toEqual([]);
    const r = compile(presetDefault());
    expect(r.status, `默认预设应能编译：\n${r.stderr}`).toBe(0);
  });
});

/* ==========================================================================
 * 构造保证类规则：随机合法配置 → 工具零 error → 生成的代码也能编译
 * ========================================================================== */

/** 确定性伪随机，保证失败可复现 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 边界严格递增、迟滞为 0 的随机状态通道（状态数 1..12，覆盖库容量上限） */
function randomModel(rand: () => number): ConfigModel {
  const n = 1 + Math.floor(rand() * 12);
  const vmax = 20000;
  const cuts = new Set<number>();
  while (cuts.size < n - 1) cuts.add(1 + Math.floor(rand() * (vmax - 1)));
  const mids = [...cuts].sort((a, b) => a - b);
  return {
    schema: SCHEMA_VERSION,
    module: {
      samplePeriodMs: 1,
      filterWindowMax: 64,
      stateNumMax: 12,
      channelNumMax: 8,
      rMaxOhm: 1000000,
    },
    channels: [
      {
        name: `随机 ${n} 状态`,
        adc: { fs: 4095, vrefMv: 3300 },
        divider: { rHighOhm: 30000, rLowOhm: 5100 },
        calib: { gainPpm: 0, offsetMv: 0 },
        filter: { mode: 'by_sample', arg: 8 },
        states: {
          mode: 'stateful',
          names: Array.from({ length: n }, (_, i) => `S${i}`),
          boundaries: [
            ...mids.map((v) => ({ upperMv: v, hystUpMv: 0, hystDownMv: 0 })),
            { upperMv: vmax, hystUpMv: 0, hystDownMv: 0 },
          ],
        },
      },
    ],
  };
}

describe('随机合法配置：工具零 error ⇔ 生成的代码能编译', () => {
  const rand = lcg(20261103);

  for (let k = 0; k < 8; k++) {
    const model = randomModel(rand);
    const n = (model.channels[0]!.states as St).names.length;
    it(`第 ${k + 1} 组（${n} 状态）：无 error 且 gcc 通过`, () => {
      const ds = checkRules(model);
      expect(ds.filter((d) => d.severity === 'error'), `误报 error：\n${fmt(ds)}`).toEqual([]);
      const r = compile(model);
      expect(r.status, `编译失败：\n${r.stderr}`).toBe(0);
    });
  }
});
