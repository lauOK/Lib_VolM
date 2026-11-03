/**
 * @file    controls.tsx
 * @brief   表单原语：数值 / 文本 / 下拉。
 *
 * 数值输入用"草稿"策略：输入过程中只更新本地草稿，解析成功才写回模型。
 * 这样删空输入框、敲一个负号不会把模型打成 NaN，也不会让整棵生成器崩掉；
 * 失焦时草稿丢弃、回到模型值，用户看到的就是"没生效"。
 */
import { useState } from 'react';

import { useDiagFlag } from './store';

interface NumInputProps {
  value: number;
  onChange: (v: number) => void;
  /** 与 rules.ts / schema.ts 一致的字段路径，用于对齐校验提示 */
  path: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  width?: number;
  className?: string;
}

/** 裸数字输入框（无标签），供表格单元格复用 */
export function NumInput({
  value,
  onChange,
  path,
  min,
  max,
  step = 1,
  disabled,
  width = 88,
  className,
}: NumInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const flag = useDiagFlag(path);
  return (
    <input
      type="number"
      inputMode="numeric"
      className={`num${flag ? ` is-${flag}` : ''}${className ? ` ${className}` : ''}`}
      value={draft ?? String(value)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      data-path={path}
      style={width ? { width } : undefined}
      onChange={(e) => {
        const t = e.target.value;
        setDraft(t);
        if (t.trim() === '') return;
        const n = Number(t);
        if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

interface NumFieldProps extends NumInputProps {
  label: string;
  unit?: string;
  hint?: string;
}

export function NumField({ label, unit, hint, ...rest }: NumFieldProps) {
  const flag = useDiagFlag(rest.path);
  return (
    <label className={`field${flag ? ` is-${flag}` : ''}${rest.disabled ? ' is-off' : ''}`}>
      <span className="lbl">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
      <span className="ipt">
        <NumInput {...rest} />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </label>
  );
}

interface TextProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  path: string;
  placeholder?: string;
  hint?: string;
  width?: number;
}

export function TextField({ label, value, onChange, path, placeholder, hint, width }: TextProps) {
  const flag = useDiagFlag(path);
  return (
    <label className={`field${flag ? ` is-${flag}` : ''}`}>
      <span className="lbl">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
      <span className="ipt">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          data-path={path}
          style={width ? { width } : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
}

interface SelectProps<T extends string> {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  path: string;
  hint?: string;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  path,
  hint,
}: SelectProps<T>) {
  const flag = useDiagFlag(path);
  return (
    <label className={`field${flag ? ` is-${flag}` : ''}`}>
      <span className="lbl">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
      <span className="ipt">
        <select value={value} data-path={path} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}
