/**
 * @file    StateTable.tsx
 * @brief   状态与门限合并成一张表：一行 = 一个状态，包含 名称 / 下界 / 上界 / 上行迟滞 /
 *          上行门限 / 下行迟滞 / 下行门限 / C7 占用。
 *
 * 为什么下界不可编辑：S_k 的下界就是 S_{k-1} 的上界，同一个分界只有一个真源。
 * 给两次输入就有机会填出 6000 / 6100 这种自相矛盾的表（靠 C5 编译期才拦得住）。
 * 所以每行只填"上界"，下界自动取上一行的上界，C3/C4/C5/C10 从交互上就不可能违反，
 * 用户只剩 C6（上界倒挂）与 C7（迟滞挤掉区间）需要工具实时提示。
 *
 * 迟滞归属（全库最容易搞反的地方）：
 *   S_k 的上行迟滞存在 boundaries[k].hyst_up_mv      （离开 S_k 才用）
 *   S_k 的下行迟滞存在 boundaries[k-1].hyst_down_mv  （回到 S_k 才用）
 */
import type { ChannelCfg } from '../model/types';

import { NumInput } from './controls';
import { c7Usage, macroOf } from './derive';
import { useCfg, useDiagFlag } from './store';

interface Props {
  index: number;
  ch: ChannelCfg;
}

