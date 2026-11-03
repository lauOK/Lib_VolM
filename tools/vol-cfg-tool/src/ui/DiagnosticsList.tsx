/**
 * @file    DiagnosticsList.tsx
 * @brief   校验结果：规则编号 + 字段路径 + 具体数值，点击定位到出问题的输入框。
 *
 * 编号口径与 C 侧断言 tag 对齐（C7 ↔ c7_CHn_k），用户拿着工具的提示去搜生成的
 * 文件能直接找到那一条；W 类是工程建议，不阻止下载。
 */
import type { Diagnostic } from '../model/types';

const RULE_LEGEND: Array<[string, string]> = [
  ['C1', '通道数 / 状态数容量'],
  ['C3', '首状态下界必须为 0'],
  ['C4', '末状态上界 = 量程'],
  ['C5', '相邻状态无缝衔接'],
  ['C6', '状态区间非空（边界严格递增）'],
  ['C7', '两侧迟滞不得挤掉状态区间'],
  ['C8', '滤波窗口 1..VOL_FILTER_WINDOW_MAX'],
  ['C9', '定点系数不溢出 32 位'],
  ['C10', '首末状态的外侧迟滞必须为 0'],
  ['C11', 'ADC / 分压 / 标定 / 量程取值范围'],
  ['W1', '量程高于分压满量程（ADC 先饱和）'],
  ['W2', '迟滞过薄，纹波可能反复穿越'],
  ['W3', '建立时间过长，短跌落被抹平'],
  ['W4', '分辨率偏粗'],
  ['W5', '状态重名'],
  ['W6', '偏置过大，确认不是手误'],
  ['W7', '滤波时长不是采样周期的整数倍'],
  ['W8', '上臂电阻为 0（分压直连）'],
];

/** 逐级去掉末尾段找最近的输入框：`a.b[0].c` → `a.b[0]` → `a.b` → `a`。
 *  导出供 App 的 navigate 复用（标签页模式下要先切通道再定位）。 */
export function locate(path: string): void {
  let p = path;
  for (let guard = 0; guard < 8 && p; guard++) {
    const el = document.querySelector<HTMLElement>(`[data-path="${p}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        el.select();
      } else {
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1200);
      }
      return;
    }
    p = p.replace(/(\.[A-Za-z_][\w]*|\[\d+\])$/, '');
  }
}

export function DiagnosticsList({
  diags,
  onLocate,
}: {
  diags: Diagnostic[];
  /** 标签页模式下由 App 提供：目标通道不在前台时先切过去再定位 */
  onLocate?: (path: string) => void;
}) {
  const errors = diags.filter((d) => d.severity === 'error');
  const warns = diags.filter((d) => d.severity === 'warning');
  const sorted = [...errors, ...warns];

  return (
    <div className="diag-wrap">
      <div className="sec-head">
        <h2>校验</h2>
        <span className={errors.length ? 'badge err' : 'badge ok'}>{errors.length} 个错误</span>
        <span className={warns.length ? 'badge warn' : 'badge ok'}>{warns.length} 个建议</span>
        <span className="spacer" />
        <details className="legend">
          <summary>规则对照表</summary>
          <dl>
            {RULE_LEGEND.map(([code, text]) => (
              <div key={code}>
                <dt>{code}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>

      {sorted.length === 0 ? (
        <p className="ok-line">没有发现问题：这份配置生成的 C 文件可以通过全部编译期断言。</p>
      ) : (
        <ul className="diag-list">
          {sorted.map((d, k) => (
            <li
              key={`${d.code}-${d.path}-${k}`}
              className={d.severity}
              onClick={() => (onLocate ?? locate)(d.path)}
              title="点击定位到对应输入"
            >
              <span className={`code ${d.severity}`}>{d.code}</span>
              <code className="path">{d.path || '<顶层>'}</code>
              <span className="msg">{d.message}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="foot-note">
        C 类错误会阻止下载（生成的代码必然编译失败）；W 类只是工程建议，可以带着它出文件。
      </p>
    </div>
  );
}
