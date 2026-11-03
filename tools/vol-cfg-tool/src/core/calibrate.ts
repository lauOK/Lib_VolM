/**
 * @file    calibrate.ts
 * @brief   标定打点：实测点 → 预测 / 残差 / 最小二乘求解 gain_ppm 与 offset_mv。
 *
 * 三条硬约束（决定了这里为什么这么写）：
 *
 * 1. **预测必须与 C 逐位一致**。`VOL_CH_SCALE_Q16_64` 是"先整除、再乘 65536"，
 *    运行时是 `(adc*scale)>>16`、加偏置、限幅、最后 (uv+500)/1000。这里一行不差地照抄，
 *    否则"图上残差 0、板子上差 30 mV"这种最难查的问题就会出现。
 *
 * 2. **纯解析解不够**。scale_q16 的整除截断会让有效斜率偏离理想 (RH+RL)/RL，
 *    偏差量级 ≈ 1/ratio（典型几 ppm~几百 ppm）。所以先给解析初值，再按 1 ppm 精扫。
 *
 * 3. **点数少时不能编**。一个点或所有点同一码值，斜率无解——只解偏置并说明原因，
 *    绝不返回 NaN 让 UI 去猜。
 */
import type { AdcCfg, CalibCfg, CalibPoint, DividerCfg } from '../model/types';

import { dividerRatio, scaleQ16 } from './scale';

/** 32 位定点数上限（C9 的判据）。注意不能写 `1 << 32`——JS 位移按 32 取模，结果会是 1 */
const U32_LIMIT = 2 ** 32;

export interface Residuals {
  /** 逐点残差 mV（实测 − 预测），与 points 同序 */
  residualsMv: number[];
  /** 均方根 mV */
  rmsMv: number;
  /** 最大绝对残差 mV */
  maxAbsMv: number;
}

export interface CalibFitResult extends Residuals {
  ok: boolean;
  gainPpm: number;
  offsetMv: number;
  /** 退化 / 钳位 / 失败原因，UI 原样展示 */
  note?: string;
}

/** 码值 → 引脚电压 mV（纯比例，不涉及任何标定值） */
export function pinOf(code: number, adc: AdcCfg): number {
  return adc.fs > 0 ? (code / adc.fs) * adc.vrefMv : NaN;
}

/**
 * 按 C 的整数流水线预测某个码值处的读数 mV。
 *
 * `code * scale < 2^48`，远在 2^53 内，所以内层可以用 Number 精确乘除；
 * 只有 scale_q16 本身需要 BigInt（复用 scale.ts，绝不重写整除顺序）。
 */
export function predMv(
  code: number,
  adc: AdcCfg,
  divider: DividerCfg,
  calib: CalibCfg,
  vmaxMv: number,
): number {
  const scale = scaleQ16(adc, divider, calib);
  const uv = Math.floor((code * scale) / 65536) + calib.offsetMv * 1000;
  const lim = Math.min(Math.max(uv, 0), vmaxMv * 1000);
  return Math.floor((lim + 500) / 1000);
}

/** 当前标定下逐点残差 */
export function evalResiduals(
  points: readonly CalibPoint[],
  adc: AdcCfg,
  divider: DividerCfg,
  calib: CalibCfg,
  vmaxMv: number,
): Residuals {
  const residualsMv = points.map((p) => p.inMv - predMv(p.code, adc, divider, calib, vmaxMv));
  return { residualsMv, ...stats(residualsMv) };
}

function stats(residualsMv: number[]): { rmsMv: number; maxAbsMv: number } {
  if (residualsMv.length === 0) return { rmsMv: 0, maxAbsMv: 0 };
  let sum = 0;
  let max = 0;
  for (const r of residualsMv) {
    sum += r * r;
    if (Math.abs(r) > max) max = Math.abs(r);
  }
  return { rmsMv: Math.sqrt(sum / residualsMv.length), maxAbsMv: max };
}

/**
 * 过点集的直线 `in = a·pin + b` 与最大偏离（线性度）。
 *
 * 线性度是判断"两个残差够不够用"的唯一依据：肖特基的非线性越强，
 * 点相对这条直线的弯曲越大，两参数标定就越救不回来。
 */
export function fitLine(
  points: readonly CalibPoint[],
  adc: AdcCfg,
): { a: number; b: number; maxDevMv: number } | null {
  if (points.length < 2) return null;
  const xs = points.map((p) => pinOf(p.code, adc));
  const ys = points.map((p) => p.inMv);
  if (!xs.every(Number.isFinite)) return null;

  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  if (!(sxx > 0)) return null;

  const a = sxy / sxx;
  const b = my - a * mx;
  let maxDevMv = 0;
  for (let i = 0; i < n; i++) {
    const dev = Math.abs(ys[i]! - (a * xs[i]! + b));
    if (dev > maxDevMv) maxDevMv = dev;
  }
  return { a, b, maxDevMv };
}

