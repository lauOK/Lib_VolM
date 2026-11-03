/**
 * @file    PreviewPane.tsx
 * @brief   双文件 + YAML 实时预览：行号、轻量高亮、复制。
 *
 * 这里展示的就是"下载后原样覆盖"的内容，不做任何美化或省略——
 * 用户可以直接对照 IAR 里的文件确认差异。
 */
import { useMemo, useState } from 'react';

import { highlight } from './highlight';

export interface GenFiles {
  h: string;
  c: string;
}

type Tab = 'h' | 'c' | 'yaml';

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'h', label: 'inc/vol_cfg.h', hint: '宏定义、断言、通道参数' },
  { id: 'c', label: 'src/vol_cfg.c', hint: '状态表 + 断言块 + 配置表' },
  { id: 'yaml', label: 'vol_cfg.yaml', hint: '配置源（可入库、可 diff）' },
];

export function PreviewPane({ files, yaml }: { files: GenFiles; yaml: string }) {
  const [tab, setTab] = useState<Tab>('h');
  const [copied, setCopied] = useState(false);

  const text = tab === 'h' ? files.h : tab === 'c' ? files.c : yaml;
  const lines = useMemo(() => highlight(tab === 'yaml' ? 'yaml' : 'c', text), [tab, text]);
  const shown = text.endsWith('\n') ? lines.slice(0, -1) : lines;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="preview-wrap">
      <div className="preview-head">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} title={t.hint} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="muted">
          {shown.length} 行 · {Math.round(new Blob([text]).size / 1024)} KB
        </span>
        <button className="ghost" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className="code-view">
        {shown.map((segs, i) => (
          <div className="code-line" key={i}>
            <span className="ln">{i + 1}</span>
            <code>
              {segs.map((s, j) =>
                s.cls ? (
                  <span key={j} className={s.cls}>
                    {s.text}
                  </span>
                ) : (
                  <span key={j}>{s.text}</span>
                ),
              )}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}
