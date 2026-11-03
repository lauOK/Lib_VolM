/**
 * @file    DerivedPanel.tsx
 * @brief   派生量与宏映射：告诉用户"你没填的那 4N 个宏长什么样"。
 *
 * 全部现算，不存进配置文件——否则改了电阻却忘了改系数，yaml 和 C 就对不上了。
 */
import type { ReactNode } from 'react';

import type { ChannelCfg } from '../model/types';
import { hystDownOf, hystUpOf, shortName, stateCount, stateRange, voltageMaxMvOf } from '../model/types';
import {
  adcFullScaleMv,
  filterWindow,
  mvPerLsb,
  offsetUv,
  scaleQ16,
  settleTimeMs,
} from '../core/scale';

import { macroOf } from './derive';
import { useCfg } from './store';

export function DerivedPanel({ index, ch }: { index: number; ch: ChannelCfg }) {
  const { model } = useCfg();
  const sp = model.module.samplePeriodMs;
  const win = filterWindow(ch.filter, sp);
  const n = stateCount(ch);

  return (
    <div className="derived-panel">
      <div className="kv-grid">
        <KV k={<code>{macroOf.scale(index)}</code>} v={String(scaleQ16(ch.adc, ch.divider, ch.calib))} />
        <KV k="每码电压" v={`${(scaleQ16(ch.adc, ch.divider, ch.calib) / 65536).toFixed(2)} µV/LSB`} />
        <KV k={<code>{macroOf.offset(index)}</code>} v={`${offsetUv(ch.calib)} µV`} />
        <KV k={<code>{macroOf.window(index)}</code>} v={`${win} 点`} />
        <KV
          k="窗口占用 RAM"
          v={`${win * 2} B / 通道`}
        />
        <KV k="分辨率" v={`${mvPerLsb(ch.adc, ch.divider).toFixed(2)} mV/LSB`} />
        <KV k="ADC 满量程电压" v={`${Math.round(adcFullScaleMv(ch.adc, ch.divider))} mV`} />
        <KV k="建立时间" v={`${settleTimeMs(ch.filter, sp)} ms`} />
        <KV k={<code>{macroOf.vmax(index)}</code>} v={`${voltageMaxMvOf(ch)} mV`} />
      </div>

      {n > 0 && ch.states.mode === 'stateful' && (
        <table className="macro-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>区间 mV</th>
              <th>HYST_UP</th>
              <th>HYST_DOWN</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: n }, (_, k) => {
              const r = stateRange(ch, k);
              const up = hystUpOf(ch, k);
              const down = hystDownOf(ch, k);
              return (
                <tr key={k}>
                  <td>
                    <b>S{k}</b> {shortName(ch.states.mode === 'stateful' ? (ch.states.names[k] ?? '') : '')}
                  </td>
                  <td className="mono">
                    {r ? `${r.lowerMv} ~ ${r.upperMv}` : ''}
                  </td>
                  <td className="mono" title={macroOf.hystUp(index, k)}>
                    {up}
                    {k === n - 1 && <span className="tag">末状态恒 0</span>}
                  </td>
                  <td className="mono" title={macroOf.hystDown(index, k)}>
                    {down}
                    {k === 0 && <span className="tag">首状态恒 0</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function KV({ k, v }: { k: ReactNode; v: string }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v mono">{v}</span>
    </div>
  );
}
