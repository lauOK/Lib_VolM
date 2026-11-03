/**
 * @file    h.ts
 * @brief   生成 inc/vol_cfg.h：固定骨架 + 模块级宏 + 每通道宏块 + 派生量定义。
 *
 * 输出结构与库现有文件保持一致（宏值第 41 列、行尾注释第 53 列），
 * 使"12 V 示例配置"生成结果与手写原件在代码层完全一致。
 */
import type { ChannelCfg, ConfigModel } from '../../model/types';
import {
  hystDownOf,
  hystUpOf,
  shortName,
  stateCount,
  stateName,
  stateRange,
  voltageMaxMvOf,
} from '../../model/types';
import { downThresholdMv, filterWindow, upThresholdMv } from '../scale';
import { adcBits, def, fmtKohm, fmtVolt1, fmtVoltTrim, padTo, signed } from './pad';
import {
  H_SEG_A,
  H_SEG_B,
  H_SEG_C,
  H_SEG_D,
  H_SEG_E,
  H_SEG_F,
  H_SEG_G,
  H_SEG_H,
  H_TAIL_A,
  H_TAIL_B,
} from './skeleton';

const DASH_OPEN = `/* ${'-'.repeat(74)}`;
const DASH_CLOSE = ` * ${'-'.repeat(72)} */`;

/** 通道 banner 的说明行：优先用配置里的 comment，否则按参数自动拼一句 */
function channelCommentLines(i: number, ch: ChannelCfg): string[] {
  if (ch.comment && ch.comment.trim() !== '') return ch.comment.split('\n');
  const bits = adcBits(ch.adc.fs);
  const n = stateCount(ch);
  const head =
    `通道 ${i}：${ch.name}，分压 ${fmtKohm(ch.divider.rHighOhm)} / ${fmtKohm(ch.divider.rLowOhm)}，` +
    `${bits ? `${bits} 位 ADC，` : ''}${fmtVoltTrim(ch.adc.vrefMv)} V 参考，` +
    (n > 0 ? `${n} 个状态` : '仅测量通道');
  return n > 0
    ? [head]
    : [head, '仅测量通道：只做「换算 + 滤波 + 提供电压」，不管理状态。'];
}

/** 上/下行迟滞的注释：把"门限 = 边界 ± 迟滞"直接写在宏后面，避免方向误读 */
function hystUpNote(i: number, ch: ChannelCfg, n: number): string | undefined {
  const hyst = hystUpOf(ch, i);
  if (hyst > 0) {
    const range = stateRange(ch, i);
    if (!range) return undefined;
    const next = shortName(stateName(ch, i + 1));
    return `/* ${fmtVolt1(upThresholdMv(range.upperMv, hyst))} V 才进${next} */`;
  }
  if (i === n - 1) return '/* 末状态，外边界无定义 */';
  if (i === 0) return '/* 首状态，外边界无定义 */';
  return undefined;
}

function hystDownNote(i: number, ch: ChannelCfg, n: number): string | undefined {
  const hyst = hystDownOf(ch, i);
  if (hyst > 0) {
    const range = stateRange(ch, i);
    if (!range) return undefined;
    const prev = shortName(stateName(ch, i - 1));
    const verb = i === n - 1 ? '才回' : '才掉回';
    return `/* ${fmtVolt1(downThresholdMv(range.lowerMv, hyst))} V ${verb}${prev} */`;
  }
  if (i === 0) return '/* 首状态，外边界无定义 */';
  return undefined;
}

function filtArgComment(ch: ChannelCfg, periodMs: number): string {
  if (ch.filter.mode === 'by_time') {
    const w = filterWindow(ch.filter, periodMs);
    return `/* ${ch.filter.arg} ms，按 ${periodMs} ms 采样 → ${w} 点 */`;
  }
  return `/* ${ch.filter.arg} 个采样点 */`;
}

