/**
 * @file    roundtrip.test.ts
 * @brief   P2 验收：配置文件读写必须互为逆运算，且对错文件明确报错。
 *
 * 为什么这么较真：导入是"用户把自己的工程配置交给工具"，只要往返有损，
 * 用户就会在毫无提示的情况下丢配置（典型：comment 被吃掉、boundaries 少一条）。
 */
import { JSON_SCHEMA, dump, load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { emitConfigYaml, parseConfigText } from '../src/core/cfgfile';
import { emitFiles } from '../src/core/emit';
import type { ConfigModel } from '../src/model/types';
import { voltageMaxMvOf } from '../src/model/types';
import { presetDefault } from '../src/model/presets';
import { modelAllStateful, modelFiveChannels } from './helpers/models';

type Raw = Record<string, any>;

const MODELS: Array<[string, () => ConfigModel]> = [
  ['default（12 V / 4 状态 + RBIN）', presetDefault],
  ['five（5 通道：8 状态 / RBIN / 1 / 2 / 3 状态）', modelFiveChannels],
  ['all-stateful（全状态通道）', modelAllStateful],
];

/** 取模型的"原始对象"视图：借生成器 + 解析器转一圈，避免在测试里重复写字段映射 */
function rawOf(model: ConfigModel): Raw {
  return load(emitConfigYaml(model), { schema: JSON_SCHEMA }) as Raw;
}

function textOf(raw: unknown): string {
  return dump(raw, { schema: JSON_SCHEMA, lineWidth: -1 });
}

function mustParse(text: string): ConfigModel {
  const r = parseConfigText(text);
  if (!r.ok) {
    throw new Error(`期望解析成功，实际报错：\n${r.diags.map((d) => `${d.code} ${d.path} ${d.message}`).join('\n')}`);
  }
  return r.model;
}

function expectError(text: string, code: string, path: string): void {
  const r = parseConfigText(text);
  expect(r.ok, `期望被拦下（${code} @ ${path}），实际解析成功`).toBe(false);
  if (r.ok) return;
  const dumpAll = r.diags.map((d) => `${d.severity} ${d.code} ${d.path || '<顶层>'} ${d.message}`).join('\n');
  expect(r.diags.some((d) => d.code === code && d.path === path), `未命中 ${code} @ ${path}\n实际：\n${dumpAll}`).toBe(true);
  expect(r.diags.every((d) => d.severity === 'error'), `结构错误不应是 warning：\n${dumpAll}`).toBe(true);
}

describe('model → YAML → model', () => {
  for (const [label, make] of MODELS) {
    it(`${label}：深比较相等`, () => {
      const model = make();
      const back = mustParse(emitConfigYaml(model));
      expect(back).toEqual(model);
    });

    it(`${label}：导出幂等（逐字节）`, () => {
      const model = make();
      const once = emitConfigYaml(model);
      const twice = emitConfigYaml(mustParse(once));
      expect(twice).toBe(once);
      expect(emitConfigYaml(make())).toBe(once);
    });
  }
});

describe('配置文件与 C 文件的一致性', () => {
  for (const [label, make] of MODELS) {
    it(`${label}：改走 YAML 一圈，生成的 C 文件逐字节不变`, () => {
      const model = make();
      const direct = emitFiles(model);
      const viaYaml = emitFiles(mustParse(emitConfigYaml(model)));
      expect(viaYaml.h).toBe(direct.h);
      expect(viaYaml.c).toBe(direct.c);
    });
  }
});

describe('量程上限的唯一来源是 bn', () => {
  it('把 bn 从 20000 改成 24000，VOLTAGE_MAX_MV 与末状态 UPPER 同步跟着变', () => {
    const model = presetDefault();
    const ch0 = model.channels[0]!;
    const st = ch0.states;
    if (st.mode !== 'stateful') throw new Error('preset 的 CH0 必须是状态通道');
    const boundaries = st.boundaries.map((b, i) =>
      i === st.boundaries.length - 1 ? { ...b, upperMv: 24000 } : b,
    );
    const bumped: ConfigModel = {
      ...model,
      channels: [{ ...ch0, states: { ...st, boundaries } }, model.channels[1]!],
    };
    const files = emitFiles(bumped);
    expect(files.h).toMatch(/#define VOL_CH0_VOLTAGE_MAX_MV\s+24000\b/);
    expect(files.h).toMatch(/#define VOL_CH0_S3_UPPER_MV\s+24000\b/);
    expect(files.c).toContain('(uint16_t)VOL_CH0_VOLTAGE_MAX_MV,');
    expect(voltageMaxMvOf(mustParse(emitConfigYaml(bumped)).channels[0]!)).toBe(24000);
  });
});

describe('文本层面的确定性', () => {
  const yaml = emitConfigYaml(presetDefault());

  it('纯 LF、无 BOM、无 tab、无行尾空白、以单个换行结尾', () => {
    expect(yaml).not.toContain('\r');
    expect(yaml.charCodeAt(0)).not.toBe(0xfeff);
    expect(yaml).not.toContain('\t');
    expect(yaml.endsWith('\n')).toBe(true);
    expect(yaml.endsWith('\n\n')).toBe(false);
    expect(yaml.split('\n').filter((l) => l !== l.replace(/[ \t]+$/, ''))).toEqual([]);
  });

  it('不含时间戳、路径等易变内容', () => {
    expect(yaml).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(yaml).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(yaml).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('版本号在第二段且与 SCHEMA_VERSION 一致', () => {
    const lines = yaml.split('\n');
    expect(lines[0]!.startsWith('#')).toBe(true);
    expect(lines).toContain('schema: volm-cfg/1');
  });
});

describe('YAML → model → YAML（对文本而非模型求逆）', () => {
  it('我们自己导出的文本原样回读后再导出，逐字节不变', () => {
    for (const [, make] of MODELS) {
      const text = emitConfigYaml(make());
      expect(emitConfigYaml(mustParse(text))).toBe(text);
    }
  });

  it('等价但排版不同的手写文本，规范化后内容不丢', () => {
    const model = presetDefault();
    const compact = textOf(rawOf(model));
    expect(compact).not.toBe(emitConfigYaml(model));
    expect(mustParse(compact)).toEqual(model);
  });
});

describe('负向：结构错误必须带字段路径拦下', () => {
  const base = (): Raw => JSON.parse(JSON.stringify(rawOf(presetDefault())));

  it('F1 语法错（YAML 拼坏）', () => {
    expectError('module: [未闭合\n  - a', 'F1', '');
  });

  it('F1 空文件', () => {
    expectError('   \n\n', 'F1', '');
  });

  it('F1 重复键（同一个字段写了两遍）', () => {
    const yaml = emitConfigYaml(presetDefault()).replace(
      '  sample_period_ms: 1',
      '  sample_period_ms: 1\n  sample_period_ms: 2',
    );
    expectError(yaml, 'F1', '');
  });

  it('tab 缩进不会被静默接受（js-yaml 会按自己的规则报错，编号不一定是 F1）', () => {
    const r = parseConfigText('module://n//tsample_period_ms: 1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diags.length).toBeGreaterThan(0);
  });

  it('F2 schema 版本不符', () => {
    const raw = base();
    raw['schema'] = 'volm-cfg/2';
    expectError(textOf(raw), 'F2', 'schema');
  });

  it('F2 schema 不是字符串', () => {
    const raw = base();
    raw['schema'] = 1;
    expectError(textOf(raw), 'F2', 'schema');
  });

  it('F3 通道里的未知字段（拼错的 voltage_maxv_mv）', () => {
    const raw = base();
    raw['channels'][0]['voltage_maxv_mv'] = 20000;
    expectError(textOf(raw), 'F3', 'channels[0].voltage_maxv_mv');
  });

  it('F3 顶层未知字段', () => {
    const raw = base();
    raw['created_at'] = '2026-11-03';
    expectError(textOf(raw), 'F3', 'created_at');
  });

  it('F3 measure_only 通道不许写 names（写了就是误解）', () => {
    const raw = base();
    raw['channels'][1]['states']['names'] = ['不该有'];
    expectError(textOf(raw), 'F3', 'channels[1].states.names');
  });

  it('F4 缺必填字段 module.sample_period_ms', () => {
    const raw = base();
    delete raw['module']['sample_period_ms'];
    expectError(textOf(raw), 'F4', 'module.sample_period_ms');
  });

  it('F4 缺 channel.adc', () => {
    const raw = base();
    delete raw['channels'][0]['adc'];
    expectError(textOf(raw), 'F4', 'channels[0].adc');
  });

  it('F5 类型错：fs 写成字符串', () => {
    const raw = base();
    raw['channels'][0]['adc']['fs'] = '4095';
    expectError(textOf(raw), 'F5', 'channels[0].adc.fs');
  });

  it('F5 小数：filter.arg = 1.5', () => {
    const raw = base();
    raw['channels'][0]['filter']['arg'] = 1.5;
    expectError(textOf(raw), 'F5', 'channels[0].filter.arg');
  });

  it('F5 filter.mode 取值非法', () => {
    const raw = base();
    raw['channels'][0]['filter']['mode'] = 'by-time';
    expectError(textOf(raw), 'F5', 'channels[0].filter.mode');
  });

  it('F5 states.mode 取值非法', () => {
    const raw = base();
    raw['channels'][0]['states']['mode'] = 'stateless';
    expectError(textOf(raw), 'F5', 'channels[0].states.mode');
  });

  it('F5 状态名为空', () => {
    const raw = base();
    raw['channels'][0]['states']['names'][1] = '';
    expectError(textOf(raw), 'F5', 'channels[0].states.names[1]');
  });

  it('F6 boundaries 与 names 长度不匹配（多写一条）', () => {
    const raw = base();
    raw['channels'][0]['states']['boundaries'].push({ upper_mv: 19000, hyst_up_mv: 0, hyst_down_mv: 0 });
    expectError(textOf(raw), 'F6', 'channels[0].states.boundaries');
  });

  it('F6 没有通道', () => {
    const raw = base();
    raw['channels'] = [];
    expectError(textOf(raw), 'F6', 'channels');
  });

  it('F6 单状态通道的 boundaries 不是 1 条（bn 必须写，且只能写 1 条）', () => {
    const raw = base();
    mustParse(textOf(raw)); // 先确认基线可解析
    raw['channels'][0]['states']['names'] = ['只有一档'];
    expectError(textOf(raw), 'F6', 'channels[0].states.boundaries');
  });

  it('F3 有状态通道还写 voltage_max_mv（量程已由 bn 给出）', () => {
    const raw = base();
    raw['channels'][0]['voltage_max_mv'] = 20000;
    expectError(textOf(raw), 'F3', 'channels[0].voltage_max_mv');
  });

  it('F4 measure_only 通道缺 voltage_max_mv（没有状态表，量程无处可推）', () => {
    const raw = base();
    delete raw['channels'][1]['voltage_max_mv'];
    expectError(textOf(raw), 'F4', 'channels[1].voltage_max_mv');
  });

  it('F5 量程端点 bn 写了非 0 迟滞（末状态没有上侧邻居）', () => {
    const raw = base();
    raw['channels'][0]['states']['boundaries'][3]['hyst_up_mv'] = 300;
    expectError(textOf(raw), 'F5', 'channels[0].states.boundaries[3].hyst_up_mv');
  });
});

describe('导入兼容性', () => {
  it('JSON 文本可直接导入（字段名与 YAML 相同）', () => {
    const model = presetDefault();
    const json = JSON.stringify(rawOf(model), null, 2);
    expect(mustParse(json)).toEqual(model);
  });

  it('带 UTF-8 BOM 的文件可导入', () => {
    const text = `\uFEFF${emitConfigYaml(presetDefault())}`;
    expect(mustParse(text)).toEqual(presetDefault());
  });

  it('可选 comment 省略后仍可往返（不会被补成空串）', () => {
    const model = modelFiveChannels();
    expect(model.module.comment).toBeUndefined();
    const yaml = emitConfigYaml(model);
    const back = mustParse(yaml);
    expect(back.module.comment).toBeUndefined();
    expect(emitConfigYaml(back)).toBe(yaml);
  });

  it('多行 comment 与结尾换行都能精确往返', () => {
    const model = presetDefault();
    const variants = ['单行说明', '第一行\n第二行', '第一行\n\n第三行(有空行)', '带结尾换行\n'];
    for (const comment of variants) {
      const withComment: ConfigModel = {
        ...model,
        channels: model.channels.map((ch, i) => (i === 0 ? { ...ch, comment } : ch)),
      };
      const back = mustParse(emitConfigYaml(withComment));
      expect(back.channels[0]!.comment, `comment = ${JSON.stringify(comment)}`).toBe(comment);
      expect(emitConfigYaml(back)).toBe(emitConfigYaml(withComment));
    }
  });

  it('状态名含逗号/冒号/井号时自动加引号且能读回', () => {
    const model = presetDefault();
    const nasty = 'a, b: c # d';
    const withName: ConfigModel = {
      ...model,
      channels: model.channels.map((ch, i) =>
        i === 0 && ch.states.mode === 'stateful'
          ? { ...ch, states: { ...ch.states, names: ch.states.names.map((n, j) => (j === 0 ? nasty : n)) } }
          : ch,
      ),
    };
    const yaml = emitConfigYaml(withName);
    expect(yaml).toContain(`'a, b: c # d'`);
    expect(mustParse(yaml)).toEqual(withName);
  });
});

describe('样例文件（供人工评审）', () => {
  it('samples/vol_cfg.yaml 若存在，应与当前生成器一致', () => {
    const p = new URL('../samples/vol_cfg.yaml', import.meta.url);
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      return; // 尚未生成时跳过
    }
    expect(text).toBe(emitConfigYaml(presetDefault()));
  });
});