const GAIN_LIMIT = 100000; // C11
const OFFSET_LIMIT = 1000; // C11

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 在给定 gain 下求最优 offset 与残差。
 *
 * 连续模型下 `in_i ≈ raw_i/1000 + off`，最小二乘对 off 的解就是残差均值；
 * 但最终 pred 里有 `(uv+500)/1000` 的整数舍入，所以 off−1 / off / off+1 各试一遍。
 */
function evalAtGain(
  raws: readonly number[],
  ins: readonly number[],
  limUv: number,
): { offMv: number; rmsMv: number; maxAbsMv: number; residuals: number[] } | null {
  const n = raws.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += ins[i]! * 1000 - raws[i]!;
  const guess = clamp(Math.round(sum / n / 1000), -OFFSET_LIMIT, OFFSET_LIMIT);

  let best: { offMv: number; rmsMv: number; maxAbsMv: number; residuals: number[] } | null = null;
  for (const off of [guess, guess - 1, guess + 1]) {
    if (off < -OFFSET_LIMIT || off > OFFSET_LIMIT) continue;
    const residuals: number[] = [];
    for (let i = 0; i < n; i++) {
      const uv = Math.min(Math.max(raws[i]! + off * 1000, 0), limUv);
      const pred = Math.floor((uv + 500) / 1000);
      residuals.push(ins[i]! - pred);
    }
    const s = stats(residuals);
    if (
      !best ||
      s.rmsMv < best.rmsMv - 1e-9 ||
      (Math.abs(s.rmsMv - best.rmsMv) <= 1e-9 && s.maxAbsMv < best.maxAbsMv)
    ) {
      best = { offMv: off, ...s, residuals };
    }
  }
  return best;
}

/**
 * 最小二乘求解两个标定量。
 *
 * 算法：
 *   1. 解析初值：对 (pin, in) 做一元回归得 a、b，`g0 = (a/K − 1)·1e6`（K 为理想分压比）；
 *   2. 在 g0 附近按 1 ppm 精扫，每个 gain 下 offset 取条件最优（见 evalAtGain）；
 *   3. 最优落在扫描窗口边缘就倍扩窗口重扫（截断补偿可能很大，初值不可全信）。
 *
 * 为什么 1 ppm 扫掠不会漏最优：scale_q16 对 gain 单调不减、是台阶函数，
 * 台阶之间 pred 完全不变，最小台阶宽度也在几百 ppm 量级；1 ppm 严格细于任何台阶。
 * 复杂度 O(R·N)，R ≤ 200001、N ≤ 32，内层只有整数乘除。
 */
