/**
 * @file    rules.ts
 * @brief   C1~C11 业务规则校验 + W1~W9 工程建议。
 *
 * 与 `src/core/cfgfile/schema.ts` 的分工：
 *   - schema 判"文件本身能不能读"（键名、类型、长度、版本），编号 F1~F6；
 *   - 本文件判"这份配置能不能用"（对应的 C 编译期断言会不会炸），编号 C1~C11；
 *   - 同一个错只由一方报，避免用户看到两条不同编号的提示。
 *
 * 判定依据是 `vol_cfg.c` 的断言表达式与架构文档 §5.3 的规则表，两者逐条对应：
 *   C1 → c1_CHn / m_channel_num_hi      C7  → c7_CHn_i
 *   C2 → 无独立断言（由 C5+C6 保证）     C8  → c8_CHn_lo / c8_CHn_hi
 *   C3 → c3_CHn_first_lower             C9  → c9_CHn_div / c9_CHn_scale
 *   C4 → c4_CHn_last_upper              C10 → c10_CHn_first_down / c10_CHn_last_up
 *   C5 → c5_CHn_i                       C11 → c11_CHn_fs / vref / rh / rl / gain / offset / vmax
 *   C6 → c6_CHn_i                       C12 → 由条件编译构造保证，无断言
 *
 * C2/C3/C4/C5/C10/C12 在当前模型下是**构造性成立**的（边界中心表示 + 生成器保证）。
 * 这里仍然逐条检查一遍：一是不变量测试要靠它证明"生成器从不会产出违规代码"，
 * 二是将来模型若被改动，这些检查会立刻报警而不是静默失效。
 */
import type { ChannelCfg, ConfigModel, Diagnostic } from '../model/types';
import { stateCount, stateName, shortName, voltageMaxMvOf } from '../model/types';
import { adcFullScaleMv, filterWindow, mvPerLsb, scaleBreakdown, settleTimeMs } from './scale';

/**
 * 单通道状态数硬上限 —— 来自库，不是本工具定的。
 *
 * `src/vol_cfg.c` 里有一条 `m_state_num_max` 断言把 `VOL_STATE_NUM_MAX` 关在 1..12，
 * 而 C1 又要求每个通道的 `state_num ≤ VOL_STATE_NUM_MAX`，所以链路上限就是 12。
 *
 * 它**不是**类型或算法限制：`state_num` 是 `uint8_t`（可到 255），`state_cfg` 是
 * const 指针（不是定长数组，放宽上限不改变结构体大小），状态机是 O(N) 线性扫描。
 * 12 是库划的容量值：车载电压段 4~6 段已够用，再留一倍余量；断言的本意是拦
 * "误填 80"这种量级手误，而不是精确限制能力。
 *
 * 要再放宽：同时改 `src/vol_cfg.c` 的 `m_state_num_max`（把 12 改成新上限）、
 * `inc/vol_cfg.h` 的 `VOL_STATE_NUM_MAX` 默认值，重跑 `scripts/gen-skeleton.mjs`
 * 刷新生成器骨架，再把这里改掉。本工具只是镜像库的限制，免得生成出
 * "必然编译失败"的代码。
 */
export const STATE_NUM_CAP = 12;

/** 展开后的状态表：与生成到 C 里的 S<i>_* 宏一一对应 */
interface FlatState {
  lowerMv: number;
  upperMv: number;
  hystUpMv: number;
  hystDownMv: number;
}

/** 仅测量通道返回 null */
export interface FlatChannel {
  vmax: number;
  states: FlatState[];
}

export function flattenChannel(ch: ChannelCfg): FlatChannel | null {
  if (ch.states.mode !== 'stateful') return null;
  const { names, boundaries } = ch.states;
  const n = names.length;
  const states: FlatState[] = [];
  for (let i = 0; i < n; i++) {
    const b = boundaries[i]!;
    states.push({
      lowerMv: i === 0 ? 0 : boundaries[i - 1]!.upperMv,
      upperMv: b.upperMv,
      // 末状态没有上侧邻居、首状态没有下侧邻居，外侧迟滞恒为 0（C10）
      hystUpMv: i < n - 1 ? b.hystUpMv : 0,
      hystDownMv: i === 0 ? 0 : boundaries[i - 1]!.hystDownMv,
    });
  }
  return { vmax: voltageMaxMvOf(ch), states };
}

