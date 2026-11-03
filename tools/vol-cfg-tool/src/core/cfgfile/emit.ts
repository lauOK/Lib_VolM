/**
 * @file    emit.ts
 * @brief   ConfigModel → vol_cfg.yaml 文本。
 *
 * 手工拼装而不是 js-yaml.dump：dump 无法产出注释，而这份文件的注释就是它的文档。
 * 三个可复现性要求：字段顺序固定、无时间戳、行尾 LF；同一模型重复导出逐字节相同，
 * 入库后 git diff 只会出现真正改动的数值。
 *
 * 因此这里写的是**工具版本**而不是生成日期：版本号一天之内不会变，加日期就等于
 * "每次导出都改一次文件"。生成日期只进 C 文件头（那是给人看的一次性产物），
 * yaml 是要长期入库、反复 diff 的源文件。
 */
import type { ChannelCfg, ConfigModel } from '../../model/types';
import { LIB_VERSION, SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from '../../version';
import { fmtVolt1 } from '../emit/pad';

export const CONFIG_FILENAME = 'vol_cfg.yaml';

/** 行尾注释的起始列（1-based）；只用于值全为 ASCII 的行，避免中文宽度导致视觉错位 */
const COMMENT_COL = 40;

const IND = (n: number): string => ' '.repeat(n);

/**
 * 显示宽度：中文/全角标点占 2 列。
 * 对齐必须按显示宽度算，否则 `comment: 示例…` 这类含中文的值会把行尾注释顶到右边去。
 */
function visWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 0x2e80 && c <= 0xffef ? 2 : 1;
  }
  return w;
}

function visPadTo(line: string, col: number): string {
  const need = col - 1 - visWidth(line);
  return line + ' '.repeat(need > 0 ? need : 1);
}

function kv(indent: number, key: string, value: string | number, comment?: string): string {
  const head = `${IND(indent)}${key}: ${value}`;
  return comment ? visPadTo(head, COMMENT_COL) + `# ${comment}` : head;
}

const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;
const NUMERIC = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const FIRST_SPECIAL = '-?:,[]{}#&*!|>\'"%@`';

