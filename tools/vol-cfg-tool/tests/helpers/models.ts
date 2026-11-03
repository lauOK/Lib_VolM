/**
 * @file    models.ts
 * @brief   测试用的非常规配置：用来覆盖 12 V 预设照顾不到的分支。
 */
import type { ChannelCfg, ConfigModel } from '../../src/model/types';
import { SCHEMA_VERSION } from '../../src/model/types';

const baseChannel = (over: Partial<ChannelCfg>): ChannelCfg => ({
  name: 'CH',
  adc: { fs: 4095, vrefMv: 3300 },
  divider: { rHighOhm: 30000, rLowOhm: 5100 },
  calib: { gainPpm: 0, offsetMv: 0 },
  filter: { mode: 'by_sample', arg: 8 },
  states: { mode: 'measure_only' },
  ...over,
});

/** 量程端点 b_n：只有 upper_mv 有意义，两个迟滞恒为 0 */
const lastBoundary = (upperMv: number): { upperMv: number; hystUpMv: number; hystDownMv: number } => ({
  upperMv,
  hystUpMv: 0,
  hystDownMv: 0,
});

/**
 * 5 通道混合：8 状态 / 仅测量 / 1 状态 / 2 状态 / 3 状态。
 * 用于验证生成器已解除库的"最多 2 通道"限制，且 1/2/8 状态等边界档位都正确。
 */
export function modelFiveChannels(): ConfigModel {
  const eightNames = ['断线', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', '过压'];
  const eightBoundaries = [
    ...[1000, 3000, 6000, 9000, 12000, 16000, 18000].map((upperMv, i) => ({
      upperMv,
      hystUpMv: i === 0 ? 0 : 200,
      hystDownMv: 200,
    })),
    lastBoundary(20000),
  ];

  return {
    schema: SCHEMA_VERSION,
    module: {
      samplePeriodMs: 2,
      filterWindowMax: 64,
      stateNumMax: 8,
      channelNumMax: 8,
      rMaxOhm: 1000000,
    },
    channels: [
      baseChannel({
        name: '8 状态通道',
        comment: '通道 0：8 状态压力测试（边界档位上限）',
        states: { mode: 'stateful', names: eightNames, boundaries: eightBoundaries },
      }),
      baseChannel({
        name: 'RBIN',
        comment: '通道 1：仅测量通道',
        divider: { rHighOhm: 100000, rLowOhm: 8200 },
        voltageMaxMv: 32000,
        filter: { mode: 'by_time', arg: 20 },
      }),
      baseChannel({
        name: '单状态',
        comment: '通道 2：只有 1 个状态，覆盖全量程',
        states: { mode: 'stateful', names: ['正常'], boundaries: [lastBoundary(20000)] },
      }),
      baseChannel({
        name: '双状态',
        comment: '通道 3：2 个状态（C5/C7 各只有 1 条）',
        states: {
          mode: 'stateful',
          names: ['低压', '正常'],
          boundaries: [{ upperMv: 9000, hystUpMv: 300, hystDownMv: 300 }, lastBoundary(20000)],
        },
      }),
      baseChannel({
        name: '三状态',
        comment: '通道 4：3 个状态，负偏置与增益标定',
        calib: { gainPpm: -2500, offsetMv: -120 },
        filter: { mode: 'by_time', arg: 30 },
        states: {
          mode: 'stateful',
          names: ['低压', '正常', '高压'],
          boundaries: [
            { upperMv: 9000, hystUpMv: 250, hystDownMv: 250 },
            { upperMv: 16000, hystUpMv: 250, hystDownMv: 250 },
            lastBoundary(20000),
          ],
        },
      }),
    ],
  };
}

/** 全部通道都是状态通道（用于验证"不应该出现任何 #error"） */
export function modelAllStateful(): ConfigModel {
  return {
    schema: SCHEMA_VERSION,
    module: { samplePeriodMs: 1, filterWindowMax: 64, stateNumMax: 8, channelNumMax: 8, rMaxOhm: 1000000 },
    channels: [
      baseChannel({
        name: 'A',
        states: {
          mode: 'stateful',
          names: ['低压', '正常'],
          boundaries: [{ upperMv: 12000, hystUpMv: 500, hystDownMv: 500 }, lastBoundary(20000)],
        },
      }),
    ],
  };
}

/**
 * 12 状态单通道：把库的容量上限（VOL_STATE_NUM_MAX = 12）真铺满。
 *
 * 每段宽 1500 mV、量程 18 V（baseChannel 的分压满量程是 22.7 V，不触发 W1），
 * 迟滞 200/200 —— C5（无缝衔接）与 C7（迟滞不越界：200 + 200 < 1500）在 12 段上都成立。
 * 首状态下行迟滞、末状态上行迟滞按 C10 锁 0。
 * 这个用例的价值：常量从 8 改到 12 若只改了数字、没同步库断言与骨架，
 * 生成的文件会当场编译失败。
 */
export function modelTwelveStates(): ConfigModel {
  const names = [
    '断线', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', '过压',
  ];
  const boundaries = [
    ...[
      1500, 3000, 4500, 6000, 7500, 9000, 10500, 12000, 13500, 15000, 16500,
    ].map((upperMv, i) => ({
      upperMv,
      hystUpMv: 200,
      // 首状态没有下邻，下行迟滞必须是 0（C10）
      hystDownMv: i === 0 ? 0 : 200,
    })),
    // 末状态：上界即量程端点，上行迟滞锁 0（C10）
    lastBoundary(18000),
  ];

  return {
    schema: SCHEMA_VERSION,
    module: { samplePeriodMs: 1, filterWindowMax: 64, stateNumMax: 12, channelNumMax: 8, rMaxOhm: 1000000 },
    channels: [
      baseChannel({
        name: '12 状态',
        comment: '铺满 VOL_STATE_NUM_MAX',
        states: { mode: 'stateful', names, boundaries },
      }),
    ],
  };
}

/**
 * 带标定实测点的单通道：yaml 的 calib_points 段 / C 文件 banner 摘要都靠它覆盖。
 *
 * 数值按 baseChannel 的理论斜率（3300 × 35100/5100 ≈ 6.882 mV/mV）加固定小偏差造出，
 * 三个点码值跨度大，解析初值就足够接近，专门用来验证"往返 + 摘要"，不测拟合精度
 * （精度在 calibration.test.ts 里用默认预设的通道算，那里数字更好读）。
 */
export function modelWithCalibPoints(): ConfigModel {
  return {
    schema: SCHEMA_VERSION,
    module: { samplePeriodMs: 1, filterWindowMax: 64, stateNumMax: 8, channelNumMax: 8, rMaxOhm: 1000000 },
    channels: [
      baseChannel({
        name: '标定通道',
        calib: { gainPpm: 1234, offsetMv: -8 },
        calibPoints: [
          { code: 500, inMv: 2775 },
          { code: 1200, inMv: 6655 },
          { code: 2000, inMv: 11092 },
        ],
        states: {
          mode: 'stateful',
          names: ['低压', '正常'],
          boundaries: [{ upperMv: 12000, hystUpMv: 500, hystDownMv: 500 }, lastBoundary(20000)],
        },
      }),
    ],
  };
}
