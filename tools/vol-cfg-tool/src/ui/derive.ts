/**
 * @file    derive.ts
 * @brief   UI 用的派生展示量：C7 占用率、宏名。判定口径必须与 rules.ts 完全一致，
 *          否则会出现"图上说超了、校验面板没报"这种自相矛盾。
 */
import type { ChannelCfg } from '../model/types';
import { hystDownOf, hystUpOf, stateRange, voltageMaxMvOf } from '../model/types';

export interface C7Usage {
  /** 两侧迟滞合计：S_{k-1}.HYST_UP + S_{k+1}.HYST_DOWN（与 c7_CHk 的左侧一致） */
  left: number;
  width: number;
  /** 0..100+，>= 100 即触发 C7 */
  pct: number;
  /** 参与计算的项，如 ["S0 上行 0", "S2 下行 500"] */
  parts: string[];
}

/**
 * C7 占用率：注意参与计算的是**相邻状态**的迟滞，不是 S_k 自己的。
 * 依据 `c7_CH0_1 = (S0_HYST_UP + S2_HYST_DOWN) < (S1_UPPER - S1_LOWER)`。
 */
export function c7Usage(ch: ChannelCfg, k: number): C7Usage | null {
  const r = stateRange(ch, k);
  if (!r) return null;
  const n = ch.states.mode === 'stateful' ? ch.states.names.length : 0;
  const up = k > 0 ? hystUpOf(ch, k - 1) : 0;
  const down = k < n - 1 ? hystDownOf(ch, k + 1) : 0;
  const width = r.upperMv - r.lowerMv;
  const left = up + down;
  const parts: string[] = [];
  if (k > 0) parts.push(`S${k - 1} 上行 ${up}`);
  if (k < n - 1) parts.push(`S${k + 1} 下行 ${down}`);
  return { left, width, pct: width > 0 ? (left / width) * 100 : 100, parts };
}

export const macroOf = {
  lower: (i: number, k: number) => `VOL_CH${i}_S${k}_LOWER_MV`,
  upper: (i: number, k: number) => `VOL_CH${i}_S${k}_UPPER_MV`,
  hystUp: (i: number, k: number) => `VOL_CH${i}_S${k}_HYST_UP_MV`,
  hystDown: (i: number, k: number) => `VOL_CH${i}_S${k}_HYST_DOWN_MV`,
  scale: (i: number) => `VOL_CH${i}_SCALE_Q16`,
  offset: (i: number) => `VOL_CH${i}_OFFSET_MV`,
  window: (i: number) => `VOL_CH${i}_FILT_WINDOW`,
  vmax: (i: number) => `VOL_CH${i}_VOLTAGE_MAX_MV`,
};

/** 电压带里每个状态的颜色：只按奇偶交替，不暗示语义（名字是用户起的） */
export const BAND_FILL = ['#dbe7fb', '#eef2f8'] as const;

export function bandFill(k: number): string {
  return BAND_FILL[k % BAND_FILL.length]!;
}

/** 电压带坐标：把 mV 映射到 SVG x */
export function makeScale(vmax: number, left: number, right: number): (mv: number) => number {
  const span = vmax > 0 ? vmax : 1;
  return (mv: number) => left + (Math.max(0, Math.min(span, mv)) / span) * (right - left);
}

export { voltageMaxMvOf };
