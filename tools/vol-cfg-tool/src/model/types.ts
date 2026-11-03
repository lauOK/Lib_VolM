/**
 * @file    types.ts
 * @brief   配置模型：与 vol_cfg.yaml 一一对应，是生成器的唯一输入。
 *
 * 设计原则：
 *   - 模型只描述"用户能决定的东西"，派生量（scale_q16、window、门限）一律现算；
 *   - 状态表采用"边界中心"表示：n 个状态把电压轴切成 n+1 个点，
 *     首端 b0 恒为 0 不存（C3 天然满足），b1..bn 全存（C4 天然满足，bn 即量程上限）。
 */

/**
 * 配置文件格式版本号。定义在 src/version.ts（与工具版本、兼容性判定放在一起），
 * 这里转出去，让模型层与生成器的既有引用不必改路径。
 */
export { SCHEMA_VERSION, SCHEMA_VERSION_NUM, TOOL_NAME, TOOL_VERSION } from '../version';

/** 滤波配置模式：按时间(ms) / 按采样点数 */
export type FilterMode = 'by_time' | 'by_sample';

/** 模块级配置（对应 vol_cfg.h §1） */
export interface ModuleCfg {
  /** 期望采样周期 ms，仅 by_time 模式用于窗口换算，须 >= 1 */
  samplePeriodMs: number;
  /** 单通道滤波窗口上限（仅用于断言），1..1024 */
  filterWindowMax: number;
  /** 单通道状态数上限（仅用于断言），1..12 */
  stateNumMax: number;
  /** 通道数上限（仅用于断言） */
  channelNumMax: number;
  /** 分压电阻上限 Ω（仅用于断言） */
  rMaxOhm: number;
  /** 可选：追加到生成文件"2. 通道级配置"标题行括号内的说明 */
  comment?: string;
}

export interface AdcCfg {
  /** ADC 满量程码值，12 位填 4095 */
  fs: number;
  /** ADC 参考电压 mV */
  vrefMv: number;
}

export interface DividerCfg {
  /** 分压上臂 Ω（不是 kΩ） */
  rHighOhm: number;
  /** 分压下臂 Ω（不是 kΩ），须 > 0 */
  rLowOhm: number;
}

export interface CalibCfg {
  /** 增益标定残差 ppm，修正量，实测偏低为正 */
  gainPpm: number;
  /** 偏置标定残差 mV */
  offsetMv: number;
}

/**
 * 一个标定实测点：ADC 原始码值 + 万用表实测的**输入总电压**。
 *
 * 为什么存这两个数而不是"引脚电压"：码值是 ADC 的原始输出，总电压是独立测得的真值，
 * 两者都不依赖任何既有标定值，拟合时不会形成循环依赖。引脚电压是派生量
 * （`code / fs * vref`），UI 上只读显示，供与万用表在引脚处读数对照。
 *
 * 两个字段都是整数：mV 粒度（万用表读数取整），避免 yaml 里出现小数带来的
 * 浮点序列化与 roundtrip 逐字节问题。
 */
export interface CalibPoint {
  /** ADC 原始码值，0..fs */
  code: number;
  /** 万用表实测的输入总电压 mV */
  inMv: number;
}

export interface FilterCfg {
  mode: FilterMode;
  /** by_time 时单位为 ms；by_sample 时单位为采样点数 */
  arg: number;
}

/**
 * 一条边界 b_i（i = 1..n），存在 `boundaries[i-1]`。
 *
 * n 个状态把电压轴切成 n+1 个点，首端 b_0 = 0 由规则隐含不存，因此只存 b_1..b_n：
 *   - b_1..b_{n-1}：相邻状态的分界，`S_{i-1}.upper = S_i.lower = b_i`，带两个迟滞；
 *   - b_n：量程上限 `= S_{n-1}.upper`，生成 `VOLTAGE_MAX_MV`；末状态没有上侧邻居，
 *     两个迟滞恒为 0（C10），配置里可以省略。
 *
 * 两条迟滞分别归属两侧状态，这与库的门限定义一致：
 *   上行门限 = upperMv + hystUpMv   （S_{i-1} 向上离开，宏 S_{i-1}_HYST_UP）
 *   下行门限 = upperMv - hystDownMv （S_i 向下离开，宏 S_i_HYST_DOWN）
 */
export interface Boundary {
  upperMv: number;
  /** 归低侧状态 S_{i-1}；b_n 恒为 0 */
  hystUpMv: number;
  /** 归高侧状态 S_i；b_n 恒为 0 */
  hystDownMv: number;
}

