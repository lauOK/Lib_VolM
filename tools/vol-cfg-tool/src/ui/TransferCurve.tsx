/**
 * @file    TransferCurve.tsx
 * @brief   通道转换曲线：横轴 = ADC 引脚电压（0 ~ VREF），纵轴 = 换算后的被测电压。
 *
 * 为什么值得单独画：这条线的三个特征正好对应三个配置项，改任何一个都能立刻看见后果——
 *   · 斜率  ← 分压比 (RH+RL)/RL 与增益残差，折叠在 VOL_CHn_SCALE_Q16 里（截断后）
 *   · 截距  ← 偏置残差 VOL_CHn_OFFSET_MV（可为负，运行时用 int64 过渡）
 *   · 折点  ← 量程上限 VOL_CHn_VOLTAGE_MAX_MV，超过后限幅成水平线
 *
 * 数值必须与 C 侧逐位一致，所以直接复用 core/scale 的 BigInt 结果，
 * 而不是用 (RH+RL)/RL 这种"数学上正确、浮点上相似"的写法：
 * 库是"先整除再乘 65536"，截断会让斜率比理想值略小，图上要看得出来。
 *
 * 标定叠加层：红点 = 万用表实测点，红色虚线 = 这些点的最小二乘拟合。
 * 用户调两个残差让蓝线压到红线上；点可拖动，精确数值在下方 CalibPanel 里输入。
 */
import { useMemo, useState } from 'react';

import { fitLine, pinOf } from '../core/calibrate';
import { mvPerLsb, scaleBreakdown } from '../core/scale';
import type { ChannelCfg } from '../model/types';
import { shortName, stateCount, stateRange, voltageMaxMvOf } from '../model/types';

import { bandFill } from './derive';
import { useCfg } from './store';

const W = 760;
const H = 226;
const ML = 50; // 左边距：留纵轴刻度
const MR = 74; // 右边距：留状态名
const MT = 14;
const MB = 40; // 下边距：留刻度 + 轴标题
const PW = W - ML - MR;
const PH = H - MT - MB;

/* 坐标映射抽成模块级工厂：geo 的 useMemo 与组件体共用一份定义，
 * 免得两份闭包各算各的、改了一处忘了另一处（打点拖动也要用同一套换算）。 */
const makePx = (vref: number) => (pinMv: number): number => ML + (pinMv / vref) * PW;
const makePy = (yTop: number) => (mv: number): number => MT + PH - (mv / yTop) * PH;

/** 1 / 2 / 2.5 / 5 / 10 × 10^n，让刻度落在整数上 */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * p;
}

/** mV → 图上文字：≥1000 用 V（最多两位小数，去尾零），否则 mV */
function fmtVolt(mv: number): string {
  if (Math.abs(mv) >= 1000) {
    const v = (mv / 1000).toFixed(2).replace(/\.?0+$/, '');
    return `${v} V`;
  }
  return `${Math.round(mv)} mV`;
}

/** 刻度用短标签：不带宽高单位，单位写在轴标题上 */
function fmtTick(mv: number, inVolt: boolean): string {
  if (inVolt) return (mv / 1000).toFixed(mv % 1000 === 0 ? 0 : 1);
  return String(Math.round(mv));
}

interface Geometry {
  /** 引脚 mV → 换算电压 mV（已限幅、已四舍五入，与 Vol_Calc_Convert 一致） */
  mvAt: (pinMv: number) => number;
  /** 限幅折点处的引脚电压；折点不存在（满量程都没顶到量程）时为 null */
  kneeMv: number | null;
  yAtFs: number;
  yTop: number;
  yStep: number;
  xStep: number;
  points: string;
  inVoltY: boolean;
  inVoltX: boolean;
}