export function fitCalibration(
  points: readonly CalibPoint[],
  adc: AdcCfg,
  divider: DividerCfg,
  vmaxMv: number,
): CalibFitResult {
  const fail = (note: string): CalibFitResult => ({
    ok: false,
    gainPpm: 0,
    offsetMv: 0,
    residualsMv: [],
    rmsMv: 0,
    maxAbsMv: 0,
    note,
  });

  if (points.length === 0) return fail('还没有实测点：先在图上打两个以上的点。');
  if (!(adc.fs > 0) || !(adc.vrefMv > 0)) return fail('参考电压或满量程码值不合法，无法换算。');
  if (!(vmaxMv > 0)) return fail('通道量程为 0，先补上状态表或量程上限。');

  const ins = points.map((p) => p.inMv);
  const codes = points.map((p) => p.code);
  const limUv = vmaxMv * 1000;

  const ratio = dividerRatio(divider);
  if (!(ratio > 0) || !Number.isFinite(ratio)) return fail('分压下臂必须 > 0，当前算不出分压比。');

  /* ---------- 退化：单点 / 所有点同一码值 → 只能解偏置 ---------- */
  const spanCodes = new Set(codes).size > 1;
  if (points.length < 2 || !spanCodes) {
    const scale0 = scaleQ16(adc, divider, { gainPpm: 0, offsetMv: 0 });
    const raws = codes.map((c) => Math.floor((c * scale0) / 65536));
    const best = evalAtGain(raws, ins, limUv);
    if (!best) return fail('无法求解偏置。');
    return {
      ok: true,
      gainPpm: 0,
      offsetMv: best.offMv,
      residualsMv: best.residuals,
      rmsMv: best.rmsMv,
      maxAbsMv: best.maxAbsMv,
      note:
        '只有一个码值可用：斜率无解，gain 固定为 0，只解出了偏置。' +
        '要标增益至少需要两个码值明显不同的点。',
    };
  }

  /* ---------- 1. 解析初值 ---------- */
  const pins = codes.map((c) => pinOf(c, adc));
  const n = pins.length;
  const mx = pins.reduce((s, v) => s + v, 0) / n;
  const my = ins.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (pins[i]! - mx) ** 2;
    sxy += (pins[i]! - mx) * (ins[i]! - my);
  }
  if (!(sxx > 0)) return fail('所有点的码值相同，无法确定斜率。');
  const a = sxy / sxx;
  if (!(a > 0)) {
    return fail('实测电压没有随码值上升（拟合斜率为负）。检查接线、通道号与读数单位（mV 不是 V）。');
  }

  const g0 = clamp(Math.round((a / ratio - 1) * 1e6), -GAIN_LIMIT, GAIN_LIMIT);

  /* ---------- 2. 精扫 ---------- */
  // 先算好 BigInt 底数，避免每个候选都重建大整数：
  //   numerator(g) = vref*1000*(RH+RL)*(1e6+g) = base + step*g
  const baseNum = BigInt(adc.vrefMv) * 1000n * (BigInt(divider.rHighOhm) + BigInt(divider.rLowOhm)) * 1000000n;
  const stepNum = BigInt(adc.vrefMv) * 1000n * (BigInt(divider.rHighOhm) + BigInt(divider.rLowOhm));
  const den = BigInt(adc.fs) * BigInt(divider.rLowOhm) * 1000000n;
  if (den === 0n) return fail('分压下臂为 0，除零。');

  type Best = { gain: number; offMv: number; rmsMv: number; maxAbsMv: number; residuals: number[] };

  /** 在 [lo,hi] 上扫 gain，返回比 cur 更优的解（不修改入参，避免闭包赋值导致的类型收窄问题） */
  const scan = (lo: number, hi: number, cur: Best | null): Best | null => {
    let best = cur;
    let lastQ = -1; // 相邻 g 常常落在同一个 scale_q16 台阶上，结果必然相同，跳过重算
    for (let g = lo; g <= hi; g++) {
      const q16 = ((baseNum + stepNum * BigInt(g)) / den) * 65536n;
      if (q16 <= 0n || q16 >= BigInt(U32_LIMIT)) continue; // C9 不通过的区间直接跳过
      const q = Number(q16);
      if (q === lastQ) continue;
      lastQ = q;
      const raws = codes.map((c) => Math.floor((c * q) / 65536));
      const r = evalAtGain(raws, ins, limUv);
      if (!r) continue;
      if (
        !best ||
        r.rmsMv < best.rmsMv - 1e-9 ||
        (Math.abs(r.rmsMv - best.rmsMv) <= 1e-9 && r.maxAbsMv < best.maxAbsMv)
      ) {
        best = { gain: g, offMv: r.offMv, rmsMv: r.rmsMv, maxAbsMv: r.maxAbsMv, residuals: r.residuals };
      }
    }
    return best;
  };

  let best: Best | null = null;
  let half = 20000;
  for (;;) {
    const lo = Math.max(-GAIN_LIMIT, g0 - half);
    const hi = Math.min(GAIN_LIMIT, g0 + half);
    best = scan(lo, hi, best);
    if (!best) return fail('在 C11 允许的增益范围内找不到可用解（scale_q16 全部溢出 32 位）。');
    // 最优贴在扫描窗口边缘 → 初值不可信，扩窗重扫（最多到 C11 全程）
    if (!(best.gain <= lo || best.gain >= hi)) break;
    if (lo <= -GAIN_LIMIT && hi >= GAIN_LIMIT) break;
    if (half >= GAIN_LIMIT) break;
    half *= 2;
  }

  const solved = best;
  if (!solved) return fail('求解失败：没有得到可用结果。');

  /* ---------- 3. 钳位说明 ---------- */
  const notes: string[] = [];
  if (Math.abs(solved.gain) >= GAIN_LIMIT) {
    notes.push('增益已顶到 C11 的 ±100000 ppm（±10%）边界：多半是分压电阻填错、或实测读数单位不对。');
  }
  if (Math.abs(solved.offMv) >= OFFSET_LIMIT) {
    notes.push('偏置已顶到 C11 的 ±1000 mV 边界：检查零点附近是否存在固定压降（防反二极管、地偏移）。');
  }

  return {
    ok: true,
    gainPpm: solved.gain,
    offsetMv: solved.offMv,
    residualsMv: solved.residuals,
    rmsMv: solved.rmsMv,
    maxAbsMv: solved.maxAbsMv,
    note: notes.length > 0 ? notes.join(' ') : undefined,
  };
}
