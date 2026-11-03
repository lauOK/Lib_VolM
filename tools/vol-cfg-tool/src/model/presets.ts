/**
 * @file    presets.ts
 * @brief   内置预设模板。
 *
 * 两套模型，用途严格区分，别混：
 *   presetDefault()  面向用户：冷启动的初始通道、"+ 添加通道"的模板、default 预设按钮。
 *                    取值是当前板子的实测参数（5 V 参考、10 kΩ/2 kΩ 分压、按点数滤波 10 点）。
 *   presetLibrary() 面向回归：与库自带示例（inc/vol_cfg.h + src/vol_cfg.c）逐项一致，
 *                    是 golden 的基准。它**不出现**在任何 UI 入口——用户改了默认参数不该
 *                    动摇"生成器能否还原手写原件"这条基准。
 */
import type { ChannelCfg, ConfigModel } from './types';
import { SCHEMA_VERSION } from './types';

/** 冷启动的空模型：0 通道，模块参数用一套中性默认值（不影响换算结果） */
export function emptyModel(): ConfigModel {
  return {
    schema: SCHEMA_VERSION,
    module: {
      samplePeriodMs: 10,
      filterWindowMax: 64,
      stateNumMax: 12,
      channelNumMax: 8,
      rMaxOhm: 1000000,
    },
    channels: [],
  };
}

/** 冷启动模型：自带 1 个通道（default 预设的 CH0 原样，含名称与说明） */
export function startupModel(): ConfigModel {
  const p = presetDefault();
  return { ...p, channels: [structuredClone(p.channels[0]!)] };
}

/** 新通道模板：取 default 预设的 CH0 参数，名称与说明按"新通道"重置 */
export function presetChannelTemplate(): ChannelCfg {
  const ch = presetDefault().channels[0]!;
  return { ...structuredClone(ch), name: '新通道', comment: undefined };
}

/**
 * 默认配置：12 V 系统 + 一路 RBIN。
 *
 * 取值即板上实测：12 位 ADC、5 V 参考、10 kΩ / 2 kΩ 分压（量程 30 V）、不加标定、
 * 按点数滤波 10 点（采样周期 10 ms → 建立时间 100 ms）。
 * 4 个电压段与迟滞沿用 12 V 系统惯例：6 / 9 / 16 / 20 V，迟滞 0.5~2 V。
 */
export function presetDefault(): ConfigModel {
  return {
    schema: SCHEMA_VERSION,
    module: {
      samplePeriodMs: 10,
      filterWindowMax: 64,
      stateNumMax: 12,
      channelNumMax: 8,
      rMaxOhm: 1000000,
      comment: '示例为 12 V 系统 + 一路 RBIN',
    },
    channels: [
      {
        // comment 省略：banner 由参数自动生成，改参数时不会留下过期说明
        name: 'KL30 常电',
        adc: { fs: 4095, vrefMv: 5000 },
        divider: { rHighOhm: 10000, rLowOhm: 2000 },
        calib: { gainPpm: 0, offsetMv: 0 },
        filter: { mode: 'by_sample', arg: 10 },
        states: {
          mode: 'stateful',
          names: ['严重欠压 / 断线', '低压', '正常', '高压'],
          boundaries: [
            { upperMv: 6000, hystUpMv: 0, hystDownMv: 500 },
            { upperMv: 9000, hystUpMv: 1000, hystDownMv: 2000 },
            { upperMv: 16000, hystUpMv: 500, hystDownMv: 500 },
            { upperMv: 20000, hystUpMv: 0, hystDownMv: 0 },
          ],
        },
      },
      {
        name: 'RBIN 冗余蓄电池',
        comment: [
          '通道 1：RBIN 冗余蓄电池采样（24 V 系统），分压 100 kΩ / 8.2 kΩ',
          '仅测量通道：只做「换算 + 滤波 + 提供电压」，不管理状态。',
          'STATE_NUM = 0 时下列 S<i> 宏一个都不需要定义（架构 D11 / C12）。',
        ].join('\n'),
        adc: { fs: 4095, vrefMv: 5000 },
        divider: { rHighOhm: 100000, rLowOhm: 8200 },
        calib: { gainPpm: 0, offsetMv: 0 },
        filter: { mode: 'by_sample', arg: 16 },
        voltageMaxMv: 44000,
        states: { mode: 'measure_only' },
      },
    ],
  };
}

/**
 * 库自带示例配置（golden 基准，勿用于 UI 入口）。
 *
 * 与 inc/vol_cfg.h + src/vol_cfg.c 逐项一致：30 kΩ / 5.1 kΩ、3.3 V 参考、gain +500 ppm、
 * offset −10 mV、按时间滤波 8 ms、采样周期 1 ms。tests/golden.test.ts 拿它跟手写原件逐行对拍，
 * 用来证明"生成器没有偷偷改变库的行为"。改它等于改基准，除非库的示例文件也一起改了。
 */
export function presetLibrary(): ConfigModel {
  return {
    schema: SCHEMA_VERSION,
    module: {
      samplePeriodMs: 1,
      filterWindowMax: 64,
      stateNumMax: 12,
      channelNumMax: 8,
      rMaxOhm: 1000000,
      comment: '示例为 12 V 系统 + 一路 RBIN',
    },
    channels: [
      {
        name: 'KL30 常电',
        comment: '通道 0：KL30 常电，分压 30 kΩ / 5.1 kΩ，12 位 ADC，3.3 V 参考，4 个状态',
        adc: { fs: 4095, vrefMv: 3300 },
        divider: { rHighOhm: 30000, rLowOhm: 5100 },
        calib: { gainPpm: 500, offsetMv: -10 },
        filter: { mode: 'by_time', arg: 8 },
        states: {
          mode: 'stateful',
          names: ['严重欠压 / 断线', '低压', '正常', '高压'],
          boundaries: [
            { upperMv: 6000, hystUpMv: 0, hystDownMv: 500 },
            { upperMv: 9000, hystUpMv: 1000, hystDownMv: 2000 },
            { upperMv: 16000, hystUpMv: 500, hystDownMv: 500 },
            { upperMv: 20000, hystUpMv: 0, hystDownMv: 0 },
          ],
        },
      },
      {
        name: 'RBIN 冗余蓄电池',
        comment: [
          '通道 1：RBIN 冗余蓄电池采样（24 V 系统），分压 100 kΩ / 8.2 kΩ',
          '仅测量通道：只做「换算 + 滤波 + 提供电压」，不管理状态。',
          'STATE_NUM = 0 时下列 S<i> 宏一个都不需要定义（架构 D11 / C12）。',
        ].join('\n'),
        adc: { fs: 4095, vrefMv: 3300 },
        divider: { rHighOhm: 100000, rLowOhm: 8200 },
        calib: { gainPpm: 0, offsetMv: 0 },
        filter: { mode: 'by_sample', arg: 16 },
        voltageMaxMv: 44000,
        states: { mode: 'measure_only' },
      },
    ],
  };
}

export interface PresetEntry {
  id: string;
  label: string;
  make: () => ConfigModel;
}

/** 预设列表：只有一个内建 default，后续自定义配置另存 */
export const PRESETS: PresetEntry[] = [{ id: 'default', label: 'default', make: presetDefault }];

export function presetById(id: string): ConfigModel {
  const hit = PRESETS.find((p) => p.id === id);
  return (hit ?? PRESETS[0]!).make();
}
