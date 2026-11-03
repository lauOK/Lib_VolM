/**
 * @file    c.ts
 * @brief   生成 src/vol_cfg.c：滤波缓冲、状态阈值表、通道配置表与全部编译期断言。
 *
 * 这是"必须一起生成"的那一半：状态数一变，c4 索引、n-1 条 c5、n 条 c6、n 条 c7 与
 * c10 的末状态索引全都要跟着变，人手改必漏。断言按状态数分档生成：
 *   n = 0  仅测量通道，整块不生成
 *   n = 1  C5/C7 退化（与 C6 重复），省略
 *   n >= 2 全量生成
 */
import type { ChannelCfg, ConfigModel } from '../../model/types';
import { stateCount, stateRange, voltageMaxMvOf } from '../../model/types';
import { evalResiduals } from '../calibrate';
import { padTo, signed } from './pad';
import { C_PRE, C_TABLE_PRE } from './skeleton';

const TOOL_NOTICE = [
  '/* --------------------------------------------------------------------------',
  ' * 本文件由 vol-cfg-tool 生成，配置源为 vol_cfg.yaml，请勿手工修改。',
  ' * 改配置请回工具里改（或改 yaml）后重新生成并覆盖本文件。',
  ' * ------------------------------------------------------------------------ */',
];

const EQ_OPEN = `/* ${'='.repeat(74)}`;
const EQ_CLOSE = ` * ${'='.repeat(74)} */`;

/**
 * 标定摘要行（纯注释）。没有实测点就返回 null —— presetLibrary 等基准配置
 * 因此一个字符都不会变，黄金比对不受影响。
 *
 * 残差是**当前 calib 对存档点的评估**，不是重新拟合：手改了两个残差再生成，
 * 这里会如实写出偏差有多大，正好当作"改了之后还准不准"的自检。
 */
function calibNoteC(ch: ChannelCfg): string | null {
  const pts = ch.calibPoints;
  if (!pts || pts.length === 0) return null;
  const vmax = voltageMaxMvOf(ch);
  if (!(vmax > 0)) return null;
  const r = evalResiduals(pts, ch.adc, ch.divider, ch.calib, vmax);
  return (
    ` * 标定：${pts.length} 点实测拟合，最大残差 ${r.maxAbsMv} mV（RMS ${Math.round(r.rmsMv)} mV）` +
    ` → gain ${signed(ch.calib.gainPpm)} ppm / offset ${signed(ch.calib.offsetMv)} mV`
  );
}

/** 通道 banner：状态通道列出全部区间，仅测量通道写明为什么没有状态表 */
function channelBannerC(i: number, ch: ChannelCfg): string[] {
  const n = stateCount(ch);
  const calib = calibNoteC(ch);
  if (n === 0) {
    return [
      ` * 通道 ${i}：仅测量通道（${ch.name}），STATE_NUM = 0`,
      ` * 不定义任何 VOL_CH${i}_S<i>_* 宏，状态表与状态断言整体被条件编译跳过。`,
      ...(calib ? [calib] : []),
    ];
  }
  const ranges: string[] = [];
  for (let s = 0; s < n; s++) {
    const r = stateRange(ch, s);
    if (r) ranges.push(`[${r.lowerMv},${r.upperMv})`);
  }
  return [
    ` * 通道 ${i}：${n} 个状态，状态区间 ${ranges.join(' ')}`,
    ...(calib ? [calib] : []),
  ];
}

/** 状态阈值表 + STATE_CFG 派生（构造保证 state_num 与 state_cfg 同源） */
function stateTableC(i: number, n: number): string[] {
  const L: string[] = [];
  L.push(`#if (VOL_CH${i}_STATE_NUM > 0)`);
  if (n === 0) {
    L.push('/* 本通道在 vol_cfg.yaml 中配置为仅测量通道（STATE_NUM = 0），没有状态宏可用。');
    L.push(' * 若要启用状态管理，请在工具中改成 stateful 后重新生成，不要手改本文件。 */');
    L.push(`#error "VOL_CH${i}_STATE_NUM > 0 与本通道配置矛盾：请用 vol-cfg-tool 重新生成"`);
  } else {
    L.push(`static const Vol_StateCfgType vol_ch${i}_states[VOL_CH${i}_STATE_NUM] =`);
    L.push('{');
    for (let s = 0; s < n; s++) {
      const tail = s < n - 1 ? ',' : '';
      L.push(
        `    { VOL_CH${i}_S${s}_LOWER_MV, VOL_CH${i}_S${s}_UPPER_MV, ` +
          `VOL_CH${i}_S${s}_HYST_UP_MV, VOL_CH${i}_S${s}_HYST_DOWN_MV }${tail}`,
      );
    }
    L.push('};');
    L.push(`#define VOL_CH${i}_STATE_CFG   vol_ch${i}_states`);
  }
  L.push('#else');
  L.push(`#define VOL_CH${i}_STATE_CFG   NULL`);
  L.push('#endif');
  return L;
}

