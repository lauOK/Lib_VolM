/**
 * @file    store.ts
 * @brief   全局状态：useReducer + Context，localStorage 记住上次会话。
 *
 * 权威仍是 vol_cfg.yaml：持久化时存 YAML 文本、恢复时走 parseConfigText 校验，
 * 这样"上次会话"永远是一份合法配置，不会因为代码改了字段而读进半截数据。
 *
 * 所有修改都经过这里，UI 组件不直接改 model——状态数变化要同步维护 names 与
 * boundaries 的长度关系（n 个状态 = n 条边界，末条是量程），这是最容易错的地方。
 */
import { createContext, useContext } from 'react';

import type {
  AdcCfg,
  Boundary,
  CalibCfg,
  CalibPoint,
  ChannelCfg,
  ConfigModel,
  DividerCfg,
  FilterCfg,
  ModuleCfg,
} from '../model/types';
import { voltageMaxMvOf } from '../model/types';
import { presetChannelTemplate, startupModel } from '../model/presets';
import { dividerRatio } from '../core/scale';

export const STORAGE_KEY = 'volm-cfg-tool/model/v1';

export type Action =
  | { type: 'load'; model: ConfigModel }
  | { type: 'module'; patch: Partial<ModuleCfg> }
  | { type: 'channel'; index: number; patch: Partial<ChannelCfg> }
  | { type: 'adc'; index: number; patch: Partial<AdcCfg> }
  | { type: 'divider'; index: number; patch: Partial<DividerCfg> }
  | { type: 'calib'; index: number; patch: Partial<CalibCfg> }
  | { type: 'filter'; index: number; patch: Partial<FilterCfg> }
  | { type: 'stateName'; index: number; k: number; name: string }
  | { type: 'boundary'; index: number; k: number; patch: Partial<Boundary> }
  | { type: 'addState'; index: number }
  | { type: 'removeState'; index: number; k: number }
  | { type: 'addPoint'; index: number }
  | { type: 'removePoint'; index: number; k: number }
  | { type: 'patchPoint'; index: number; k: number; patch: Partial<CalibPoint> }
  | { type: 'clearPoints'; index: number }
  | { type: 'setMode'; index: number; mode: 'stateful' | 'measure_only' }
  | { type: 'addChannel' }
  | { type: 'removeChannel'; index: number }
  | { type: 'moveChannel'; index: number; delta: number };

/* ==========================================================================
 * 状态表的增删：必须同时维护 names 与 boundaries（n ↔ n）
 * ========================================================================== */

/** 在末尾追加一个状态：把原量程端点变成内部边界，量程上抬一档 */
function addState(ch: ChannelCfg): ChannelCfg {
  if (ch.states.mode !== 'stateful') return ch;
  const { names, boundaries } = ch.states;
  const n = names.length;
  const vmax = boundaries[n - 1]?.upperMv ?? 0;
  // 新增状态需要一段新区间；上抬量程，步长取 10% 但至少 1 mV，且不越过 65535
  const step = Math.max(1, Math.min(65535 - vmax, Math.round(vmax * 0.1) || 1000));
  if (step < 1) return ch;
  const next: Boundary[] = [
    ...boundaries.slice(0, n - 1),
    { upperMv: vmax, hystUpMv: 0, hystDownMv: 0 },
    { upperMv: vmax + step, hystUpMv: 0, hystDownMv: 0 },
  ];
  return {
    ...ch,
    states: { mode: 'stateful', names: [...names, `状态${n + 1}`], boundaries: next },
  };
}

/** 删除第 k 个状态：删末状态时，原 b_{n-1} 顶上成为新的量程端点 */
function removeState(ch: ChannelCfg, k: number): ChannelCfg {
  if (ch.states.mode !== 'stateful') return ch;
  const { names, boundaries } = ch.states;
  const n = names.length;
  if (n <= 1 || k < 0 || k >= n) return ch;

  const nextNames = names.filter((_, i) => i !== k);
  let nextB: Boundary[];
  if (k === n - 1) {
    nextB = boundaries.slice(0, n - 1).map((b, i, arr) =>
      i === arr.length - 1 ? { ...b, hystUpMv: 0, hystDownMv: 0 } : b,
    );
  } else {
    nextB = boundaries.filter((_, i) => i !== k);
  }
  return { ...ch, states: { mode: 'stateful', names: nextNames, boundaries: nextB } };
}

