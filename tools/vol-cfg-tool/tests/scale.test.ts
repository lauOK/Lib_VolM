/**
 * @file    scale.test.ts
 * @brief   定点派生量的基准值校验：必须与 C 侧 VOL_CH_SCALE_Q16_64 逐位一致。
 */
import { describe, expect, it } from 'vitest';

import {
  adcFullScaleMv,
  filterWindow,
  mvPerLsb,
  offsetUv,
  scaleBreakdown,
  scaleQ16,
  settleTimeMs,
} from '../src/core/scale';
import { presetDefault, presetLibrary } from '../src/model/presets';

describe('scaleQ16 与 C 宏逐位一致', () => {
  it('库示例 CH0 = 363593728（与 ReadMe / test_cfg.c 期望值一致）', () => {
    const ch = presetLibrary().channels[0]!;
    expect(scaleBreakdown(ch.adc, ch.divider, ch.calib).q16_64).toBe(363593728n);
    expect(scaleQ16(ch.adc, ch.divider, ch.calib)).toBe(363593728);
  });

  it('SA427L3 工程 CH0 = 322437120（VREF 5000 / 30.3k:10k / 无标定）', () => {
    const adc = { fs: 4095, vrefMv: 5000 };
    const divider = { rHighOhm: 30300, rLowOhm: 10000 };
    const calib = { gainPpm: 0, offsetMv: 150 };
    expect(scaleQ16(adc, divider, calib)).toBe(322437120);
    // 与通道内联的 12V 示例相比：分压比 4.03 对 6.88，系数应更大
    expect(scaleQ16(adc, divider, calib)).toBeGreaterThan(363593728 - 60_000_000);
  });

  it('库示例 CH1（RBIN，100k:8.2k）= 独立数值，且 < 2^32', () => {
    const ch = presetLibrary().channels[1]!;
    const { q16_64, fitsU32 } = scaleBreakdown(ch.adc, ch.divider, ch.calib);
    expect(fitsU32).toBe(true);
    // 3.3 V × (108200/8200) / 4095 × 1000 × 65536 = 10633 × 65536
    expect(q16_64).toBe(696844288n);
  });

  it('分压比为 0 时不抛异常，返回 fitsU32 = false', () => {
    const r = scaleBreakdown({ fs: 4095, vrefMv: 3300 }, { rHighOhm: 0, rLowOhm: 0 }, { gainPpm: 0, offsetMv: 0 });
    expect(r.fitsU32).toBe(false);
  });
});

describe('窗口与其它派生量', () => {
  it('by_time 按采样周期向上取整', () => {
    expect(filterWindow({ mode: 'by_time', arg: 8 }, 1)).toBe(8);
    expect(filterWindow({ mode: 'by_time', arg: 20 }, 5)).toBe(4);
    expect(filterWindow({ mode: 'by_time', arg: 20 }, 6)).toBe(4); // 3.33 → 4
    expect(filterWindow({ mode: 'by_time', arg: 1 }, 10)).toBe(1); // 向上取整后至少 1
  });

  it('by_sample 直接取点数', () => {
    expect(filterWindow({ mode: 'by_sample', arg: 16 }, 10)).toBe(16);
  });

  it('偏置换算为 µV', () => {
    expect(offsetUv({ gainPpm: 0, offsetMv: -10 })).toBe(-10000);
    expect(offsetUv({ gainPpm: 0, offsetMv: 150 })).toBe(150000);
  });

  it('ADC 满量程电压与分辨率（库示例：3300 × 35100/5100）', () => {
    const ch = presetLibrary().channels[0]!;
    expect(adcFullScaleMv(ch.adc, ch.divider)).toBeCloseTo(22711.8, 1);
    expect(mvPerLsb(ch.adc, ch.divider)).toBeCloseTo(5.546, 3);
  });

  it('ADC 满量程电压与分辨率（默认配置：5000 × 12000/2000 = 30 V）', () => {
    const ch = presetDefault().channels[0]!;
    expect(adcFullScaleMv(ch.adc, ch.divider)).toBe(30000);
    expect(mvPerLsb(ch.adc, ch.divider)).toBeCloseTo(7.326, 3);
  });

  it('建立时间 = 窗口 × 采样周期', () => {
    expect(settleTimeMs({ mode: 'by_time', arg: 8 }, 1)).toBe(8);
    expect(settleTimeMs({ mode: 'by_sample', arg: 16 }, 10)).toBe(160);
  });
});