/* ==========================================================================
 * 阈值常量：集中在这里，便于 UI 文案与测试共用
 * ========================================================================== */

/** W2：迟滞小于这个值就算"太薄"，噪声容易反复穿越 */
export const HYST_MIN_MV = 50;
/** W3：建立时间超过这个值提示 */
export const SETTLE_MAX_MS = 1000;
/** W4：分辨率粗于这个值提示 */
export const MV_PER_LSB_MAX = 50;
/** W6：偏置绝对值超过这个值提示 */
export const OFFSET_NOTICE_MV = 100;

export function checkRules(model: ConfigModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, path: string, message: string): void => {
    out.push({ severity: 'error', code, path, message });
  };

  const m = model.module;

  /* ---------- 模块级参数：对应生成文件的 m_* 断言 ---------- */
  if (m.samplePeriodMs < 1) {
    err('F5', 'module.sample_period_ms', `采样周期必须 >= 1 ms，当前 ${m.samplePeriodMs}（断言 m_sample_period）`);
  }
  if (m.filterWindowMax < 1 || m.filterWindowMax > 1024) {
    err('F5', 'module.filter_window_max', `窗口上限须在 1..1024，当前 ${m.filterWindowMax}（断言 m_window_max）`);
  }
  if (m.stateNumMax < 1 || m.stateNumMax > STATE_NUM_CAP) {
    err(
      'F5',
      'module.state_num_max',
      `状态数上限须在 1..${STATE_NUM_CAP}，当前 ${m.stateNumMax}（库断言 m_state_num_max 把 ` +
        'VOL_STATE_NUM_MAX 关在这个范围内；要放宽须先改库）',
    );
  }
  if (m.channelNumMax < 1) {
    err('F5', 'module.channel_num_max', `通道数上限须 >= 1，当前 ${m.channelNumMax}（断言 m_channel_num_hi）`);
  }
  if (m.rMaxOhm < 1) {
    err('F5', 'module.r_max_ohm', `电阻上限须 >= 1 Ω，当前 ${m.rMaxOhm}（断言 m_r_max）`);
  }

  /* ---------- C1：容量 ---------- */
  if (model.channels.length === 0) {
    err('C1', 'channels', '至少需要 1 个通道，当前 0（断言 m_channel_num_lo）');
  }
  if (model.channels.length > m.channelNumMax) {
    err(
      'C1',
      'channels',
      `共 ${model.channels.length} 个通道，超过 VOL_CHANNEL_NUM_MAX = ${m.channelNumMax}（断言 m_channel_num_hi）`,
    );
  }

  model.channels.forEach((ch, i) => checkChannel(out, ch, i, m));

  return out;
}

