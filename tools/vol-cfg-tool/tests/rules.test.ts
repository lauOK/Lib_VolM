/**
 * @file    rules.test.ts
 * @brief   P3 验收之一：C1~C11 / W1~W8 每条规则至少一个变异用例。
 *
 * 判据不是"报错了就行"，而是"报出**这一条**规则号、级别正确、字段路径能定位到要改的那一格"。
 * 默认预设另有一条精确断言（零 error + 只有一条已知 warning），用来防止规则误报——
 * 告警泛滥比漏报更容易让人关掉整个工具。
 */
import { describe, expect, it } from 'vitest';

import { checkRules } from '../src/core/rules';
import type { ConfigModel, Diagnostic } from '../src/model/types';
import { presetDefault } from '../src/model/presets';
import { modelTwelveStates } from './helpers/models';

type St = Extract<ConfigModel['channels'][number]['states'], { mode: 'stateful' }>;

/** 取 CH0 的状态配置（默认预设的 CH0 一定是状态通道） */
function st0(m: ConfigModel): St {
  const s = m.channels[0]!.states;
  if (s.mode !== 'stateful') throw new Error('期望 CH0 是状态通道');
  return s;
}

function fmt(ds: Diagnostic[]): string {
  return ds.map((d) => `${d.severity} ${d.code} ${d.path || '<顶层>'} ${d.message}`).join('\n') || '（无诊断）';
}

/** 断言报出了指定规则，并返回它 */
function expectRule(m: ConfigModel, code: string, severity: 'error' | 'warning' = 'error'): Diagnostic {
  const ds = checkRules(m);
  const hit = ds.find((d) => d.code === code && d.severity === severity);
  expect(hit, `未报出 ${severity} ${code}\n实际：\n${fmt(ds)}`).toBeDefined();
  return hit!;
}

/** 断言该规则的字段路径以某前缀开头（能定位到具体的输入框） */
function expectPath(m: ConfigModel, code: string, pathPrefix: string, severity: 'error' | 'warning' = 'error'): void {
  const hit = expectRule(m, code, severity);
  expect(hit.path.startsWith(pathPrefix), `${code} 的路径是 ${hit.path}，期望以 ${pathPrefix} 开头`).toBe(true);
}

describe('基线：默认预设', () => {
  it('零 error、零 warning（新装即干净，多出任何一条都是误报）', () => {
    const ds = checkRules(presetDefault());
    expect(ds, fmt(ds)).toEqual([]);
  });
});

describe('C1 容量', () => {
  it('状态数超过 VOL_STATE_NUM_MAX', () => {
    const m = presetDefault();
    m.module.stateNumMax = 3;
    expectPath(m, 'C1', 'channels[0].states.names');
  });

  it('通道数超过 VOL_CHANNEL_NUM_MAX', () => {
    const m = presetDefault();
    m.module.channelNumMax = 1;
    expectPath(m, 'C1', 'channels');
  });

  it('12 状态（库容量上限）合法：0 error 0 warning', () => {
    const ds = checkRules(modelTwelveStates());
    expect(ds, fmt(ds)).toEqual([]);
  });

  it('13 状态越过库上限 → C1', () => {
    const m = modelTwelveStates();
    const s = st0(m);
    s.names.push('超量程');
    s.boundaries.splice(
      11,
      1,
      { upperMv: 17300, hystUpMv: 200, hystDownMv: 200 },
      { upperMv: 18000, hystUpMv: 0, hystDownMv: 0 },
    );
    expectPath(m, 'C1', 'channels[0].states');
  });

  it('状态数上限填 13 本身就被拒（F5，库断言 m_state_num_max）', () => {
    const m = presetDefault();
    m.module.stateNumMax = 13;
    expectPath(m, 'F5', 'module.state_num_max', 'error');
  });
});

