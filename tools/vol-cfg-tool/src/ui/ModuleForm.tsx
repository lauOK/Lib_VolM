/**
 * @file    ModuleForm.tsx
 * @brief   模块级参数（对应生成文件 §1）。这些值只影响编译期断言，不影响换算结果，
 *          所以放在最上面、默认折叠收起。
 */
import type { ModuleCfg } from '../model/types';
import { STATE_NUM_CAP } from '../core/rules';

import { NumField } from './controls';
import { useCfg } from './store';

export function ModuleForm() {
  const { model, dispatch } = useCfg();
  const m = model.module;
  const set = (patch: Partial<ModuleCfg>): void => dispatch({ type: 'module', patch });

  return (
    <div className="grid">
      <NumField
        label="采样周期"
        unit="ms"
        value={m.samplePeriodMs}
        min={1}
        hint="by_time 滤波按它折算窗口点"
        path="module.sample_period_ms"
        onChange={(v) => set({ samplePeriodMs: v })}
      />
      <NumField
        label="窗口上限"
        unit="点"
        value={m.filterWindowMax}
        min={1}
        max={1024}
        hint="断言用"
        path="module.filter_window_max"
        onChange={(v) => set({ filterWindowMax: v })}
      />
      <NumField
        label="状态数上限"
        unit="个"
        value={m.stateNumMax}
        min={1}
        max={STATE_NUM_CAP}
        hint="断言用"
        path="module.state_num_max"
        onChange={(v) => set({ stateNumMax: v })}
      />
      <NumField
        label="通道数上限"
        unit="路"
        value={m.channelNumMax}
        min={1}
        hint="断言用"
        path="module.channel_num_max"
        onChange={(v) => set({ channelNumMax: v })}
      />
      <NumField
        label="分压电阻上限"
        unit="Ω"
        value={m.rMaxOhm}
        min={1}
        hint="断言用"
        path="module.r_max_ohm"
        onChange={(v) => set({ rMaxOhm: v })}
      />
      <label className="field wide">
        <span className="lbl">
          模块说明
          <span className="hint">可选，写进生成文件 §2 标题行</span>
        </span>
        <span className="ipt">
          <input
            type="text"
            value={m.comment ?? ''}
            placeholder="例：SA427L3 电源管理，12 V 系统"
            onChange={(e) => set({ comment: e.target.value || undefined })}
          />
        </span>
      </label>
    </div>
  );
}
