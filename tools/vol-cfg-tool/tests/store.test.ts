/**
 * @file    store.test.ts
 * @brief   UI 状态操作的回归：状态增删必须维持 names ↔ boundaries 的 n ↔ n 关系，
 *          模式切换必须搬运量程。这些操作走错一步，C4/C5 就会炸。
 */
import { describe, expect, it } from 'vitest';

import { emitConfigYaml, parseConfigText } from '../src/core/cfgfile';
import { checkRules } from '../src/core/rules';
import { presetDefault } from '../src/model/presets';
import { SCHEMA_VERSION } from '../src/model/types';
import type { ConfigModel, StatefulStates } from '../src/model/types';
import { voltageMaxMvOf } from '../src/model/types';
import { initModel, reducer } from '../src/ui/store';

function states(m: ConfigModel, i = 0): StatefulStates {
  const st = m.channels[i]!.states;
  if (st.mode !== 'stateful') throw new Error('期望 stateful');
  return st;
}

function expectValid(m: ConfigModel): void {
  // ① 业务规则零 error（默认预设本就 0 error，操作后不允许引入新的）
  const errs = checkRules(m).filter((d) => d.severity === 'error');
  expect(errs, errs.map((d) => `${d.code} ${d.path}`).join('\n')).toEqual([]);
  // ② 模型能无损走一遍 YAML
  const r = parseConfigText(emitConfigYaml(m));
  expect(r.ok).toBe(true);
}

describe('addState：在最高档之上追加', () => {
  it('4 → 5 状态：原量程端点变成内部边界，量程上抬 10%', () => {
    let m = reducer(presetDefault(), { type: 'addState', index: 0 });
    const st = states(m);
    expect(st.names).toHaveLength(5);
    expect(st.boundaries).toHaveLength(5);
    expect(st.boundaries[3]!.upperMv).toBe(20000); // 原 b4 变 b4 内部边界
    expect(st.boundaries[4]!.upperMv).toBe(22000); // 新量程 = 20000 + 10%
    expect(voltageMaxMvOf(m.channels[0]!)).toBe(22000);
    expectValid(m);
  });

  it('1 → 2 状态（单状态通道也能加）', () => {
    let m = reducer(presetDefault(), { type: 'removeState', index: 0, k: 3 });
    m = reducer(m, { type: 'removeState', index: 0, k: 2 });
    m = reducer(m, { type: 'removeState', index: 0, k: 1 });
    expect(states(m).names).toHaveLength(1);
    m = reducer(m, { type: 'addState', index: 0 });
    const st = states(m);
    expect(st.names).toHaveLength(2);
    expect(st.boundaries).toHaveLength(2);
    // 一路删到 1 状态后量程只剩 b1 = 6000；追加后新量程 = 6000 + 10%
    expect(st.boundaries[0]!.upperMv).toBe(6000);
    expect(st.boundaries[1]!.upperMv).toBe(6600);
    expectValid(m);
  });
});

describe('removeState：删末状态 / 删中间状态', () => {
  it('删末状态：b_{n-1} 顶上成为量程端点，迟滞清零（C10）', () => {
    const m = reducer(presetDefault(), { type: 'removeState', index: 0, k: 3 });
    const st = states(m);
    expect(st.names).toEqual(['严重欠压 / 断线', '低压', '正常']);
    expect(st.boundaries).toHaveLength(3);
    expect(st.boundaries[2]!.upperMv).toBe(16000);
    expect(st.boundaries[2]!.hystUpMv).toBe(0);
    expect(st.boundaries[2]!.hystDownMv).toBe(0);
    expectValid(m);
  });

  it('删中间状态：相邻状态合并，边界数随状态数同步减一', () => {
    const m = reducer(presetDefault(), { type: 'removeState', index: 0, k: 1 });
    const st = states(m);
    expect(st.names).toEqual(['严重欠压 / 断线', '正常', '高压']);
    // 删掉的是 b2(9000)，新 S1「正常」= [6000, 16000)
    expect(st.boundaries.map((b) => b.upperMv)).toEqual([6000, 16000, 20000]);
    expectValid(m);
  });

  it('只剩一个状态时不再允许删', () => {
    let m = presetDefault();
    for (const k of [3, 2, 1]) m = reducer(m, { type: 'removeState', index: 0, k });
    expect(states(m).names).toEqual(['严重欠压 / 断线']);
    const again = reducer(m, { type: 'removeState', index: 0, k: 0 });
    expect(states(again).names).toEqual(['严重欠压 / 断线']);
  });
});