describe('C3 / C4 / C5 / C10：由"边界中心"模型构造性保证，任何输入都不该触发', () => {
  const variants: Array<[string, (m: ConfigModel) => void]> = [
    ['边界倒挂', (m) => { st0(m).boundaries[1]!.upperMv = 100; }],
    ['边界相等', (m) => { st0(m).boundaries[1]!.upperMv = st0(m).boundaries[0]!.upperMv; }],
    ['量程极小', (m) => { st0(m).boundaries[3]!.upperMv = 1; }],
    ['迟滞巨大', (m) => { st0(m).boundaries[0]!.hystUpMv = 99999; }],
  ];

  for (const [label, mut] of variants) {
    it(`${label}：不报 C3/C4/C5/C10（应由 C6/C7 接住）`, () => {
      const m = presetDefault();
      mut(m);
      const codes = new Set(checkRules(m).map((d) => d.code));
      for (const c of ['C3', 'C4', 'C5', 'C10']) {
        expect(codes.has(c), `${label} 不应触发 ${c}，实际：\n${fmt(checkRules(m))}`).toBe(false);
      }
    });
  }
});

describe('C6 区间非退化', () => {
  it('b2 等于 b1 → S1 区间为空', () => {
    const m = presetDefault();
    st0(m).boundaries[1]!.upperMv = st0(m).boundaries[0]!.upperMv;
    expectPath(m, 'C6', 'channels[0].states.boundaries[1].upper_mv');
  });

  it('b1 为 0 → S0 区间为空', () => {
    const m = presetDefault();
    st0(m).boundaries[0]!.upperMv = 0;
    expectPath(m, 'C6', 'channels[0].states.boundaries[0].upper_mv');
  });
});

describe('C7 迟滞不越界', () => {
  it('S1 被 S2 的下行迟滞挤没（S1 = [6000,9000) 宽 3000）', () => {
    const m = presetDefault();
    st0(m).boundaries[1]!.hystDownMv = 3000; // S2 的下行迟滞存在 b2 上
    expectPath(m, 'C7', 'channels[0].states.boundaries[1].hyst_down_mv');
  });

  it('S2 被两侧迟滞一起挤没（S2 = [9000,16000) 宽 7000）', () => {
    const m = presetDefault();
    st0(m).boundaries[0]!.hystUpMv = 4000; // S1 上行，存在 b1 上
    st0(m).boundaries[2]!.hystDownMv = 4000; // S3 下行，存在 b3 上（不是 b4）
    const ds = checkRules(m).filter((d) => d.code === 'C7');
    expect(ds.some((d) => d.message.includes('S2')), `C7 未命中 S2：\n${fmt(ds)}`).toBe(true);
  });

  it('末状态之外的那条边界写迟滞不影响判定（b4 没有迟滞）', () => {
    const m = presetDefault();
    st0(m).boundaries[3]!.hystDownMv = 9999; // 量程端点，C7 不该因此报错
    expect(checkRules(m).filter((d) => d.code === 'C7')).toEqual([]);
  });
});

describe('C8 滤波窗口', () => {
  it('窗口为 0', () => {
    const m = presetDefault();
    m.channels[0]!.filter = { mode: 'by_sample', arg: 0 };
    expectPath(m, 'C8', 'channels[0].filter.arg');
  });

  it('窗口超过 VOL_FILTER_WINDOW_MAX', () => {
    const m = presetDefault();
    m.channels[0]!.filter = { mode: 'by_sample', arg: 65 };
    expectPath(m, 'C8', 'channels[0].filter.arg');
  });

  it('时间模式换算后超限（650 ms ÷ 10 ms = 65 点 > 窗口上限 64）', () => {
    const m = presetDefault();
    m.channels[0]!.filter = { mode: 'by_time', arg: 650 };
    expectPath(m, 'C8', 'channels[0].filter.arg');
  });
});

describe('C9 除零与系数截断', () => {
  it('上下臂同时为 0', () => {
    const m = presetDefault();
    m.channels[0]!.divider = { rHighOhm: 0, rLowOhm: 0 };
    expectPath(m, 'C9', 'channels[0].divider');
  });

  it('系数达 2^32（FS 极小 + 分压极大）', () => {
    const m = presetDefault();
    m.channels[0]!.adc = { fs: 1, vrefMv: 5000 };
    m.channels[0]!.divider = { rHighOhm: 1000000, rLowOhm: 1 };
    m.channels[0]!.calib = { gainPpm: 100000, offsetMv: 0 };
    expectPath(m, 'C9', 'channels[0]');
  });
});