/** 切到仅测量：量程从 b_n 搬到通道级字段，否则切完量程会丢 */
function toMeasureOnly(ch: ChannelCfg): ChannelCfg {
  if (ch.states.mode === 'measure_only') return ch;
  const n = ch.states.names.length;
  const vmax = ch.states.boundaries[n - 1]?.upperMv ?? ch.voltageMaxMv ?? 12000;
  return { ...ch, voltageMaxMv: vmax, states: { mode: 'measure_only' } };
}

/** 切回状态机：先给一个覆盖全量程的单状态，用户再往下加边界 */
function toStateful(ch: ChannelCfg): ChannelCfg {
  if (ch.states.mode === 'stateful') return ch;
  const vmax = ch.voltageMaxMv ?? 12000;
  const next: ChannelCfg = {
    ...ch,
    states: { mode: 'stateful', names: ['正常'], boundaries: [{ upperMv: vmax, hystUpMv: 0, hystDownMv: 0 }] },
  };
  delete next.voltageMaxMv;
  return next;
}

function newChannel(): ChannelCfg {
  return presetChannelTemplate();
}

/* ==========================================================================
 * 标定实测点：可选字段，删空要还原成 undefined（否则 yaml 会写出空数组）
 * ========================================================================== */

/** 单通道最多几个实测点：再多拟合收益为零，只会把图挤乱 */
export const MAX_POINTS = 32;

/**
 * 追加一个点，默认落在量程 60% 处。
 *
 * 为什么不放 0 或满量程：两端分别受"限幅"和"零点"影响，默认值一放上去就是最差的位置，
 * 用户还得先挪开才能看到蓝线。60% 处在正常线性段，加完立刻能看见偏差。
 */
function addPoint(ch: ChannelCfg): ChannelCfg {
  const pts = ch.calibPoints ?? [];
  if (pts.length >= MAX_POINTS) return ch;

  const vmax = voltageMaxMvOf(ch);
  const ratio = dividerRatio(ch.divider);
  const targetMv = vmax > 0 ? Math.round(vmax * 0.6) : 0;
  const pinMv = ratio > 0 && Number.isFinite(ratio) ? targetMv / ratio : ch.adc.vrefMv / 2;
  const code = Math.max(
    0,
    Math.min(ch.adc.fs, Math.round((pinMv / (ch.adc.vrefMv || 1)) * ch.adc.fs)),
  );
  // 实测值先按"当前理论值"填：这个码值处蓝线正好穿过红点（初始残差为 0），
  // 用户把它改成万用表读数后，点与蓝线的偏差立刻显现
  return { ...ch, calibPoints: [...pts, { code, inMv: targetMv }] };
}

function removePoint(ch: ChannelCfg, k: number): ChannelCfg {
  const pts = ch.calibPoints ?? [];
  if (k < 0 || k >= pts.length) return ch;
  const next = pts.filter((_, i) => i !== k);
  // 删空 → 整个字段消失，yaml 里连键都不出现
  return { ...ch, calibPoints: next.length > 0 ? next : undefined };
}

function patchPoint(ch: ChannelCfg, k: number, patch: Partial<CalibPoint>): ChannelCfg {
  const pts = ch.calibPoints;
  if (!pts || k < 0 || k >= pts.length) return ch;
  const next = pts.map((p, i) =>
    i === k
      ? {
          // 模型层强制取整：NumInput 的草稿态可能短暂出现小数，而 yaml 只收整数
          code: Math.round(patch.code ?? p.code),
          inMv: Math.round(patch.inMv ?? p.inMv),
        }
      : p,
  );
  return { ...ch, calibPoints: next };
}

/* ==========================================================================
 * reducer
 * ========================================================================== */

function withChannel(
  model: ConfigModel,
  index: number,
  fn: (ch: ChannelCfg) => ChannelCfg,
): ConfigModel {
  return {
    ...model,
    channels: model.channels.map((ch, i) => (i === index ? fn(ch) : ch)),
  };
}