describe('setMode：量程在 b_n 与 voltage_max_mv 之间搬运', () => {
  it('stateful → measure_only：量程搬到通道级', () => {
    const m = reducer(presetDefault(), { type: 'setMode', index: 0, mode: 'measure_only' });
    const ch = m.channels[0]!;
    expect(ch.states.mode).toBe('measure_only');
    expect(ch.voltageMaxMv).toBe(20000);
    expect(voltageMaxMvOf(ch)).toBe(20000);
    expectValid(m);
  });

  it('measure_only → stateful：从通道级量程重建单状态，通道级字段清掉', () => {
    let m = reducer(presetDefault(), { type: 'setMode', index: 1, mode: 'stateful' });
    const ch = m.channels[1]!;
    expect(ch.states.mode).toBe('stateful');
    expect(ch.voltageMaxMv).toBeUndefined();
    expect(states(m, 1).boundaries[0]!.upperMv).toBe(44000);
    expectValid(m);
  });

  it('来回切一圈，量程不丢', () => {
    let m = reducer(presetDefault(), { type: 'setMode', index: 0, mode: 'measure_only' });
    m = reducer(m, { type: 'setMode', index: 0, mode: 'stateful' });
    expect(voltageMaxMvOf(m.channels[0]!)).toBe(20000);
  });
});

describe('通道增删与排序', () => {
  it('添加通道给出一个 2 状态的合法起点', () => {
    const m = reducer(presetDefault(), { type: 'addChannel' });
    expect(m.channels).toHaveLength(3);
    expectValid(m);
  });

  it('删除与上移下移保持索引一致', () => {
    let m = reducer(presetDefault(), { type: 'moveChannel', index: 1, delta: -1 });
    expect(m.channels[0]!.name).toBe('RBIN 冗余蓄电池');
    m = reducer(m, { type: 'removeChannel', index: 0 });
    expect(m.channels).toHaveLength(1);
    expect(m.channels[0]!.name).toBe('KL30 常电');
    expectValid(m);
  });
});

describe('冷启动与空模型', () => {
  it('initModel：无存档 → 1 个通道，按 default 预设 CH0 原样填充，0 error', () => {
    const m = initModel(() => null, () => null);
    expect(m.channels).toHaveLength(1);
    const ch = m.channels[0]!;
    expect(ch.name).toBe('KL30 常电');
    expect(ch.adc).toEqual({ fs: 4095, vrefMv: 5000 });
    expect(ch.states.mode).toBe('stateful');
    if (ch.states.mode !== 'stateful') throw new Error('unreachable');
    expect(ch.states.names).toEqual(['严重欠压 / 断线', '低压', '正常', '高压']);
    expect(m.schema).toBe(SCHEMA_VERSION);
    expectValid(m);
  });

  it('initModel：有存档且合法 → 按存档恢复', () => {
    const stored = emitConfigYaml(presetDefault());
    const m = initModel(() => stored, (t) => {
      const r = parseConfigText(t);
      return r.ok ? r.model : null;
    });
    expect(m.channels).toHaveLength(2);
  });

  it('initModel：存档解析失败 → 回落默认单通道', () => {
    const m = initModel(() => 'module: {', () => null);
    expect(m.channels).toHaveLength(1);
  });

  it('addChannel：再添加 → 按 default 预设 CH0 模板填充，名称重置为"新通道"，0 error', () => {
    let m = initModel(() => null, () => null);
    m = reducer(m, { type: 'addChannel' });
    expect(m.channels).toHaveLength(2);
    const ch = m.channels[1]!;
    expect(ch.adc).toEqual({ fs: 4095, vrefMv: 5000 });
    expect(ch.divider).toEqual({ rHighOhm: 10000, rLowOhm: 2000 });
    expect(ch.states.mode).toBe('stateful');
    if (ch.states.mode !== 'stateful') throw new Error('unreachable');
    expect(ch.states.names).toEqual(['严重欠压 / 断线', '低压', '正常', '高压']);
    expect(ch.name).toBe('新通道'); // 名称与说明重置，参数来自模板
    expectValid(m);
  });

  it('删光所有通道后 C1 报错（对应断言 m_channel_num_lo），下载被阻止', () => {
    let m = initModel(() => null, () => null);
    m = reducer(m, { type: 'removeChannel', index: 0 });
    expect(m.channels).toHaveLength(0);
    const c1 = checkRules(m).filter((d) => d.code === 'C1');
    expect(c1).toHaveLength(1);
    expect(c1[0]!.message).toContain('m_channel_num_lo');
  });
});
