/**
 * @file    scale.ts
 * @brief   派生量计算：与 C 侧宏 VOL_CH_SCALE_Q16_64 / VOL_FILT_WINDOW_CALC 逐位一致。
 *
 * 为什么必须用 BigInt：C 里的中间量最大可达 5e6 × 2e6 × 1.1e6 ≈ 1.1e19，
 * 远超 JS Number 的 2^53 安全整数范围，用 Number 算会静默丢精度。
 * C11 成立时中间量必然 < 2^64，且 (1e6 + GAIN) > 0，所以无需模拟 uint64 回绕。
 */
import type { AdcCfg, CalibCfg, DividerCfg, FilterCfg } from '../model/types';

const U64_LIMIT = 1n << 64n;
const U32_LIMIT = 1n << 32n;

export interface ScaleBreakdown {
  /** 强转前的 64 位值（C9 断言对象） */
  q16_64: bigint;
  /** 是否 < 2^32（C9 通过条件） */
  fitsU32: boolean;
  /** 分子、分母，便于在 UI 上解释结果 */
  numerator: bigint;
  denominator: bigint;
  /** 中间量是否超出 uint64（C11 未拦住时的理论情况） */
  overflowU64: boolean;
}

/** 复刻 VOL_CH_SCALE_Q16_64(ch)：先整除，再乘 65536，顺序不可交换 */
export function scaleBreakdown(adc: AdcCfg, divider: DividerCfg, calib: CalibCfg): ScaleBreakdown {
  const numerator =
    BigInt(adc.vrefMv) *
    1000n *
    (BigInt(divider.rHighOhm) + BigInt(divider.rLowOhm)) *
    BigInt(1000000 + calib.gainPpm);
  const denominator = BigInt(adc.fs) * BigInt(divider.rLowOhm) * 1000000n;

  if (denominator === 0n) {
    return { q16_64: 0n, fitsU32: false, numerator, denominator, overflowU64: numerator >= U64_LIMIT };
  }
  const ratio = numerator / denominator; // BigInt 除法对非负数向零截断，等价 C 无符号整除
  const q16_64 = ratio * 65536n;
  return {
    q16_64,
    fitsU32: q16_64 < U32_LIMIT,
    numerator,
    denominator,
    overflowU64: numerator >= U64_LIMIT,
  };
}

/** VOL_CH_SCALE_Q16 的写入值（C 侧会强转 uint32） */
export function scaleQ16(adc: AdcCfg, divider: DividerCfg, calib: CalibCfg): number {
  const { q16_64 } = scaleBreakdown(adc, divider, calib);
  return Number(BigInt.asUintN(32, q16_64));
}

/** 复刻 VOL_FILT_WINDOW_CALC：TIME 模式按采样周期向上取整，至少 1 点 */
export function filterWindow(filter: FilterCfg, samplePeriodMs: number): number {
  if (filter.mode !== 'by_time') return filter.arg;
  const period = samplePeriodMs > 0 ? samplePeriodMs : 1;
  return Math.max(1, Math.ceil(filter.arg / period));
}

/** VOL_CH_OFFSET_UV：mV → µV，编译期完成 */
export function offsetUv(calib: CalibCfg): number {
  return calib.offsetMv * 1000;
}

/** 分压比 (RH + RL) / RL —— 输入电压相对 ADC 引脚电压的倍数 */
export function dividerRatio(divider: DividerCfg): number {
  return divider.rLowOhm > 0 ? (divider.rHighOhm + divider.rLowOhm) / divider.rLowOhm : NaN;
}

/** ADC 满量程码值对应的被测电压 mV（不含偏置与增益修正） */
export function adcFullScaleMv(adc: AdcCfg, divider: DividerCfg): number {
  return (adc.vrefMv * (divider.rHighOhm + divider.rLowOhm)) / (divider.rLowOhm || 1);
}

/** 每个 ADC 码值对应的被测电压 mV —— 决定状态边界能被分辨到多细 */
export function mvPerLsb(adc: AdcCfg, divider: DividerCfg): number {
  return adc.fs > 0 ? adcFullScaleMv(adc, divider) / adc.fs : NaN;
}

/** 滤波建立时间 ms：窗口深度 × 采样周期，上电后这段时间内读数无效 */
export function settleTimeMs(filter: FilterCfg, samplePeriodMs: number): number {
  return filterWindow(filter, samplePeriodMs) * (samplePeriodMs > 0 ? samplePeriodMs : 1);
}

/** 上行跳变门限：从 S_i 向上离开 */
export function upThresholdMv(upperMv: number, hystUpMv: number): number {
  return upperMv + hystUpMv;
}

/** 下行跳变门限：从 S_{i+1} 向下回来 */
export function downThresholdMv(upperMv: number, hystDownMv: number): number {
  return upperMv - hystDownMv;
}
