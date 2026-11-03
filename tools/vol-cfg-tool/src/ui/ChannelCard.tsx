/**
 * @file    ChannelCard.tsx
 * @brief   单通道卡片：通道级参数 + 状态列表 + 边界编辑器 + 电压带 + 派生量。
 *
 * 状态数与 names / boundaries 的长度必须同步（n ↔ n），增删都走 store 里的
 * addState / removeState，组件不自己拼数组——那是最容易把 C4 弄坏的地方。
 */
import type { ChannelCfg } from '../model/types';
import { stateCount } from '../model/types';

import { CalibPanel } from './CalibPanel';
import { DerivedPanel } from './DerivedPanel';
import { NumField, SelectField } from './controls';
import { useCfg, useDiagCount } from './store';
import { StateTable } from './StateTable';
import { TransferCurve } from './TransferCurve';
import { VoltageBand } from './VoltageBand';

interface Props {
  index: number;
  ch: ChannelCfg;
  total: number;
}

export function ChannelCard({ index, ch, total }: Props) {
  const { model, dispatch } = useCfg();
  const n = stateCount(ch);
  const { errors, warns } = useDiagCount(`channels[${index}]`);

  const patch = (p: Partial<ChannelCfg>): void => dispatch({ type: 'channel', index, patch: p });

  return (
    <article className={`card chan${errors > 0 ? ' is-bad' : ''}`} data-path={`channels[${index}]`}>
      <header className="chan-head">
        <input
          className="chan-name"
          type="text"
          value={ch.name}
          data-path={`channels[${index}].name`}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <span className={`badge ${n === 0 ? 'ok' : 'plain'}`}>{n === 0 ? '仅测量' : `${n} 状态`}</span>
        {errors > 0 && <span className="badge err">{errors} 错误</span>}
        {errors === 0 && warns > 0 && <span className="badge warn">{warns} 建议</span>}
        <span className="spacer" />
        <label className="switch" title="关闭后本通道只做换算/滤波，STATE_NUM = 0">
          <input
            type="checkbox"
            checked={ch.states.mode === 'stateful'}
            onChange={(e) =>
              dispatch({ type: 'setMode', index, mode: e.target.checked ? 'stateful' : 'measure_only' })
            }
          />
          状态机
        </label>
        <button
          className="ghost icon"
          disabled={index === 0}
          title="上移"
          onClick={() => dispatch({ type: 'moveChannel', index, delta: -1 })}
        >
          ↑
        </button>
        <button
          className="ghost icon"
          disabled={index === total - 1}
          title="下移"
          onClick={() => dispatch({ type: 'moveChannel', index, delta: 1 })}
        >
          ↓
        </button>
        <button
          className="ghost danger"
          disabled={total <= 1}
          title={total <= 1 ? '至少保留一个通道' : '删除本通道'}
          onClick={() => dispatch({ type: 'removeChannel', index })}
        >
          删除
        </button>
      </header>

      <div className="chan-body">
          <div className="grid">
            <NumField
              label="ADC 满量码值"
              value={ch.adc.fs}
              min={1}
              max={65535}
              hint="12 位填 4095"
              path={`channels[${index}].adc.fs`}
              onChange={(v) => dispatch({ type: 'adc', index, patch: { fs: v } })}
            />
            <NumField
              label="参考电压"
              unit="mV"
              value={ch.adc.vrefMv}
              min={1}
              max={5000}
              path={`channels[${index}].adc.vref_mv`}
              onChange={(v) => dispatch({ type: 'adc', index, patch: { vrefMv: v } })}
            />
            <NumField
              label="分压上臂"
              unit="Ω"
              value={ch.divider.rHighOhm}
              min={0}
              max={model.module.rMaxOhm}
              hint={`= ${(ch.divider.rHighOhm / 1000).toFixed(1)} kΩ`}
              path={`channels[${index}].divider.r_high_ohm`}
              onChange={(v) => dispatch({ type: 'divider', index, patch: { rHighOhm: v } })}
            />
            <NumField
              label="分压下臂"
              unit="Ω"
              value={ch.divider.rLowOhm}
              min={1}
              max={model.module.rMaxOhm}
              hint={`= ${(ch.divider.rLowOhm / 1000).toFixed(1)} kΩ`}
              path={`channels[${index}].divider.r_low_ohm`}
              onChange={(v) => dispatch({ type: 'divider', index, patch: { rLowOhm: v } })}
            />
            <NumField
              label="增益残差"
              unit="ppm"
              value={ch.calib.gainPpm}
              min={-100000}
              max={100000}
              hint="实测偏低为正"
              path={`channels[${index}].calib.gain_ppm`}
              onChange={(v) => dispatch({ type: 'calib', index, patch: { gainPpm: v } })}
            />
            <NumField
              label="偏置残差"
              unit="mV"
              value={ch.calib.offsetMv}
              min={-1000}
              max={1000}
              path={`channels[${index}].calib.offset_mv`}
              onChange={(v) => dispatch({ type: 'calib', index, patch: { offsetMv: v } })}
            />
            <SelectField
              label="滤波方式"
              value={ch.filter.mode}
              options={[
                { value: 'by_time', label: '按时间（ms）' },
                { value: 'by_sample', label: '按采样点数' },
              ]}
              path={`channels[${index}].filter.mode`}
              onChange={(v) => dispatch({ type: 'filter', index, patch: { mode: v } })}
            />
            <NumField
              label={ch.filter.mode === 'by_time' ? '滤波时长' : '窗口点数'}
              unit={ch.filter.mode === 'by_time' ? 'ms' : '点'}
              value={ch.filter.arg}
              min={1}
              path={`channels[${index}].filter.arg`}
              onChange={(v) => dispatch({ type: 'filter', index, patch: { arg: v } })}
            />
            {ch.states.mode === 'measure_only' && (
              <NumField
                label="量程上限"
                unit="mV"
                value={ch.voltageMaxMv ?? 0}
                min={1}
                max={65535}
                hint="仅测量通道没有 b_n，量程放这里"
                path={`channels[${index}].voltage_max_mv`}
                onChange={(v) => patch({ voltageMaxMv: v })}
              />
            )}
          </div>

          {ch.states.mode === 'stateful' ? (
            <StateTable index={index} ch={ch} />
          ) : (
            <p className="foot-note">
              仅测量通道：只做「换算 + 滤波 + 提供电压」，不生成状态表，STATE_NUM = 0。
              打开上面的「状态机」开关即可增删状态。
            </p>
          )}

          <h3>电压带</h3>
          <VoltageBand index={index} ch={ch} />

          <h3>转换曲线（引脚电压 → 换算电压）</h3>
          <TransferCurve index={index} ch={ch} />

          <CalibPanel index={index} ch={ch} />

          <details className="details">
            <summary>派生量与宏映射（工具算出，不要手填）</summary>
            <DerivedPanel index={index} ch={ch} />
          </details>

          <label className="field wide">
            <span className="lbl">
              通道说明
              <span className="hint">写进生成文件的通道 banner；留空则按参数自动生成</span>
            </span>
            <span className="ipt">
              <textarea
                rows={2}
                value={ch.comment ?? ''}
                placeholder={`通道 ${index}：${ch.name}，分压 …`}
                data-path={`channels[${index}].comment`}
                onChange={(e) => patch({ comment: e.target.value || undefined })}
              />
            </span>
          </label>
        </div>
    </article>
  );
}
