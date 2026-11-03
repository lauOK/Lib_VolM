/**
 * @file    CalibPanel.tsx
 * @brief   标定实测点：录入、增删、残差、一键求解。
 *
 * 交互设计的两条原则：
 *   1. **图与表同源**：表里改数值，图上的红点立刻动；图上拖红点，表里的数立刻变。
 *      两边都走同一个 store action，没有第二份状态。
 *   2. **求解不改流程**：一键求解只是替你把两个残差填进已有的输入框，
 *      之后照样可以手动微调——工具不接管"最终值"，那是工程师的判断。
 */
import { useState } from 'react';

import { evalResiduals, fitCalibration, fitLine, pinOf } from '../core/calibrate';
import type { ChannelCfg } from '../model/types';
import { voltageMaxMvOf } from '../model/types';

import { NumInput } from './controls';
import { MAX_POINTS, useCfg } from './store';

const signed = (v: number): string => (v > 0 ? `+${v}` : String(v));

export function CalibPanel({ index, ch }: { index: number; ch: ChannelCfg }) {
  const { dispatch } = useCfg();
  const [undo, setUndo] = useState<{ gainPpm: number; offsetMv: number } | null>(null);
  const [report, setReport] = useState<string | null>(null);

  const pts = ch.calibPoints ?? [];
  const vmax = voltageMaxMvOf(ch);
  const res = evalResiduals(pts, ch.adc, ch.divider, ch.calib, vmax);
  const line = fitLine(pts, ch.adc);

  const solve = (): void => {
    const r = fitCalibration(pts, ch.adc, ch.divider, vmax);
    if (!r.ok) {
      setReport(r.note ?? '求解失败');
      return;
    }
    setUndo({ gainPpm: ch.calib.gainPpm, offsetMv: ch.calib.offsetMv });
    dispatch({
      type: 'calib',
      index,
      patch: { gainPpm: r.gainPpm, offsetMv: r.offsetMv },
    });
    setReport(
      `已按 ${pts.length} 点求解：gain ${signed(r.gainPpm)} ppm / offset ${signed(r.offsetMv)} mV，` +
        `RMS ${r.rmsMv.toFixed(1)} mV，最大残差 ${r.maxAbsMv} mV` +
        (r.note ? `。${r.note}` : ''),
    );
  };

  const canUndo =
    undo !== null && (undo.gainPpm !== ch.calib.gainPpm || undo.offsetMv !== ch.calib.offsetMv);

  return (
    <div className="calib" data-path={`channels[${index}].calib_points`}>
      <div className="sec-head">
        <h3>标定实测点</h3>
        <span className="muted">
          {pts.length} / {MAX_POINTS}
          {vmax > 0 && ` · 量程 ${(vmax / 1000).toFixed(vmax % 1000 === 0 ? 0 : 1)} V`}
        </span>
        <span className="spacer" />
        <button
          className="ghost"
          disabled={pts.length >= MAX_POINTS}
          title={
            pts.length >= MAX_POINTS
              ? `最多 ${MAX_POINTS} 个点，再多对两参数拟合没有收益`
              : '按量程 60% 处追加一个点'
          }
          onClick={() => dispatch({ type: 'addPoint', index })}
        >
          + 增加点
        </button>
        <button className="primary" disabled={pts.length === 0} onClick={solve} title="最小二乘求解，直接填进上方的两个残差输入框">
          一键求解
        </button>
        <button
          className="ghost"
          disabled={!canUndo}
          title="撤销上一次求解，恢复求解前的两个残差值"
          onClick={() => {
            if (!undo) return;
            dispatch({ type: 'calib', index, patch: undo });
            setReport(null);
            setUndo(null);
          }}
        >
          撤销
        </button>
        <button
          className="ghost danger"
          disabled={pts.length === 0}
          title="清空全部实测点（yaml 里连 calib_points 段都不再出现）"
          onClick={() => {
            dispatch({ type: 'clearPoints', index });
            setReport(null);
            setUndo(null);
          }}
        >
          清空
        </button>
      </div>

      {pts.length === 0 ? (
        <p className="foot-note">
          还没有实测点。加两个以上「码值明显不同」的点才能定增益；只有一个点只能解偏置。
          码值从调试器读 ADC 寄存器，实测电压用万用表读输入总电压——两者都是原始测量值，
          不依赖当前标定。
        </p>
      ) : (
        <div className="bt-wrap">
          <table className="bt pt">
            <thead>
              <tr>
                <th className="c-idx">#</th>
                <th className="c-mv">
                  ADC 码值
                  <span className="th-sub">0 … {ch.adc.fs}</span>
                </th>
                <th className="c-mv">
                  引脚电压
                  <span className="th-sub">码值推算，只读</span>
                </th>
                <th className="c-mv">
                  实测电压 mV
                  <span className="th-sub">万用表读的总电压</span>
                </th>
                <th className="c-res">
                  与蓝线偏差
                  <span className="th-sub">实测 − 当前标定</span>
                </th>
                <th className="c-act" />
              </tr>
            </thead>
            <tbody>
              {pts.map((p, k) => {
                const pin = pinOf(p.code, ch.adc);
                const d = res.residualsMv[k] ?? 0;
                const pct = p.inMv !== 0 ? (d / p.inMv) * 100 : 0;
                return (
                  <tr key={k}>
                    <td className="c-idx">{k + 1}</td>
                    <td>
                      <NumInput
                        value={p.code}
                        min={0}
                        max={ch.adc.fs}
                        width={92}
                        path={`channels[${index}].calib_points[${k}].code`}
                        onChange={(v) => dispatch({ type: 'patchPoint', index, k, patch: { code: v } })}
                      />
                    </td>
                    <td className="c-pin">
                      <b>{Math.round(pin)}</b> mV
                    </td>
                    <td>
                      <NumInput
                        value={p.inMv}
                        min={0}
                        max={65535}
                        width={92}
                        path={`channels[${index}].calib_points[${k}].in_mv`}
                        onChange={(v) => dispatch({ type: 'patchPoint', index, k, patch: { inMv: v } })}
                      />
                    </td>
                    <td className={`c-res ${d === 0 ? 'zero' : Math.abs(d) > 3 ? 'bad' : 'ok'}`}>
                      <b>{signed(d)}</b> mV
                      <span className="muted"> ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)</span>
                    </td>
                    <td className="c-act">
                      <button
                        className="ghost icon danger"
                        title="删除该点"
                        onClick={() => dispatch({ type: 'removePoint', index, k })}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {report && <p className={`calib-report${report.startsWith('已按') ? ' ok' : ' bad'}`}>{report}</p>}

      {pts.length > 0 && (
        <p className="foot-note">
          当前标定下 RMS <b>{res.rmsMv.toFixed(1)}</b> mV、最大残差 <b>{res.maxAbsMv}</b> mV
          {line && (
            <>
              ；点相对拟合线的最大偏离 <b>{line.maxDevMv.toFixed(1)}</b> mV
              {vmax > 0 && `（量程的 ${((line.maxDevMv / vmax) * 100).toFixed(2)}%）`}
              {line.maxDevMv > Math.max(50, vmax * 0.005) &&
                '——弯曲明显，说明分压回路的非线性已经超出「增益 + 偏置」两个参数能修正的范围，' +
                  '别硬拟合，先查防反二极管的压降随电流的变化'}
            </>
          )}
          。蓝线贴不到红点时，先看增益是否够、再看偏置是否被 ±1000 mV 卡住。
        </p>
      )}
    </div>
  );
}
