/**
 * @file    VoltageBand.tsx
 * @brief   手写 SVG 电压带：一眼看出"到底几伏切状态"和回差有多宽。
 *
 * 画法：每个状态一段色带；每条内部边界画一条虚线（边界值）+ 一条半透明色块
 * （从 ↓门限 到 ↑门限，即回差带）。悬停色块能看到它由哪两个宏算出来。
 * 不引图表库：这里要的是精确坐标，不是统计图。
 */
import type { ChannelCfg } from '../model/types';
import { shortName, stateCount, stateRange, voltageMaxMvOf } from '../model/types';

import { bandFill, makeScale } from './derive';

const W = 760;
const H = 118;
const LEFT = 14;
const RIGHT = 746;
const BAND_Y = 38;
const BAND_H = 32;

export function VoltageBand({ index, ch }: { index: number; ch: ChannelCfg }) {
  const n = stateCount(ch);
  const vmax = voltageMaxMvOf(ch);
  const x = makeScale(vmax, LEFT, RIGHT);

  if (vmax <= 0) {
    return <p className="foot-note">量程为 0，无法画电压带。</p>;
  }

  return (
    <div className="band-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="band" role="img" aria-label={`CH${index} 电压带`}>
        {/* 状态色带 */}
        {n === 0 ? (
          <>
            <rect x={LEFT} y={BAND_Y} width={RIGHT - LEFT} height={BAND_H} fill="#eef2f8" />
            <text x={(LEFT + RIGHT) / 2} y={BAND_Y + BAND_H / 2 + 4} className="band-label">
              仅测量通道（STATE_NUM = 0）
            </text>
          </>
        ) : (
          Array.from({ length: n }, (_, k) => {
            const r = stateRange(ch, k);
            if (!r) return null;
            const x1 = x(r.lowerMv);
            const x2 = x(r.upperMv);
            const w = x2 - x1;
            const name = shortName(ch.states.mode === 'stateful' ? (ch.states.names[k] ?? '') : '');
            return (
              <g key={k}>
                <rect x={x1} y={BAND_Y} width={Math.max(0, w)} height={BAND_H} fill={bandFill(k)} />
                <title>{`S${k} ${name}  ${r.lowerMv} ~ ${r.upperMv} mV`}</title>
                {w >= 26 && (
                  <text x={(x1 + x2) / 2} y={BAND_Y + BAND_H / 2 + 4} className="band-label">
                    {w >= Math.min(name.length * 11 + 18, 150) ? `S${k} ${name}` : `S${k}`}
                  </text>
                )}
              </g>
            );
          })
        )}

        {/* 回差带与门限 */}
        {ch.states.mode === 'stateful' &&
          ch.states.boundaries.slice(0, Math.max(0, n - 1)).map((b, k) => {
            const xb = x(b.upperMv);
            const up = b.upperMv + b.hystUpMv;
            const down = b.upperMv - b.hystDownMv;
            const xd = x(down);
            const xu = x(up);
            return (
              <g key={k}>
                <rect
                  x={Math.min(xd, xu)}
                  y={BAND_Y}
                  width={Math.max(1, Math.abs(xu - xd))}
                  height={BAND_H}
                  fill="#f59e0b"
                  opacity={b.hystUpMv + b.hystDownMv > 0 ? 0.22 : 0.06}
                >
                  <title>
                    {`b${k + 1} = ${b.upperMv} mV\n` +
                      `S${k} 上行迟滞 ${b.hystUpMv} → 升到 ${up} mV 才切走\n` +
                      `S${k + 1} 下行迟滞 ${b.hystDownMv} → 降到 ${down} mV 才切回`}
                  </title>
                </rect>
                <line
                  x1={xb}
                  y1={BAND_Y - 8}
                  x2={xb}
                  y2={BAND_Y + BAND_H + 8}
                  stroke="#94a3b8"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <text x={xb} y={BAND_Y - 13} className="band-tick">
                  {b.upperMv}
                </text>
                {b.hystUpMv > 0 && (
                  <>
                    <line x1={xu} y1={BAND_Y - 6} x2={xu} y2={BAND_Y} stroke="#b45309" strokeWidth={1.5} />
                    <text x={xu} y={BAND_Y + BAND_H + 14} className="band-thr up">
                      ↑{up}
                    </text>
                  </>
                )}
                {b.hystDownMv > 0 && (
                  <>
                    <line
                      x1={xd}
                      y1={BAND_Y + BAND_H}
                      x2={xd}
                      y2={BAND_Y + BAND_H + 6}
                      stroke="#b45309"
                      strokeWidth={1.5}
                    />
                    <text x={xd} y={BAND_Y + BAND_H + 14} className="band-thr down">
                      ↓{down}
                    </text>
                  </>
                )}
              </g>
            );
          })}

        {/* 轴 */}
        <line x1={LEFT} y1={BAND_Y + BAND_H + 24} x2={RIGHT} y2={BAND_Y + BAND_H + 24} stroke="#cbd5e1" />
        <text x={LEFT} y={BAND_Y + BAND_H + 40} className="band-axis">
          0 mV
        </text>
        <text x={RIGHT} y={BAND_Y + BAND_H + 40} className="band-axis" textAnchor="end">
          {vmax} mV（量程上限）
        </text>

        {/* 点选：跳到边界表对应行 */}
        {ch.states.mode === 'stateful' &&
          ch.states.boundaries.slice(0, Math.max(0, n - 1)).map((b, k) => (
            <rect
              key={`hit-${k}`}
              x={x(b.upperMv) - 7}
              y={BAND_Y - 8}
              width={14}
              height={BAND_H + 16}
              fill="transparent"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                const el = document.querySelector<HTMLInputElement>(
                  `[data-path="channels[${index}].states.boundaries[${k}].upper_mv"]`,
                );
                el?.focus();
                el?.select();
              }}
            />
          ))}
      </svg>
      <p className="foot-note">
        淡黄色块 = 回差带：在这段电压里，状态取决于「从哪边来」。带越宽越抗纹波，但太宽会吃掉相邻状态的区间（C7）。
      </p>
    </div>
  );
}