export function TransferCurve({ index, ch }: { index: number; ch: ChannelCfg }) {
  const { dispatch } = useCfg();
  const [hover, setHover] = useState<number | null>(null);
  const [dragK, setDragK] = useState<number | null>(null);

  const vref = ch.adc.vrefMv;
  const fs = ch.adc.fs;
  const vmax = voltageMaxMvOf(ch);
  const offsetUv = ch.calib.offsetMv * 1000;
  const br = useMemo(
    () => scaleBreakdown(ch.adc, ch.divider, ch.calib),
    [ch.adc, ch.divider, ch.calib],
  );

  const geo = useMemo<Geometry | null>(() => {
    if (!(vref > 0) || !(fs > 0) || !(vmax > 0) || !br.fitsU32) return null;
    const scale = Number(br.q16_64);
    if (!(scale > 0)) return null;

    /* 与 C 完全同构：uv = adc × scale >> 16，再 + 偏置，再限幅，最后 +500 取整。
       adc 在这里是连续值（引脚 mV / VREF × FS），因此曲线是直线而非阶梯。 */
    const slopeUvPerMv = (fs * scale) / 65536 / vref;
    const limUv = vmax * 1000;
    const uvAt = (pinMv: number): number => pinMv * slopeUvPerMv + offsetUv;
    const mvAt = (pinMv: number): number => {
      const c = Math.min(Math.max(uvAt(pinMv), 0), limUv);
      return Math.floor((c + 500) / 1000);
    };

    const yAtFs = mvAt(vref);
    const kneeRaw = (limUv - offsetUv) / slopeUvPerMv;
    const kneeMv = kneeRaw > 0 && kneeRaw < vref ? kneeRaw : null;

    // 纵轴要把实测点也装进去，否则打在高量程上的点会被画到框外
    const measuredTop = Math.max(0, ...(ch.calibPoints ?? []).map((p) => p.inMv));
    const yTopRaw = Math.max(vmax, yAtFs, measuredTop, 1);
    const yStep = niceStep(yTopRaw / 4);
    const yTop = Math.ceil(yTopRaw / yStep) * yStep;

    // 折点必须精确落位，否则拐角会被采样步长抹圆
    const xs: number[] = [];
    const seg = kneeMv ?? vref;
    for (let i = 0; i <= 96; i++) xs.push((seg * i) / 96);
    if (kneeMv !== null) xs.push(vref);

    const px = makePx(vref);
    const py = makePy(yTop);
    const points = xs.map((v) => `${px(v).toFixed(1)},${py(mvAt(v)).toFixed(1)}`).join(' ');

    return {
      mvAt,
      kneeMv,
      yAtFs,
      yTop,
      yStep,
      xStep: niceStep(vref / 5),
      points,
      inVoltY: yTop >= 1000,
      inVoltX: vref >= 1000,
    };
  }, [vref, fs, vmax, offsetUv, br, ch.calibPoints]);

  if (!geo) {
    return (
      <p className="foot-note">
        {!br.fitsU32
          ? 'C9 不通过：scale_q16 超出 32 位，换算结果不可信，先修分压/参考电压参数。'
          : '参数不完整（参考电压 / 满量程码值 / 量程需 > 0），暂时画不出转换曲线。'}
      </p>
    );
  }

  const px = makePx(vref);
  const py = makePy(geo.yTop);
  const inVoltY = geo.inVoltY;
  const inVoltX = geo.inVoltX;

  const n = stateCount(ch);
  const hv = hover === null ? null : hover;
  const hvOut = hv === null ? 0 : geo.mvAt(hv);
  const hvState = (() => {
    if (hv === null || n === 0) return null;
    for (let k = 0; k < n; k++) {
      const r = stateRange(ch, k);
      if (r && hvOut >= r.lowerMv && hvOut < r.upperMv) return k;
    }
    return null;
  })();

  // 提示框位置：默认在光标右上方，靠右时翻到左侧，避免被裁掉
  const tipW = 128;
  const tipX = hv === null ? 0 : px(hv) + 10 + tipW > ML + PW ? px(hv) - 10 - tipW : px(hv) + 10;
  const tipY = hv === null ? 0 : Math.max(MT + 2, Math.min(MT + PH - 42, py(hvOut) - 40));

  /* ---------------- 标定叠加层 ---------------- */
  const pts = ch.calibPoints ?? [];
  const fit = pts.length >= 2 ? fitLine(pts, ch.adc) : null;

  /** 拖动红点：水平改码值、垂直改实测电压，都吸附到存储粒度（1 码 / 1 mV） */
  const dragTo = (e: React.PointerEvent<SVGCircleElement>): { code: number; inMv: number } | null => {
    const svg = e.currentTarget.closest('svg');
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    const vy = ((e.clientY - r.top) / r.height) * H;
    const t = Math.min(1, Math.max(0, (vx - ML) / PW));
    return {
      code: Math.round(t * fs),
      inMv: Math.max(0, Math.round(((MT + PH - vy) / PH) * geo.yTop)),
    };
  };

  return (
    <div className="curve-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="curve"
        role="img"
        aria-label={`CH${index} 转换曲线：引脚 0~${vref} mV → 0~${geo.yAtFs} mV`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const vx = ((e.clientX - r.left) / r.width) * W;
          const t = Math.min(1, Math.max(0, (vx - ML) / PW));
          setHover(t * vref);
        }}
      >
        {/* 状态色带：纵轴方向按状态区间铺，能直接看出"这个输出落在哪个状态" */}
        {Array.from({ length: n }, (_, k) => {
          const r = stateRange(ch, k);
          if (!r || r.upperMv <= r.lowerMv) return null;
          const yTopPx = py(Math.min(r.upperMv, geo.yTop));
          const yBotPx = py(Math.max(r.lowerMv, 0));
          return (
            <rect
              key={`band-${k}`}
              x={ML}
              y={yTopPx}
              width={PW}
              height={Math.max(0, yBotPx - yTopPx)}
              fill={bandFill(k)}
            >
              <title>{`S${k} ${shortName(ch.states.mode === 'stateful' ? (ch.states.names[k] ?? '') : '')}  ${r.lowerMv} ~ ${r.upperMv} mV`}</title>
            </rect>
          );
        })}

        {/* 纵轴网格 + 刻度 */}
        {(() => {
          const rows: React.ReactNode[] = [];
          for (let v = 0; v <= geo.yTop + 1e-9; v += geo.yStep) {
            const y = py(v);
            rows.push(
              <g key={`gy-${v}`}>
                <line x1={ML} y1={y} x2={ML + PW} y2={y} stroke="#e2e8f0" strokeWidth={1} />
                <text x={ML - 7} y={y + 3.5} className="curve-tick" textAnchor="end">
                  {fmtTick(v, inVoltY)}
                </text>
              </g>,
            );
          }
          return rows;
        })()}

        {/* 横轴网格 + 刻度 */}
        {(() => {
          const cols: React.ReactNode[] = [];
          for (let v = 0; v <= vref + 1e-9; v += geo.xStep) {
            const x = px(v);
            cols.push(
              <g key={`gx-${v}`}>
                <line x1={x} y1={MT} x2={x} y2={MT + PH} stroke="#eef1f6" strokeWidth={1} />
                <text x={x} y={MT + PH + 15} className="curve-tick" textAnchor="middle">
                  {fmtTick(v, inVoltX)}
                </text>
              </g>,
            );
          }
          return cols;
        })()}

        {/* 坐标轴 */}
        <line x1={ML} y1={MT + PH} x2={ML + PW} y2={MT + PH} stroke="#cbd5e1" />
        <line x1={ML} y1={MT} x2={ML} y2={MT + PH} stroke="#cbd5e1" />

        {/* 量程上限参考线：曲线折到这里就转平 */}
        <line
          x1={ML}
          y1={py(vmax)}
          x2={ML + PW}
          y2={py(vmax)}
          stroke="#94a3b8"
          strokeWidth={1}
          strokeDasharray="4 3"
        />

        {/* 标定叠加层（画在蓝线之前，蓝线压在上面）：红线是实测点的一次拟合 */}
        {fit && (() => {
          // 拟合线可能冲出纵轴，按 yTop 截断后再画，避免"线贴着顶边"造成误读
          const yTopMv = geo.yTop;
          const yAt = (pinMv: number): number => fit.a * pinMv + fit.b;
          const y0 = yAt(0);
          const y1 = yAt(vref);
          if (Math.min(y0, y1) > yTopMv) return null;
          const x0 = y0 > yTopMv ? (yTopMv - fit.b) / fit.a : 0;
          const x1 = y1 > yTopMv ? (yTopMv - fit.b) / fit.a : vref;
          const clamp = (v: number): number => Math.min(yTopMv, Math.max(0, v));
          return (
            <line
              x1={px(x0)}
              y1={py(clamp(yAt(x0)))}
              x2={px(x1)}
              y2={py(clamp(yAt(x1)))}
              stroke="#dc2626"
              strokeWidth={1.8}
              strokeDasharray="7 4"
              opacity={0.85}
            >
              <title>{`实测拟合：in ≈ ${fit.a.toFixed(4)} × pin ${fit.b >= 0 ? '+' : '−'} ${Math.abs(fit.b).toFixed(0)} mV`}</title>
            </line>
          );
        })()}

        {/* 点间连线：肖特基造成的弯曲在这里最直观（直线拟合看不出来的那部分） */}
        {pts.length >= 3 && (
          <polyline
            points={[...pts]
              .sort((p, q) => p.code - q.code)
              .map((p) => `${px(pinOf(p.code, ch.adc)).toFixed(1)},${py(Math.min(geo.yTop, p.inMv)).toFixed(1)}`)
              .join(' ')}
            fill="none"
            stroke="#f87171"
            strokeWidth={1}
            strokeDasharray="2 3"
            opacity={0.75}
          />
        )}

        {/* 转换折线 */}
        <polyline points={geo.points} fill="none" stroke="#2563eb" strokeWidth={2} strokeLinejoin="round" />

        {/* 实测点：拖得动，水平改码值、垂直改实测电压 */}
        {pts.map((p, k) => {
          const cx = px(pinOf(p.code, ch.adc));
          const cy = py(Math.min(geo.yTop, p.inMv));
          return (
            <g key={`pt-${k}`}>
              <circle
                cx={cx}
                cy={cy}
                r={5}
                fill="#dc2626"
                stroke="#ffffff"
                strokeWidth={1.5}
                style={{ cursor: 'grab', touchAction: 'none' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDragK(k);
                }}
                onPointerMove={(e) => {
                  if (dragK !== k) return;
                  const next = dragTo(e);
                  if (!next) return;
                  if (next.code === p.code && next.inMv === p.inMv) return;
                  dispatch({ type: 'patchPoint', index, k, patch: next });
                }}
                onPointerUp={(e) => {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                  setDragK(null);
                }}
                onPointerCancel={() => setDragK(null)}
              >
                <title>{`第 ${k + 1} 点\n码值 ${p.code}（引脚 ${Math.round(pinOf(p.code, ch.adc))} mV）\n实测 ${p.inMv} mV\n拖动可修改`}</title>
              </circle>
              <text x={cx} y={cy - 8} className="curve-pt-idx" textAnchor="middle">
                {k + 1}
              </text>
            </g>
          );
        })}

        {/* 折点：限幅起点 */}
        {geo.kneeMv !== null && (
          <g>
            <line
              x1={px(geo.kneeMv)}
              y1={py(vmax)}
              x2={px(geo.kneeMv)}
              y2={MT + PH}
              stroke="#dc2626"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
            />
            <circle cx={px(geo.kneeMv)} cy={py(vmax)} r={3.4} fill="#dc2626" />
            <text
              x={px(geo.kneeMv) + 6}
              y={py(vmax) - 6}
              className="curve-knee"
              textAnchor={px(geo.kneeMv) > ML + PW * 0.72 ? 'end' : 'start'}
              dx={px(geo.kneeMv) > ML + PW * 0.72 ? 12 : 0}
            >
              {`顶到量程 ${fmtVolt(vmax)}（引脚 ${fmtVolt(Math.round(geo.kneeMv))}）`}
            </text>
          </g>
        )}

        {/* 右侧状态名：带太窄就不标，免得文字互相压住 */}
        {Array.from({ length: n }, (_, k) => {
          const r = stateRange(ch, k);
          if (!r) return null;
          const yTopPx = py(Math.min(r.upperMv, geo.yTop));
          const yBotPx = py(Math.max(r.lowerMv, 0));
          const cy = (yTopPx + yBotPx) / 2;
          if (!(cy > MT + 4 && cy < MT + PH - 2)) return null;
          if (yBotPx - yTopPx < 11) return null;
          const label = `S${k} ${shortName(ch.states.mode === 'stateful' ? (ch.states.names[k] ?? '') : '')}`;
          return (
            <text key={`sn-${k}`} x={ML + PW + 6} y={cy + 3.5} className="curve-state">
              {label.length > 8 ? `${label.slice(0, 8)}…` : label}
            </text>
          );
        })}

        {/* 轴标题 */}
        <text x={ML + PW / 2} y={H - 6} className="curve-axis" textAnchor="middle">
          ADC 引脚电压（{inVoltX ? 'V' : 'mV'}，满量程 = 参考电压）
        </text>
        <text
          x={12}
          y={MT + PH / 2}
          className="curve-axis"
          textAnchor="middle"
          transform={`rotate(-90 12 ${MT + PH / 2})`}
        >
          换算后电压（{inVoltY ? 'V' : 'mV'}）
        </text>

        {/* 悬停读数 */}
        {hv !== null && (
          <g pointerEvents="none">
            <line x1={px(hv)} y1={MT} x2={px(hv)} y2={MT + PH} stroke="#2563eb" strokeWidth={1} opacity={0.45} />
            <circle cx={px(hv)} cy={py(hvOut)} r={4} fill="#2563eb" stroke="#fff" strokeWidth={1.5} />
            <rect
              x={tipX}
              y={tipY}
              width={tipW}
              height={40}
              rx={5}
              fill="#ffffff"
              stroke="#cbd5e1"
              opacity={0.97}
            />
            <text x={tipX + 8} y={tipY + 16} className="curve-tip">
              {`引脚 ${fmtVolt(Math.round(hv))}`}
            </text>
            <text x={tipX + 8} y={tipY + 31} className="curve-tip strong">
              {`→ ${fmtVolt(hvOut)}${hvState !== null ? `　S${hvState}` : ''}`}
            </text>
          </g>
        )}
      </svg>

      {pts.length > 0 && (
        <div className="curve-legend">
          <span className="lg blue" />
          当前标定
          <span className="lg red" />
          实测点 / 拟合线
          <span className="lg red-dash" />
          点间连线（看非线性）
          <span className="lg-hint">拖动红点可改，数值也能在下方表格里精确输入</span>
        </div>
      )}

      <p className="foot-note">
        斜率来自 <code>SCALE_Q16</code>（分压比 × 增益残差，C 侧截断后），截距来自偏置残差{' '}
        {ch.calib.offsetMv >= 0 ? '+' : ''}
        {ch.calib.offsetMv} mV，折点之后限幅到量程 {fmtVolt(vmax)}。实际 ADC 是 {fs + 1} 级台阶，
        每级约 {fmtVolt(Math.round(mvPerLsb(ch.adc, ch.divider) * (1 + ch.calib.gainPpm / 1e6)))} 被测电压；
        鼠标移上去可读任意点的换算结果。
      </p>
    </div>
  );
}