/** C3~C10 状态断言块（按 n 分档） */
function stateAssertsC(i: number, n: number): string[] {
  const L: string[] = [];
  const P = `VOL_CH${i}_`;

  L.push(`#if (VOL_CH${i}_STATE_NUM > 0)`);
  L.push('/* C3 / C4：覆盖本通道量程的上下两端 */');
  L.push(`VOL_STATIC_ASSERT((${P}S0_LOWER_MV) == 0, c3_CH${i}_first_lower);`);
  L.push(`VOL_STATIC_ASSERT((${P}S${n - 1}_UPPER_MV) == (${P}VOLTAGE_MAX_MV), c4_CH${i}_last_upper);`);
  L.push('');

  if (n >= 2) {
    L.push('/* C5：相邻状态无缝隙、无重叠 */');
    for (let s = 0; s < n - 1; s++) {
      L.push(`VOL_STATIC_ASSERT((${P}S${s}_UPPER_MV) == (${P}S${s + 1}_LOWER_MV), c5_CH${i}_${s});`);
    }
    L.push('');
  }

  L.push('/* C6：区间非退化 */');
  for (let s = 0; s < n; s++) {
    L.push(`VOL_STATIC_ASSERT((${P}S${s}_LOWER_MV) < (${P}S${s}_UPPER_MV), c6_CH${i}_${s});`);
  }
  L.push('');

  if (n >= 2) {
    L.push('/* C7：hyst_up_{i-1} + hyst_down_{i+1} < (upper_i - lower_i)，越界项按 0 计 */');
    for (let s = 0; s < n; s++) {
      let left: string;
      if (s === 0) left = `0 + ${P}S1_HYST_DOWN_MV`;
      else if (s === n - 1) left = `${P}S${n - 2}_HYST_UP_MV + 0`;
      else left = `${P}S${s - 1}_HYST_UP_MV + ${P}S${s + 1}_HYST_DOWN_MV`;
      L.push(
        `VOL_STATIC_ASSERT(((${left}) < ((${P}S${s}_UPPER_MV) - (${P}S${s}_LOWER_MV))), c7_CH${i}_${s});`,
      );
    }
    L.push('');
  }

  L.push('/* C10：首末状态的外侧边界没有对应状态，迟滞必须为 0 */');
  L.push(`VOL_STATIC_ASSERT((${P}S0_HYST_DOWN_MV) == 0, c10_CH${i}_first_down);`);
  L.push(`VOL_STATIC_ASSERT((${P}S${n - 1}_HYST_UP_MV) == 0, c10_CH${i}_last_up);`);
  L.push(`#endif /* VOL_CH${i}_STATE_NUM > 0 */`);
  return L;
}

/** 单通道代码块，末尾带一个空行 */
function channelBlockC(i: number, ch: ChannelCfg): string {
  const n = stateCount(ch);
  const L: string[] = [];

  L.push(EQ_OPEN);
  L.push(...channelBannerC(i, ch));
  L.push(EQ_CLOSE);
  L.push(`#if (VOL_CHANNEL_NUM > ${i})`);
  L.push('');
  L.push('/** 滤波缓冲：窗口深度由配置宏在编译期算出 */');
  L.push(`static Vol_FilterSampleType vol_ch${i}_buf[VOL_CH${i}_FILT_WINDOW];`);
  L.push('');
  L.push(...stateTableC(i, n));
  L.push('');
  L.push(`VOL_ASSERT_CH_COMMON(CH${i})`);
  L.push('');
  if (n > 0) {
    L.push(...stateAssertsC(i, n));
    L.push('');
  }
  L.push(`#endif /* VOL_CHANNEL_NUM > ${i} */`);

  return L.join('\n') + '\n\n';
}

/** 配置表单条表项 */
function tableEntryC(i: number, last: boolean): string[] {
  const L: string[] = [];
  const row = (s: string, c: string) => padTo(`        ${s}`, 45) + c;
  L.push(`#if (VOL_CHANNEL_NUM > ${i})`);
  L.push('    {');
  L.push(row(`VOL_CH_SCALE_Q16(CH${i}),`, '/* scale_q16 */'));
  L.push(row(`VOL_CH_OFFSET_UV(CH${i}),`, '/* offset_uv */'));
  L.push(row(`(uint16_t)VOL_CH${i}_VOLTAGE_MAX_MV,`, '/* voltage_max_mv */'));
  L.push(row(`(uint16_t)VOL_CH${i}_FILT_WINDOW,`, '/* window */'));
  L.push(row(`(uint8_t)VOL_CH${i}_STATE_NUM,`, '/* state_num */'));
  L.push(row(`VOL_CH${i}_STATE_CFG,`, '/* state_cfg */'));
  L.push(row(`vol_ch${i}_buf`, '/* filt_buf */'));
  L.push(last ? '    }' : '    },');
  L.push('#endif');
  return L;
}

/** 生成 src/vol_cfg.c 全文 */
export function emitC(model: ConfigModel): string {
  const channels = model.channels;

  let out = TOOL_NOTICE.join('\n') + '\n\n' + C_PRE + '\n';
  for (let i = 0; i < channels.length; i++) {
    out += channelBlockC(i, channels[i]!);
  }
  out += C_TABLE_PRE;
  for (let i = 0; i < channels.length; i++) {
    out += tableEntryC(i, i === channels.length - 1).join('\n') + '\n';
  }
  out += '};\n';
  return out;
}