function checkChannel(
  out: Diagnostic[],
  ch: ChannelCfg,
  i: number,
  m: ConfigModel['module'],
): void {
  const err = (code: string, path: string, message: string): void => {
    out.push({ severity: 'error', code, path, message });
  };
  const warn = (code: string, path: string, message: string): void => {
    out.push({ severity: 'warning', code, path, message });
  };
  const at = (sub: string): string => `channels[${i}]${sub ? `.${sub}` : ''}`;

  /* ---------- C1：状态数容量 ---------- */
  const n = stateCount(ch);
  if (n > m.stateNumMax) {
    err(
      'C1',
      at('states.names'),
      `本通道 ${n} 个状态，超过 VOL_STATE_NUM_MAX = ${m.stateNumMax}（断言 c1_CH${i}）`,
    );
  }

  /* ---------- C8：滤波窗口 ---------- */
  const win = filterWindow(ch.filter, m.samplePeriodMs);
  const winHow =
    ch.filter.mode === 'by_time'
      ? `${ch.filter.arg} ms ÷ ${m.samplePeriodMs} ms 采样 = ${win} 点`
      : `${ch.filter.arg} 点`;
  if (win < 1 || win > m.filterWindowMax) {
    err(
      'C8',
      at('filter.arg'),
      `滤波窗口 ${winHow}，须在 1..${m.filterWindowMax}（VOL_FILTER_WINDOW_MAX）；` +
        `当前会触发 c8_CH${i}_${win < 1 ? 'lo' : 'hi'}`,
    );
  }

  /* ---------- C9 / C11：ADC、分压、标定、量程 ---------- */
  const { fs, vrefMv } = ch.adc;
  if (fs < 1 || fs > 65535) {
    err('C11', at('adc.fs'), `ADC 满量程码值须在 1..65535，当前 ${fs}（断言 c11_CH${i}_fs）`);
  }
  if (vrefMv < 1 || vrefMv > 5000) {
    err('C11', at('adc.vref_mv'), `参考电压须在 1..5000 mV，当前 ${vrefMv}（断言 c11_CH${i}_vref）`);
  }
  const { rHighOhm, rLowOhm } = ch.divider;
  if (rHighOhm < 0 || rHighOhm > m.rMaxOhm) {
    err(
      'C11',
      at('divider.r_high_ohm'),
      `上臂电阻须在 0..${m.rMaxOhm} Ω，当前 ${rHighOhm}（断言 c11_CH${i}_rh）`,
    );
  }
  if (rLowOhm < 1 || rLowOhm > m.rMaxOhm) {
    err(
      'C11',
      at('divider.r_low_ohm'),
      `下臂电阻须在 1..${m.rMaxOhm} Ω，当前 ${rLowOhm}（断言 c11_CH${i}_rl）`,
    );
  }
  const { gainPpm, offsetMv } = ch.calib;
  if (gainPpm < -100000 || gainPpm > 100000) {
    err(
      'C11',
      at('calib.gain_ppm'),
      `增益残差须在 ±100000 ppm 内，当前 ${gainPpm}（断言 c11_CH${i}_gain；超过 ±10% 会算出负系数）`,
    );
  }
  if (offsetMv < -1000 || offsetMv > 1000) {
    err('C11', at('calib.offset_mv'), `偏置残差须在 ±1000 mV 内，当前 ${offsetMv}（断言 c11_CH${i}_offset）`);
  }
  const vmax = voltageMaxMvOf(ch);
  if (vmax < 1 || vmax > 65535) {
    err(
      'C11',
      ch.states.mode === 'stateful' ? at('states.boundaries') : at('voltage_max_mv'),
      `量程须在 1..65535 mV，当前 ${vmax}（断言 c11_CH${i}_vmax）`,
    );
  }

  // 除零：C9 的 c9_div 是 (R_HIGH + R_LOW) > 0
  if (rHighOhm + rLowOhm <= 0) {
    err('C9', at('divider'), `上下臂电阻之和为 ${rHighOhm + rLowOhm} Ω，会产生除零（断言 c9_CH${i}_div）`);
  } else if (fs > 0 && vrefMv > 0 && rLowOhm > 0) {
    // 系数截断：断言的正是强转前的 64 位值
    const { q16_64, fitsU32, denominator } = scaleBreakdown(ch.adc, ch.divider, ch.calib);
    if (denominator !== 0n && !fitsU32) {
      err(
        'C9',
        at(''),
        `定点系数 scale_q16 = ${q16_64.toString()} 已达 2^32，强转 uint32 会静默截断` +
          `（断言 c9_CH${i}_scale）；检查分压电阻与增益量级，或改用更大的满量程码值`,
      );
    }
  }

  /* ---------- 展开成状态表后逐条校验 C2~C7 / C10 ---------- */
  const flat = flattenChannel(ch);
  if (flat && flat.states.length > 0) {
    const st = flat.states;
    const cnt = st.length;

    // C3：首状态下界必须为 0
    if (st[0]!.lowerMv !== 0) {
      err('C3', at('states'), `首状态下界为 ${st[0]!.lowerMv} mV，必须为 0（断言 c3_CH${i}_first_lower）`);
    }
    // C4：末状态上界必须等于量程
    if (st[cnt - 1]!.upperMv !== flat.vmax) {
      err(
        'C4',
        at('states.boundaries'),
        `末状态上界 ${st[cnt - 1]!.upperMv} mV 与量程 ${flat.vmax} mV 不一致` +
          `（断言 c4_CH${i}_last_upper）`,
      );
    }
    // C5：相邻状态无缝衔接
    for (let k = 0; k < cnt - 1; k++) {
      if (st[k]!.upperMv !== st[k + 1]!.lowerMv) {
        err(
          'C5',
          at(`states.boundaries[${k}]`),
          `S${k} 上界 ${st[k]!.upperMv} mV 与 S${k + 1} 下界 ${st[k + 1]!.lowerMv} mV 不相等` +
            `（断言 c5_CH${i}_${k}）`,
        );
      }
    }
    // C6：区间非退化（边界必须严格递增）
    for (let k = 0; k < cnt; k++) {
      const { lowerMv, upperMv } = st[k]!;
      if (!(lowerMv < upperMv)) {
        const prev = k === 0 ? 'b0 = 0（隐含）' : `b${k} = ${lowerMv} mV`;
        err(
          'C6',
          at(`states.boundaries[${k}].upper_mv`),
          `状态 S${k}「${shortName(stateName(ch, k))}」区间为空：b${k + 1} = ${upperMv} mV ` +
            `必须大于 ${prev}（断言 c6_CH${i}_${k}）`,
        );
      }
    }
    // C7：两侧迟滞之和不得挤掉整个区间
    for (let k = 0; k < cnt; k++) {
      const upIn = k > 0 ? st[k - 1]!.hystUpMv : 0;
      const downIn = k < cnt - 1 ? st[k + 1]!.hystDownMv : 0;
      const left = upIn + downIn;
      const width = st[k]!.upperMv - st[k]!.lowerMv;
      if (!(left < width)) {
        const parts: string[] = [];
        if (k > 0) parts.push(`S${k - 1} 上行迟滞 ${upIn}`);
        if (k < cnt - 1) parts.push(`S${k + 1} 下行迟滞 ${downIn}`);
        // 定位到"最该改的那个迟滞"：中间状态取两者较大的一个
        let hystPath: string;
        if (k === 0) hystPath = `states.boundaries[${k}].hyst_down_mv`;
        else if (k === cnt - 1) hystPath = `states.boundaries[${k - 1}].hyst_up_mv`;
        else
          hystPath =
            upIn >= downIn
              ? `states.boundaries[${k - 1}].hyst_up_mv`
              : `states.boundaries[${k}].hyst_down_mv`;
        err(
          'C7',
          at(hystPath),
          `状态 S${k}「${shortName(stateName(ch, k))}」区间宽 ${width} mV，而两侧迟滞合计 ${left} mV` +
            `（${parts.join(' + ')}）不小于区间宽：该状态会被跨过或无法稳定停留（断言 c7_CH${i}_${k}）`,
        );
      }
    }
    // C10：首末状态外侧迟滞必须为 0
    if (st[0]!.hystDownMv !== 0) {
      err('C10', at('states'), `S0 的下行迟滞必须为 0，当前 ${st[0]!.hystDownMv}（断言 c10_CH${i}_first_down）`);
    }
    if (st[cnt - 1]!.hystUpMv !== 0) {
      err(
        'C10',
        at('states'),
        `末状态 S${cnt - 1} 的上行迟滞必须为 0，当前 ${st[cnt - 1]!.hystUpMv}（断言 c10_CH${i}_last_up）`,
      );
    }
  }

  /* ---------- W 类：工程建议（不阻止生成） ---------- */
  const fsMv = adcFullScaleMv(ch.adc, ch.divider);
  if (Number.isFinite(fsMv) && vmax > fsMv) {
    warn(
      'W1',
      ch.states.mode === 'stateful' ? at('states.boundaries') : at('voltage_max_mv'),
      `量程 ${vmax} mV 高于分压满量程 ${Math.round(fsMv)} mV：超过 ${Math.round(fsMv)} mV 后 ADC 饱和、` +
        `读数不再上升（限幅仍生效）。若实际电压到不了这里可忽略`,
    );
  }

  if (flat) {
    for (let k = 0; k < flat.states.length; k++) {
      const s = flat.states[k]!;
      // hystUp 归 S_k（存于 boundaries[k]），hystDown 归 S_k（存于 boundaries[k-1]）
      const pairs: Array<{ key: string; label: string; v: number; path: string }> = [
        { key: 'hyst_up_mv', label: '上行', v: s.hystUpMv, path: `states.boundaries[${k}].hyst_up_mv` },
        {
          key: 'hyst_down_mv',
          label: '下行',
          v: s.hystDownMv,
          path: `states.boundaries[${k - 1}].hyst_down_mv`,
        },
      ];
      for (const p of pairs) {
        if (p.v > 0 && p.v < HYST_MIN_MV) {
          warn(
            'W2',
            at(p.path),
            `S${k} 的${p.label}迟滞只有 ${p.v} mV（< ${HYST_MIN_MV} mV）：` +
              `滤波后的残余纹波可能反复穿越门限，导致状态抖动`,
          );
        }
      }
    }
  }

  const settle = settleTimeMs(ch.filter, m.samplePeriodMs);
  if (settle > SETTLE_MAX_MS) {
    warn(
      'W3',
      at('filter.arg'),
      `建立时间 ${settle} ms（${winHow} × ${m.samplePeriodMs} ms）超过 ${SETTLE_MAX_MS} ms：` +
        `电压突变后要这么久才跟上，持续时间更短的跌落/尖峰会被抹平`,
    );
  }

  const res = mvPerLsb(ch.adc, ch.divider);
  if (Number.isFinite(res) && res > MV_PER_LSB_MAX) {
    warn(
      'W4',
      at('divider'),
      `分辨率 ${res.toFixed(1)} mV/LSB 偏粗（> ${MV_PER_LSB_MAX}）：分压比过大，` +
        `状态边界附近会来回跳 1~2 个码，建议减小下臂电阻或换更细的 ADC`,
    );
  }

  if (ch.states.mode === 'stateful') {
    const seen = new Map<string, number>();
    ch.states.names.forEach((name, k) => {
      const hit = seen.get(name);
      if (hit !== undefined) {
        warn('W5', at(`states.names[${k}]`), `状态名「${name}」与 S${hit} 重复，生成的注释会分不清`);
      } else {
        seen.set(name, k);
      }
    });
  }

  if (Math.abs(offsetMv) >= OFFSET_NOTICE_MV) {
    warn(
      'W6',
      at('calib.offset_mv'),
      `偏置 ${offsetMv} mV：输出读数整体${offsetMv < 0 ? '上移' : '下移'} ${Math.abs(offsetMv)} mV，` +
        `确认这是实测标定结果而不是手误`,
    );
  }

  if (ch.filter.mode === 'by_time' && m.samplePeriodMs > 0 && ch.filter.arg % m.samplePeriodMs !== 0) {
    warn(
      'W7',
      at('filter.arg'),
      `${ch.filter.arg} ms 不是采样周期 ${m.samplePeriodMs} ms 的整数倍：窗口按 ceil 取 ${win} 点，` +
        `实际建立时间 ${settle} ms 比填的多`,
    );
  }

  if (rHighOhm === 0) {
    warn(
      'W8',
      at('divider.r_high_ohm'),
      `上臂电阻为 0：分压直连，量程 = VREF = ${vrefMv} mV。确认不是漏填`,
    );
  }

  // W9：标定实测点的码值/电压自洽性。只提醒不拦——标定过程本身就是一堆"暂时不对"的中间态。
  ch.calibPoints?.forEach((p, k) => {
    if (!Number.isInteger(p.code) || !Number.isInteger(p.inMv)) return; // schema 已保证，防御
    if (p.code < 0 || p.code > ch.adc.fs) {
      warn(
        'W9',
        at(`calib_points[${k}].code`),
        `码值 ${p.code} 超出 0..${ch.adc.fs}：是否换了 ADC 位数（12 位/16 位）或记错了通道`,
      );
    }
    if (p.inMv < 0) {
      warn('W9', at(`calib_points[${k}].in_mv`), `实测电压为负（${p.inMv} mV），检查表笔极性`);
    } else if (vmax > 0 && p.inMv > vmax * 1.5) {
      warn(
        'W9',
        at(`calib_points[${k}].in_mv`),
        `实测 ${p.inMv} mV 比通道量程 ${vmax} mV 大 50% 以上：标定点落在限幅区，拟合会被拉偏`,
      );
    }
  });
}