/** 单通道宏块（含 banner 注释、9 个通道宏、状态数、若干状态宏），末尾带一个空行 */
function channelBlockH(i: number, ch: ChannelCfg, periodMs: number): string {
  const p = `VOL_CH${i}_`;
  const n = stateCount(ch);
  const vmax = voltageMaxMvOf(ch);
  const L: string[] = [];

  L.push(DASH_OPEN);
  for (const line of channelCommentLines(i, ch)) L.push(` * ${line}`);
  L.push(DASH_CLOSE);

  const bits = adcBits(ch.adc.fs);
  L.push(def(`${p}ADC_FS`, ch.adc.fs, bits ? `/* ${bits} 位 ADC 满量程码值 */` : '/* ADC 满量程码值 */'));
  L.push(def(`${p}VREF_MV`, ch.adc.vrefMv, '/* 参考电压 mV */'));
  L.push(
    def(
      `${p}R_HIGH_OHM`,
      ch.divider.rHighOhm,
      `/* 上臂 ${fmtKohm(ch.divider.rHighOhm)}，填 ${ch.divider.rHighOhm}（单位 Ω） */`,
    ),
  );
  L.push(
    def(
      `${p}R_LOW_OHM`,
      ch.divider.rLowOhm,
      `/* 下臂 ${fmtKohm(ch.divider.rLowOhm)}，填 ${ch.divider.rLowOhm}（单位 Ω） */`,
    ),
  );
  L.push(
    def(
      `${p}GAIN_PPM`,
      ch.calib.gainPpm,
      ch.calib.gainPpm !== 0 ? `/* 增益标定残差 ${signed(ch.calib.gainPpm)} ppm */` : undefined,
    ),
  );
  L.push(
    def(
      `${p}OFFSET_MV`,
      ch.calib.offsetMv < 0 ? `(${ch.calib.offsetMv})` : ch.calib.offsetMv,
      ch.calib.offsetMv !== 0 ? `/* 偏置标定残差 ${signed(ch.calib.offsetMv)} mV */` : undefined,
    ),
  );
  L.push(def(`${p}FILT_MODE`, ch.filter.mode === 'by_time' ? 'VOL_FILT_BY_TIME' : 'VOL_FILT_BY_SAMPLE'));
  L.push(def(`${p}FILT_ARG`, ch.filter.arg, filtArgComment(ch, periodMs)));
  L.push(
    def(
      `${p}VOLTAGE_MAX_MV`,
      vmax,
      ch.states.mode === 'stateful'
        ? `/* 本通道量程 ${fmtVoltTrim(vmax)} V（= b${n}，限幅 + C4） */`
        : `/* 本通道量程 ${fmtVoltTrim(vmax)} V（限幅 + C4） */`,
    ),
  );
  L.push('');

  L.push(def(`${p}STATE_NUM`, n, n === 0 ? '/* 0 = 仅测量通道（RBIN） */' : undefined));

  if (ch.states.mode === 'stateful') {
    L.push('');
    for (let s = 0; s < n; s++) {
      const range = stateRange(ch, s);
      if (!range) continue;
      L.push(
        `/* 状态 ${s}：${stateName(ch, s)}   ${fmtVoltTrim(range.lowerMv)} ~ ${fmtVoltTrim(range.upperMv)} V */`,
      );
      L.push(def(`${p}S${s}_LOWER_MV`, range.lowerMv));
      L.push(def(`${p}S${s}_UPPER_MV`, range.upperMv));
      L.push(def(`${p}S${s}_HYST_UP_MV`, hystUpOf(ch, s), hystUpNote(s, ch, n)));
      L.push(def(`${p}S${s}_HYST_DOWN_MV`, hystDownOf(ch, s), hystDownNote(s, ch, n)));
      if (s < n - 1) L.push('');
    }
  }

  return L.join('\n') + '\n\n';
}

/** 生成 inc/vol_cfg.h 全文 */
export function emitH(model: ConfigModel): string {
  const m = model.module;
  const channels = model.channels;

  let out = H_SEG_A;
  out += def('VOL_CHANNEL_NUM', channels.length) + '\n';
  out += H_SEG_B;
  out += def('VOL_ADC_SAMPLE_PERIOD_MS', m.samplePeriodMs) + '\n';
  out += H_SEG_C;
  out += def('VOL_FILTER_WINDOW_MAX', m.filterWindowMax) + '\n';
  out += H_SEG_D;
  out += def('VOL_STATE_NUM_MAX', m.stateNumMax) + '\n';
  out += H_SEG_E;
  out += def('VOL_CHANNEL_NUM_MAX', m.channelNumMax) + '\n';
  out += H_SEG_F;
  out += def('VOL_R_MAX_OHM', m.rMaxOhm) + '\n';
  out += H_SEG_G;
  out += ` * 2. 通道级配置（架构 §3.3${m.comment ? `，${m.comment}` : ''}）\n`;
  out += H_SEG_H;

  for (let i = 0; i < channels.length; i++) {
    out += channelBlockH(i, channels[i]!, m.samplePeriodMs);
  }

  out += H_TAIL_A;
  for (let i = 0; i < channels.length; i++) {
    out +=
      padTo(`#define VOL_CH${i}_FILT_WINDOW`, 33) +
      `VOL_FILT_WINDOW_CALC(VOL_CH${i}_FILT_MODE, VOL_CH${i}_FILT_ARG)\n`;
  }
  out += H_TAIL_B;

  return out;
}