/** 输出一个可安全回读的标量；中文与空格无需引号，含 `:`/`#`/`,` 等才加单引号 */
function scalar(s: string): string {
  const needsQuote =
    s === '' ||
    s.trim() !== s ||
    RESERVED.test(s) ||
    NUMERIC.test(s) ||
    FIRST_SPECIAL.includes(s[0] ?? '') ||
    /[:#,[\]{}\n\t]/.test(s);
  return needsQuote ? `'${s.replace(/'/g, "''")}'` : s;
}

/**
 * 块标量：`|` 保留结尾换行、`|-` 去掉结尾换行，二者按原文精确往返。
 * 空行写成真正的空行（不补缩进空格），避免行尾空白。
 */
function blockLines(indent: number, key: string, text: string, comment?: string): string[] {
  const keepFinal = text.endsWith('\n');
  const body = keepFinal ? text.slice(0, -1) : text;
  const head = `${IND(indent)}${key}: ${keepFinal ? '|' : '|-'}`;
  return [
    comment ? visPadTo(head, COMMENT_COL) + `# ${comment}` : head,
    ...body.split('\n').map((l) => (l === '' ? '' : `${IND(indent + 2)}${l}`)),
  ];
}

function emitModule(model: ConfigModel): string[] {
  const m = model.module;
  const L: string[] = ['module:'];
  L.push(kv(2, 'sample_period_ms', m.samplePeriodMs, '采样周期 ms；by_time 模式靠它把 ms 换算成点数，须 >= 1'));
  L.push(kv(2, 'filter_window_max', m.filterWindowMax, '单通道滤波窗口上限，1..1024（仅用于编译期断言）'));
  L.push(kv(2, 'state_num_max', m.stateNumMax, '单通道状态数上限，1..12（仅用于断言）'));
  L.push(kv(2, 'channel_num_max', m.channelNumMax, '通道实例数上限（仅用于断言）'));
  L.push(kv(2, 'r_max_ohm', m.rMaxOhm, '分压电阻上限 Ω（挡住 5.1k 写成 5100000）'));
  if (m.comment !== undefined) {
    L.push(kv(2, 'comment', scalar(m.comment), '生成文件「通道级配置」标题括号内的说明'));
  } else {
    L.push(`${IND(2)}# comment 省略：生成文件的通道级配置标题不追加说明`);
  }
  return L;
}

function emitStates(ch: ChannelCfg): string[] {
  const L: string[] = [`${IND(4)}states:`];
  if (ch.states.mode === 'measure_only') {
    L.push(kv(6, 'mode', 'measure_only', '无状态：只换算 + 滤波 + 提供电压（STATE_NUM = 0）'));
    return L;
  }

  const { names, boundaries } = ch.states;
  L.push(kv(6, 'mode', 'stateful', '有状态；另一个取值 measure_only（仅测量）'));
  L.push(`${IND(6)}# names：顺序 = 电压由低到高，个数 n；boundaries 必须正好 n 条（b1..bn）`);
  L.push(`${IND(6)}names: [${names.map(scalar).join(', ')}]`);
  L.push(`${IND(6)}# b0 恒为 0，不写；b1..b(n-1) 是相邻状态的分界，bn 是量程上限 → 生成 VOLTAGE_MAX_MV。`);
  L.push(`${IND(6)}# 迟滞归属：hyst_up 归低侧状态（离开门限 = 边界 + 它）；`);
  L.push(`${IND(6)}#           hyst_down 归高侧状态（离开门限 = 边界 − 它）。`);
  L.push(`${IND(6)}boundaries:`);
  boundaries.forEach((b, i) => {
    const isLast = i === boundaries.length - 1;
    if (isLast) {
      L.push(kv(8, '- upper_mv', b.upperMv, `b${i + 1} = 量程上限 → VOLTAGE_MAX_MV（末状态无上邻，无迟滞）`));
      return;
    }
    const up = b.upperMv + b.hystUpMv;
    const down = b.upperMv - b.hystDownMv;
    L.push(kv(8, '- upper_mv', b.upperMv, `b${i + 1}：S${i} 上限 / S${i + 1} 下限`));
    L.push(kv(10, 'hyst_up_mv', b.hystUpMv, `S${i} 向上门限 = ${fmtVolt1(up)} V`));
    L.push(kv(10, 'hyst_down_mv', b.hystDownMv, `S${i + 1} 向下门限 = ${fmtVolt1(down)} V`));
  });
  return L;
}

function emitChannel(ch: ChannelCfg): string[] {
  const L: string[] = [];
  L.push(`${IND(2)}- name: ${scalar(ch.name)}`);
  if (ch.comment !== undefined) {
    L.push(...blockLines(4, 'comment', ch.comment, '进生成文件的通道 banner；省略则按参数自动生成'));
  } else {
    L.push(`${IND(4)}# comment 省略：通道 banner 按参数自动生成`);
  }
  L.push(`${IND(4)}adc:`);
  L.push(kv(6, 'fs', ch.adc.fs, '满量程码值：12 位填 4095，16 位填 65535'));
  L.push(kv(6, 'vref_mv', ch.adc.vrefMv, 'ADC 参考电压 mV'));
  L.push(`${IND(4)}divider:`);
  L.push(kv(6, 'r_high_ohm', ch.divider.rHighOhm, '上臂电阻 Ω（注意不是 kΩ）'));
  L.push(kv(6, 'r_low_ohm', ch.divider.rLowOhm, '下臂电阻 Ω，须 > 0'));
  L.push(`${IND(4)}calib:`);
  L.push(kv(6, 'gain_ppm', ch.calib.gainPpm, '增益残差 ppm；实测偏低填正数'));
  L.push(kv(6, 'offset_mv', ch.calib.offsetMv, '偏置残差 mV，可为负'));
  // 标定实测点：纯可选段。没有点就一个字符都不写——既有的配置导出必须逐字节不变。
  if (ch.calibPoints && ch.calibPoints.length > 0) {
    L.push(
      visPadTo(`${IND(4)}calib_points:`, COMMENT_COL) +
        '# 标定实测点：code = ADC 原始码值，in_mv = 万用表实测输入总电压',
    );
    for (const p of ch.calibPoints) {
      L.push(kv(6, '- code', p.code, '0..fs；引脚电压由 code/fs*vref 推算，仅供对照'));
      L.push(kv(8, 'in_mv', p.inMv, '实测输入总电压 mV（万用表读数取整）'));
    }
  }
  L.push(`${IND(4)}filter:`);
  L.push(kv(6, 'mode', ch.filter.mode, 'by_time（arg 是毫秒）| by_sample（arg 是点数）'));
  L.push(kv(6, 'arg', ch.filter.arg, ch.filter.mode === 'by_time' ? '滤波时间 ms，换算成 ceil(ms ÷ 采样周期) 点' : '滤波点数'));
  if (ch.states.mode === 'measure_only') {
    L.push(kv(4, 'voltage_max_mv', ch.voltageMaxMv ?? 0, '本通道量程 mV（限幅；无状态表，故在此给出）'));
  } else {
    L.push(`${IND(4)}# 量程由 states.boundaries 最后一条（bn）给出，此处不重复`);
  }
  L.push(...emitStates(ch));
  return L;
}

const HEADER = [
  `# Lib_VolM 配置源文件（${SCHEMA_VERSION}，由 ${TOOL_NAME} v${TOOL_VERSION} 写出，目标库 V${LIB_VERSION}）`,
  '#   —— 配置的唯一真源，与生成的 C 文件一起入库。',
  '# 改配置：导入 vol-cfg-tool → 修改 → 重新下载 vol_cfg.h + vol_cfg.c 覆盖原文件。',
  '# 手工编辑：字段名与层级不要改；单位见各行注释（电压 mV、电阻 Ω、时间 ms）。',
  '# 版本：schema 是格式版本，决定兼容性——新版工具能读旧格式（自动升级），',
  '#       旧版工具读到格式号更大的文件会直接报错（F2），不会猜着读。generator 只记录是谁写的。',
];

/**
 * generator 段：写出本文件的工具与版本。
 *
 * 用映射而不是 `generator: vol-cfg-tool 0.2.0` 一行字符串：两个字段各自可校验，
 * 也不会因为工具改名而解析不出作者。
 */
function emitGenerator(): string[] {
  return [
    visPadTo('generator:', COMMENT_COL) + '# 写出本文件的工具（纯记录，可省略，不参与兼容性判断）',
    kv(2, 'tool', TOOL_NAME),
    kv(2, 'version', `'${TOOL_VERSION}'`),
  ];
}

/** 生成完整 YAML 文本（LF 结尾，UTF-8 无 BOM） */
export function emitConfigYaml(model: ConfigModel): string {
  const L: string[] = [
    ...HEADER,
    '',
    `schema: ${SCHEMA_VERSION}`,
    '',
    ...emitGenerator(),
    '',
    ...emitModule(model),
    '',
    'channels:',
  ];
  model.channels.forEach((ch, i) => {
    if (i > 0) L.push('');
    L.push(...emitChannel(ch));
  });
  return `${L.join('\n')}\n`;
}
