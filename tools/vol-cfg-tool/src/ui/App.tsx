/**
 * @file    App.tsx
 * @brief   页面骨架：工具栏 → 模块参数 → 通道卡片 → 校验 → 文件预览。
 *
 * 单页、无路由：这个工具的用法是"填完、看校验、下载覆盖"，不需要第二屏。
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { CONFIG_FILENAME, emitConfigYaml, parseConfigText } from '../core/cfgfile';
import { emitFiles } from '../core/emit';
import { checkRules } from '../core/rules';
import type { ConfigModel } from '../model/types';
import { LIB_VERSION, TOOL_NAME, TOOL_VERSION } from '../version';

import { ChannelCard } from './ChannelCard';
import { DiagnosticsList, locate } from './DiagnosticsList';
import { HelpPanel } from './HelpPanel';
import { ModuleForm } from './ModuleForm';
import { PreviewPane } from './PreviewPane';
import { downloadFiles, downloadText } from './download';
import { CfgCtx, DiagCtx, STORAGE_KEY, initModel, reducer } from './store';

function initFromStorage(_: null): ConfigModel {
  return initModel(
    (k) => localStorage.getItem(k),
    (t) => {
      const r = parseConfigText(t);
      return r.ok ? r.model : null;
    },
  );
}

export function App() {
  const [model, dispatch] = useReducer(reducer, null, initFromStorage);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [activeCh, setActiveCh] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const files = useMemo(() => emitFiles(model), [model]);
  const yaml = useMemo(() => emitConfigYaml(model), [model]);
  const diags = useMemo(() => checkRules(model), [model]);
  const errors = diags.filter((d) => d.severity === 'error');
  const warns = diags.filter((d) => d.severity === 'warning');

  // 通道数可能变少（删除/导入），把当前选中的标签夹回有效范围
  const chIdx = Math.min(activeCh, model.channels.length - 1);
  const ch = model.channels[chIdx]!;

  // 每个通道的最严重诊断级别，用于标签上的小红/黄点
  const chFlags = useMemo(() => {
    const arr: Array<'error' | 'warning' | undefined> = [];
    for (const d of diags) {
      const m = /^channels\[(\d+)\]/.exec(d.path);
      if (!m) continue;
      const i = Number(m[1]);
      if (arr[i] !== 'error') arr[i] = d.severity;
    }
    return arr;
  }, [diags]);

  /** 校验条目点击：目标在别的通道时先切标签，等渲染完再定位 */
  function navigate(path: string): void {
    const m = /^channels\[(\d+)\]/.exec(path);
    if (m && Number(m[1]) !== chIdx) {
      setActiveCh(Number(m[1]));
      window.setTimeout(() => locate(path), 90);
      return;
    }
    locate(path);
  }

  const diagMap = useMemo(() => {
    const m = new Map<string, 'error' | 'warning'>();
    for (const d of diags) {
      if (m.get(d.path) !== 'error') m.set(d.path, d.severity);
    }
    return m;
  }, [diags]);

  // 记住上次会话：存 YAML 文本而不是 JSON，恢复时走同一套校验
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, yaml);
      } catch {
        /* 配额或隐私模式：忽略，不影响使用 */
      }
    }, 300);
    return () => clearTimeout(id);
  }, [yaml]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(id);
  }, [notice]);

  async function importFile(file: File): Promise<void> {
    const parsed = parseConfigText(await file.text());
    if (!parsed.ok) {
      setNotice({
        kind: 'err',
        text: [
          `导入失败：${file.name}（当前配置未改动）`,
          ...parsed.diags.map((d) => `${d.code} ${d.path || '<顶层>'}：${d.message}`),
        ].join('\n'),
      });
      return;
    }
    dispatch({ type: 'load', model: parsed.model });
    const meta = parsed.meta;
    const written = meta?.version
      ? `；由 ${meta.tool ?? TOOL_NAME} v${meta.version} 写出`
      : '；文件未记录生成工具（旧格式）';
    setNotice({
      kind: 'ok',
      text: `已导入 ${file.name}：${parsed.model.channels.length} 个通道，配置按原文载入${written}`,
    });
  }

  return (
    <CfgCtx.Provider value={{ model, dispatch }}>
      <DiagCtx.Provider value={diagMap}>
        <main
          className={`page${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) void importFile(f);
          }}
        >
          <header className="topbar">
            <div className="brand">
              <h1>
                Lib_VolM 配置工具
                <span className="ver" title="工具版本 · 目标库版本">
                  v{TOOL_VERSION} · 库 V{LIB_VERSION}
                </span>
              </h1>
              <p>
                填完即生成 <code>vol_cfg.h</code> + <code>vol_cfg.c</code>，覆盖到{' '}
                <code>inc/</code> 与 <code>src/</code> 即可编译。生成的文件头会写明工具版本与生成日期。
              </p>
            </div>
            <div className="actions">
              <span className={errors.length ? 'badge err' : 'badge ok'}>{errors.length} 错误</span>
              <span className={warns.length ? 'badge warn' : 'badge ok'}>{warns.length} 建议</span>
              <button className="ghost" onClick={() => fileRef.current?.click()}>
                导入配置
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".yaml,.yml,.json,text/yaml,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = '';
                }}
              />
              <button className="ghost" onClick={() => downloadText(CONFIG_FILENAME, yaml)}>
                导出配置
              </button>
              <button
                className="primary"
                disabled={errors.length > 0}
                title={errors.length ? `${errors.length} 个错误未修正，生成的代码必然编译失败` : '一次下载两份文件'}
                onClick={() =>
                  downloadFiles([
                    { filename: 'vol_cfg.h', text: files.h },
                    { filename: 'vol_cfg.c', text: files.c },
                  ])
                }
              >
                下载 vol_cfg.h + vol_cfg.c
              </button>
            </div>
          </header>

          {notice && (
            <pre className={`notice ${notice.kind}`} onClick={() => setNotice(null)} title="点击关闭">
              {notice.text}
            </pre>
          )}

          <HelpPanel />

          <section className="card">
            <details className="details" open>
              <summary>
                模块参数
                <span className="muted">期望采样周期、断言上限（不影响换算结果）</span>
              </summary>
              <ModuleForm />
            </details>
          </section>

          <section className="section-head">
            <h2>
              通道配置
              <span className="muted">
                {model.channels.length} / {model.module.channelNumMax} 路
              </span>
            </h2>
            <span className="spacer" />
            <button
              className="ghost"
              disabled={model.channels.length >= model.module.channelNumMax}
              title={
                model.channels.length >= model.module.channelNumMax
                  ? '已达 VOL_CHANNEL_NUM_MAX'
                  : '追加一个通道并切换过去'
              }
              onClick={() => {
                dispatch({ type: 'addChannel' });
                setActiveCh(model.channels.length); // 追加后新通道的下标
              }}
            >
              + 添加通道
            </button>
          </section>

          {model.channels.length === 0 ? (
            <section className="card empty-ch">
              <p>
                还没有通道。点右上角
                <button
                  className="ghost"
                  onClick={() => {
                    dispatch({ type: 'addChannel' });
                    setActiveCh(0);
                  }}
                >
                  + 添加通道
                </button>
                按 default 预设模板新建一路，或导入一份 <code>vol_cfg.yaml</code>。
              </p>
            </section>
          ) : (
            <>
              <nav className="ch-tabs" aria-label="通道切换">
                {model.channels.map((c, i) => (
                  <button
                    key={i}
                    className={`ch-tab${i === chIdx ? ' active' : ''}`}
                    title={c.name}
                    onClick={() => setActiveCh(i)}
                  >
                    CH{i}
                    {chFlags[i] === 'error' && <i className="dot err" />}
                    {chFlags[i] === 'warning' && <i className="dot warn" />}
                  </button>
                ))}
              </nav>

              <ChannelCard key={chIdx} index={chIdx} ch={ch} total={model.channels.length} />
            </>
          )}

          <section className="card">
            <DiagnosticsList diags={diags} onLocate={navigate} />
          </section>

          <section className="card">
            <PreviewPane files={files} yaml={yaml} />
          </section>

          <footer className="foot">
            <span>
              配置写入 <code>vol_cfg.yaml</code> 存档；生成的两份 C 文件里带"由工具生成"字样，
              下次改配置请回工具里改，不要手改 C 文件。
            </span>
          </footer>
        </main>
      </DiagCtx.Provider>
    </CfgCtx.Provider>
  );
}