export function reducer(model: ConfigModel, a: Action): ConfigModel {
  switch (a.type) {
    case 'load':
      return a.model;
    case 'module':
      return { ...model, module: { ...model.module, ...a.patch } };
    case 'channel':
      return withChannel(model, a.index, (ch) => ({ ...ch, ...a.patch }));
    case 'adc':
      return withChannel(model, a.index, (ch) => ({ ...ch, adc: { ...ch.adc, ...a.patch } }));
    case 'divider':
      return withChannel(model, a.index, (ch) => ({ ...ch, divider: { ...ch.divider, ...a.patch } }));
    case 'calib':
      return withChannel(model, a.index, (ch) => ({ ...ch, calib: { ...ch.calib, ...a.patch } }));
    case 'filter':
      return withChannel(model, a.index, (ch) => ({ ...ch, filter: { ...ch.filter, ...a.patch } }));
    case 'stateName':
      return withChannel(model, a.index, (ch) => {
        if (ch.states.mode !== 'stateful') return ch;
        const names = ch.states.names.map((v, i) => (i === a.k ? a.name : v));
        return { ...ch, states: { ...ch.states, names } };
      });
    case 'boundary':
      return withChannel(model, a.index, (ch) => {
        if (ch.states.mode !== 'stateful') return ch;
        const boundaries = ch.states.boundaries.map((b, i) =>
          i === a.k ? { ...b, ...a.patch } : b,
        );
        return { ...ch, states: { ...ch.states, boundaries } };
      });
    case 'addState':
      return withChannel(model, a.index, addState);
    case 'removeState':
      return withChannel(model, a.index, (ch) => removeState(ch, a.k));
    case 'addPoint':
      return withChannel(model, a.index, addPoint);
    case 'removePoint':
      return withChannel(model, a.index, (ch) => removePoint(ch, a.k));
    case 'patchPoint':
      return withChannel(model, a.index, (ch) => patchPoint(ch, a.k, a.patch));
    case 'clearPoints':
      return withChannel(model, a.index, (ch) => ({ ...ch, calibPoints: undefined }));
    case 'setMode':
      return withChannel(model, a.index, (ch) =>
        a.mode === 'measure_only' ? toMeasureOnly(ch) : toStateful(ch),
      );
    case 'addChannel':
      return { ...model, channels: [...model.channels, newChannel()] };
    case 'removeChannel':
      return { ...model, channels: model.channels.filter((_, i) => i !== a.index) };
    case 'moveChannel': {
      const to = a.index + a.delta;
      if (to < 0 || to >= model.channels.length) return model;
      const channels = [...model.channels];
      const [hit] = channels.splice(a.index, 1);
      channels.splice(to, 0, hit!);
      return { ...model, channels };
    }
  }
}

/* ==========================================================================
 * Context
 * ========================================================================== */

export interface CfgStore {
  model: ConfigModel;
  dispatch: (a: Action) => void;
}

export const CfgCtx = createContext<CfgStore | null>(null);

export function useCfg(): CfgStore {
  const v = useContext(CfgCtx);
  if (!v) throw new Error('CfgCtx 未提供');
  return v;
}

/** 路径 → 严重级别，用于给输入框标红；路径口径与 rules.ts / schema.ts 一致 */
export const DiagCtx = createContext<Map<string, 'error' | 'warning'>>(new Map());

export function useDiagFlag(path: string): 'error' | 'warning' | undefined {
  return useContext(DiagCtx).get(path);
}

/** 统计某个前缀（如 `channels[0]`）下的错误/警告条数，用于卡片头部徽标 */
export function useDiagCount(prefix: string): { errors: number; warns: number } {
  const map = useContext(DiagCtx);
  let errors = 0;
  let warns = 0;
  for (const [p, s] of map) {
    if (p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`)) {
      if (s === 'error') errors++;
      else warns++;
    }
  }
  return { errors, warns };
}

/** 初始状态：localStorage 里恢复（走同一套 schema 校验）；没有存档则 1 个预设通道起步 */
export function initModel(read: (key: string) => string | null, parse: (t: string) => ConfigModel | null): ConfigModel {
  try {
    const raw = read(STORAGE_KEY);
    if (raw) {
      const m = parse(raw);
      if (m) return m;
    }
  } catch {
    /* 隐私模式 / 配额异常：从默认单通道开始 */
  }
  return startupModel();
}