describe('C11 配置量闭区间', () => {
  const cases: Array<[string, (m: ConfigModel) => void, string]> = [
    ['FS 为 0', (m) => { m.channels[0]!.adc.fs = 0; }, 'channels[0].adc.fs'],
    ['VREF 超 5000', (m) => { m.channels[0]!.adc.vrefMv = 5001; }, 'channels[0].adc.vref_mv'],
    ['上臂超 R_MAX', (m) => { m.channels[0]!.divider.rHighOhm = 2000000; }, 'channels[0].divider.r_high_ohm'],
    ['下臂为 0', (m) => { m.channels[0]!.divider.rLowOhm = 0; }, 'channels[0].divider.r_low_ohm'],
    ['增益超 ±10%', (m) => { m.channels[0]!.calib.gainPpm = -100001; }, 'channels[0].calib.gain_ppm'],
    ['偏置超 ±1000', (m) => { m.channels[0]!.calib.offsetMv = 1001; }, 'channels[0].calib.offset_mv'],
    ['量程为 0', (m) => { st0(m).boundaries[3]!.upperMv = 0; }, 'channels[0].states.boundaries'],
  ];

  for (const [label, mut, path] of cases) {
    it(label, () => {
      const m = presetDefault();
      mut(m);
      expectPath(m, 'C11', path);
    });
  }

  it('measure_only 通道的量程路径指向 voltage_max_mv', () => {
    const m = presetDefault();
    m.channels[1]!.voltageMaxMv = 0;
    expectPath(m, 'C11', 'channels[1].voltage_max_mv');
  });
});

describe('W1~W8 工程建议', () => {
  it('W1 量程高于分压满量程（10 kΩ/2 kΩ + 5 V 参考 → 满量程 30 V）', () => {
    const m = presetDefault();
    st0(m).boundaries[3]!.upperMv = 40000; // 40 V > 30 V，ADC 早已饱和
    expectPath(m, 'W1', 'channels[0].states.boundaries', 'warning');
  });

  it('W2 迟滞过薄', () => {
    const m = presetDefault();
    st0(m).boundaries[0]!.hystDownMv = 30;
    expectPath(m, 'W2', 'channels[0].states.boundaries[0].hyst_down_mv', 'warning');
  });

  it('W3 建立时间过长', () => {
    const m = presetDefault();
    m.module.samplePeriodMs = 100; // 64 点 × 100 ms = 6400 ms
    m.channels[0]!.filter = { mode: 'by_sample', arg: 64 };
    m.channels[1]!.filter = { mode: 'by_sample', arg: 8 };
    expectPath(m, 'W3', 'channels[0].filter.arg', 'warning');
  });

  it('W4 分辨率过粗', () => {
    const m = presetDefault();
    m.channels[0]!.divider = { rHighOhm: 30000, rLowOhm: 51 };
    expectPath(m, 'W4', 'channels[0].divider', 'warning');
  });

  it('W5 状态名重复', () => {
    const m = presetDefault();
    st0(m).names[1] = st0(m).names[0]!;
    expectPath(m, 'W5', 'channels[0].states.names[1]', 'warning');
  });

  it('W6 偏置绝对值过大', () => {
    const m = presetDefault();
    m.channels[0]!.calib.offsetMv = -150;
    expectPath(m, 'W6', 'channels[0].calib.offset_mv', 'warning');
  });

  it('W7 时间模式非整周期', () => {
    const m = presetDefault();
    m.module.samplePeriodMs = 2;
    m.channels[0]!.filter = { mode: 'by_time', arg: 9 };
    expectPath(m, 'W7', 'channels[0].filter.arg', 'warning');
  });

  it('W8 上臂为 0（直连）', () => {
    const m = presetDefault();
    m.channels[0]!.divider = { rHighOhm: 0, rLowOhm: 5100 };
    expectPath(m, 'W8', 'channels[0].divider.r_high_ohm', 'warning');
  });
});

describe('警告不阻止生成', () => {
  it('只有 warning 时，诊断里没有任何 error', () => {
    const m = presetDefault();
    m.channels[0]!.calib.offsetMv = -150; // 触发 W6（偏置绝对值过大）
    const ds = checkRules(m);
    expect(ds.length, fmt(ds)).toBeGreaterThan(0);
    expect(ds.every((d) => d.severity === 'warning'), fmt(ds)).toBe(true);
  });
});