export function StateTable({ index, ch }: Props) {
  const { model, dispatch } = useCfg();
  if (ch.states.mode !== 'stateful') return null;

  const n = ch.states.names.length;

  return (
    <div className="states">
      <div className="sec-head">
        <h3>状态与门限（电压由低到高）</h3>
        <span className="muted">
          {n} 个 · 上限 {model.module.stateNumMax}
        </span>
        <button
          className="ghost"
          disabled={n >= model.module.stateNumMax}
          title={n >= model.module.stateNumMax ? '已达 VOL_STATE_NUM_MAX' : '在最高一档之上追加'}
          onClick={() => dispatch({ type: 'addState', index })}
        >
          + 增加状态
        </button>
      </div>

      <div className="bt-wrap" data-path={`channels[${index}].states.boundaries`} tabIndex={-1}>
        <table className="bt st">
          <thead>
            <tr>
              <th className="c-state">
                状态
                <span className="th-sub">可改名</span>
              </th>
              <th className="c-mv">
                下界 mV
                <span className="th-sub">= 上一行上界，只读</span>
              </th>
              <th className="c-mv">
                上界 mV
                <span className="th-sub">本行填这一格</span>
              </th>
              <th className="c-hyst">
                上行迟滞
                <span className="th-sub">离开本状态（升）</span>
              </th>
              <th className="c-thr">上行门限</th>
              <th className="c-hyst">
                下行迟滞
                <span className="th-sub">离开本状态（降）</span>
              </th>
              <th className="c-thr">下行门限</th>
              <th className="c-usage">
                C7 占用
                <span className="th-sub">相邻迟滞 / 区间宽</span>
              </th>
              <th className="c-act" />
            </tr>
          </thead>
          <tbody>
            {ch.states.names.map((_, k) => (
              <StateRow key={k} index={index} ch={ch} k={k} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="foot-note">
        <b>下界不用填</b>：S1 的下界自动等于 S0 的上界、S2 的下界等于 S1 的上界……全表只有一个真源，
        不会出现两处不一致。<b>外边界的两格迟滞锁定为 0</b>（首状态没有更低一档可去、末状态没有更高一档可去，C10）。
        一个状态的上下行迟滞都是<b>离开本状态</b>的门限：上行门限 = 上界 + 上行迟滞，高于它才升入高一档；
        下行门限 = 下界 − 下行迟滞，低于它就退回低一档。两档门限之间的差就是回差，用来吃掉纹波。
      </p>
    </div>
  );
}

function StateRow({ index, ch, k }: { index: number; ch: ChannelCfg; k: number }) {
  const { dispatch } = useCfg();
  if (ch.states.mode !== 'stateful') return null;

  const { names, boundaries } = ch.states;
  const n = names.length;
  const isLast = k === n - 1;
  const isFirst = k === 0;

  const b = boundaries[k]!;
  const prev = isFirst ? undefined : boundaries[k - 1]!;

  const lower = prev ? prev.upperMv : 0;
  const upper = b.upperMv;
  const hystUp = isLast ? 0 : b.hystUpMv; // 末状态无上邻，C10 恒 0
  const hystDown = prev ? prev.hystDownMv : 0; // 首状态无下邻，C10 恒 0
  const upThr = upper + hystUp;
  const downThr = lower - hystDown;

  const namePath = `channels[${index}].states.names[${k}]`;
  const upperPath = `channels[${index}].states.boundaries[${k}].upper_mv`;
  const upPath = `channels[${index}].states.boundaries[${k}].hyst_up_mv`;
  const downPath = prev ? `channels[${index}].states.boundaries[${k - 1}].hyst_down_mv` : '';

  const nameFlag = useDiagFlag(namePath);
  const mvFlag = useDiagFlag(upperPath);
  const upFlag = useDiagFlag(isLast ? '' : upPath);
  const downFlag = useDiagFlag(downPath);

  const use = c7Usage(ch, k);
  const pct = use ? Math.min(100, Math.round(use.pct)) : 0;
  const c7bad = use ? use.pct >= 100 : false;
  const bad =
    nameFlag === 'error' || mvFlag === 'error' || upFlag === 'error' || downFlag === 'error' || c7bad;

  return (
    <tr className={bad ? 'bt-row is-bad' : 'bt-row'}>
      <td className="c-state">
        <span className="chip sm">S{k}</span>
        <input
          type="text"
          value={names[k] ?? ''}
          data-path={namePath}
          onChange={(e) => dispatch({ type: 'stateName', index, k, name: e.target.value })}
        />
      </td>

      <td className="c-mv">
        <span className="locked" title={isFirst ? '首状态下界固定为 0（C3）' : `= S${k - 1} 的上界`}>
          {lower}
        </span>
      </td>

      <td className="c-mv">
        <NumInput
          value={upper}
          path={upperPath}
          min={0}
          max={65535}
          onChange={(v) => dispatch({ type: 'boundary', index, k, patch: { upperMv: v } })}
        />
        {isLast && <span className="row-sub">= 量程</span>}
      </td>

      <td className="c-hyst">
        {isLast ? (
          <span className="locked" title="末状态没有上侧邻居，C10 强制为 0">
            0
          </span>
        ) : (
          <NumInput
            value={hystUp}
            path={upPath}
            min={0}
            max={65535}
            onChange={(v) => dispatch({ type: 'boundary', index, k, patch: { hystUpMv: v } })}
          />
        )}
      </td>

      <td className="c-thr">
        {isLast ? (
          <span className="thr is-zero" title="末状态没有向上的跳变">
            —
          </span>
        ) : (
          <span
            className={hystUp > 0 ? 'thr up' : 'thr up is-zero'}
            title={`${macroOf.upper(index, k)} + ${macroOf.hystUp(index, k)} = ${upper} + ${hystUp} = ${upThr} mV`}
          >
            ↑ {upThr}
          </span>
        )}
      </td>

      <td className="c-hyst">
        {isFirst ? (
          <span className="locked" title="首状态没有下侧邻居，C10 强制为 0">
            0
          </span>
        ) : (
          <NumInput
            value={hystDown}
            path={downPath}
            min={0}
            max={65535}
            onChange={(v) =>
              dispatch({ type: 'boundary', index, k: k - 1, patch: { hystDownMv: v } })
            }
          />
        )}
      </td>

      <td className="c-thr">
        {isFirst ? (
          <span className="thr is-zero" title="首状态没有向下的跳变">
            —
          </span>
        ) : (
          <span
            className={hystDown > 0 ? 'thr down' : 'thr down is-zero'}
            title={`${macroOf.lower(index, k)} − ${macroOf.hystDown(index, k)} = ${lower} − ${hystDown} = ${downThr} mV`}
          >
            ↓ {downThr}
          </span>
        )}
      </td>

      <td className="c-usage">
        <span
          className={`usage${c7bad ? ' is-bad' : use && use.pct >= 80 ? ' is-near' : ''}`}
          title={
            use
              ? `两侧迟滞合计 ${use.parts.join(' + ') || '0'} mV，区间宽 ${use.width} mV`
              : ''
          }
        >
          <span className="bar">
            <i style={{ width: `${pct}%` }} />
          </span>
          <em>{use ? `${Math.round(use.pct)}%` : ''}</em>
        </span>
      </td>

      <td className="c-act">
        <button
          className="ghost icon danger"
          disabled={n <= 1}
          title={n <= 1 ? '至少保留一个状态' : '删除该状态'}
          onClick={() => dispatch({ type: 'removeState', index, k })}
        >
          ×
        </button>
      </td>
    </tr>
  );
}