/** 仅测量通道（RBIN）：STATE_NUM = 0，只换算 + 滤波 + 提供电压 */
export interface MeasureOnlyStates {
  mode: 'measure_only';
}

/** 状态通道：names.length = n，boundaries.length = n（b1..bn，最后一条是量程上限） */
export interface StatefulStates {
  mode: 'stateful';
  names: string[];
  boundaries: Boundary[];
}

export type StatesCfg = MeasureOnlyStates | StatefulStates;

export interface ChannelCfg {
  /** 通道短名，进状态注释与默认短语，如 "KL30 常电" */
  name: string;
  /** 可选：通道 banner 的多行说明；留空则按参数自动生成 */
  comment?: string;
  adc: AdcCfg;
  divider: DividerCfg;
  calib: CalibCfg;
  /**
   * 可选：标定实测点。用于拟合 gainPpm / offsetMv，并在生成的 C 文件 banner 里
   * 留一行标定摘要。纯新增可选字段，不升格式号；为空或未定义时 yaml 整段不出现
   * （连省略注释都不写，保证既有配置的导出逐字节不变）。
   */
  calibPoints?: CalibPoint[];
  filter: FilterCfg;
  /**
   * 量程上限 mV，同时是限幅上限。
   * **仅 measure_only 通道需要**（没有状态表，无处安放 b_n）；stateful 通道的量程
   * 来自 `states.boundaries` 最后一条，本字段必须省略——避免同一个数存两处。
   */
  voltageMaxMv?: number;
  states: StatesCfg;
}

export interface ConfigModel {
  schema: string;
  module: ModuleCfg;
  channels: ChannelCfg[];
}

/* ==========================================================================
 * 诊断信息（P2 的配置文件结构错误 + P3 的业务规则共用同一结构）
 * ========================================================================== */

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  /**
   * 规则编号：
   *   F1~F6  配置文件本身的问题（语法 / 版本 / 未知键 / 缺键 / 类型 / 长度）
   *          F2 也负责格式版本的兼容性：文件格式号比本工具新 → 直接报错，不做向上兼容
   *   C1~C11 库的编译期断言规则
   *   W1~W8  工程建议（不阻止生成）
   */
  code: string;
  /** 字段路径，如 `channels[0].adc.fs`；顶层为空串 */
  path: string;
  message: string;
}

/* ==========================================================================
 * 派生访问器（生成器与 UI 共用，保证两边算法完全一致）
 * ========================================================================== */

/** 状态数 n；仅测量通道为 0 */
export function stateCount(ch: ChannelCfg): number {
  return ch.states.mode === 'stateful' ? ch.states.names.length : 0;
}

/** 第 i 个状态的名称 */
export function stateName(ch: ChannelCfg, i: number): string {
  return ch.states.mode === 'stateful' ? (ch.states.names[i] ?? `S${i}`) : '';
}

/** 注释里用的短名："严重欠压 / 断线" → "严重欠压" */
export function shortName(name: string): string {
  return (name.split('/')[0] ?? name).trim();
}

/**
 * 本通道量程上限 mV（= 生成的 VOLTAGE_MAX_MV）。
 * stateful 通道取 b_n（boundaries 最后一条），measure_only 通道取通道级字段。
 */
export function voltageMaxMvOf(ch: ChannelCfg): number {
  if (ch.states.mode === 'stateful') {
    const n = ch.states.names.length;
    return ch.states.boundaries[n - 1]?.upperMv ?? 0;
  }
  return ch.voltageMaxMv ?? 0;
}

/** 第 i 个状态的区间 [lower, upper)；仅测量通道返回 null */
export function stateRange(ch: ChannelCfg, i: number): { lowerMv: number; upperMv: number } | null {
  if (ch.states.mode !== 'stateful') return null;
  const n = ch.states.names.length;
  if (i < 0 || i >= n) return null;
  const lowerMv = i === 0 ? 0 : ch.states.boundaries[i - 1]!.upperMv;
  const upperMv = ch.states.boundaries[i]!.upperMv;
  return { lowerMv, upperMv };
}

/** S_i.HYST_UP：末状态没有上侧邻居，恒为 0（C10） */
export function hystUpOf(ch: ChannelCfg, i: number): number {
  if (ch.states.mode !== 'stateful') return 0;
  return i < ch.states.names.length - 1 ? ch.states.boundaries[i]!.hystUpMv : 0;
}

/** S_i.HYST_DOWN：首状态没有下侧邻居，恒为 0（C10） */
export function hystDownOf(ch: ChannelCfg, i: number): number {
  if (ch.states.mode !== 'stateful' || i === 0) return 0;
  return ch.states.boundaries[i - 1]!.hystDownMv;
}
