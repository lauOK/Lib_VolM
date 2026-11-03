/**
 * @file    version.test.ts
 * @brief   版本契约：生成物带版本与日期、yaml 记录工具版本、格式只向下兼容。
 *
 * 这一组测试守的是"文件出门之后的追溯能力"与"工具升级不炸老配置"两件事，
 * 所以断言都落在文本与诊断编号上，不看实现细节。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { emitConfigYaml, parseConfigText, runMigrations, type Migration } from '../src/core/cfgfile';
import { emitFiles } from '../src/core/emit';
import { emitH } from '../src/core/emit/h';
import { presetDefault } from '../src/model/presets';
import { SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION, LIB_VERSION, checkSchemaCompat, formatStamp } from '../src/version';
import { codeLines } from './helpers/compare';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string };

const model = presetDefault();

/** 固定日期，保证断言稳定 */
const DAY = new Date(2026, 0, 5, 9, 30, 0);

/** 去掉 generator 段（模拟旧版工具写出的文件：那时还没有这个字段） */
function legacyText(): string {
  const lines = emitConfigYaml(model).split('\n');
  const i = lines.findIndex((l) => l.startsWith('generator:'));
  expect(i).toBeGreaterThan(0);
  // generator: / tool / version / 空行
  lines.splice(i, 4);
  return lines.join('\n');
}

/** 换一个 schema 号 */
function withSchema(schema: string): string {
  return legacyText().replace(/^schema: .*$/m, `schema: ${schema}`);
}

describe('工具版本与 package.json 同步', () => {
  it('TOOL_VERSION 与 package.json 的 version 一致（改版本必须两边一起改）', () => {
    expect(TOOL_VERSION).toBe(PKG.version);
  });

  it('工具名与包名一致', () => {
    expect(TOOL_NAME).toBe(PKG.name);
  });

  it('格式版本由族名和数字拼成', () => {
    expect(SCHEMA_VERSION).toMatch(/^volm-cfg\/\d+$/);
  });

  it('日期格式为 YYYY-MM-DD，且补零', () => {
    expect(formatStamp(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(formatStamp(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('生成的 C 文件带工具版本与生成日期', () => {
  const gen = emitFiles(model, { now: DAY });

  it('两份文件的文件头都有 @note 行（含工具版本、日期、目标库版本、配置格式）', () => {
    const note =
      ` * @note    由 ${TOOL_NAME} v${TOOL_VERSION} 生成于 2026-01-05` +
      `（目标库 Lib_VolM V${LIB_VERSION} · 配置格式 ${SCHEMA_VERSION}）`;
    for (const text of [gen.h, gen.c]) {
      expect(text.split('\n').slice(0, 15)).toContain(note);
    }
  });

  it('@note 里的目标库版本必须等于 inc/vol.h 的 VOL_VERSION_STRING', () => {
    // 这条守的是"库里改了版本、工具没跟"：两个号分处两个文件，只能靠测试咬住
    const volH = readFileSync(fileURLToPath(new URL('../../../inc/vol.h', import.meta.url)), 'utf8');
    const major = volH.match(/#define\s+VOL_VERSION_MAJOR\s+(\d+)/)?.[1];
    const minor = volH.match(/#define\s+VOL_VERSION_MINOR\s+(\d+)/)?.[1];
    const str = volH.match(/#define\s+VOL_VERSION_STRING\s+"([^"]+)"/)?.[1];

    expect(major, 'inc/vol.h 里找不到 VOL_VERSION_MAJOR').toBeDefined();
    expect(minor, 'inc/vol.h 里找不到 VOL_VERSION_MINOR').toBeDefined();
    expect(str, 'inc/vol.h 里找不到 VOL_VERSION_STRING').toBeDefined();

    // 三个宏内部自洽（1 + 4 → "1.4"），再与工具侧常量对齐
    expect(str).toBe(`${major}.${minor}`);
    expect(LIB_VERSION).toBe(str);
  });

  it('@note 紧跟 @brief，不会被塞进正文中间', () => {
    for (const text of [gen.h, gen.c]) {
      const lines = text.split('\n');
      const b = lines.findIndex((l) => /^ \* @brief\b/.test(l));
      expect(b).toBeGreaterThanOrEqual(0);
      expect(lines[b + 1]).toMatch(/^ \* @note {4}由 vol-cfg-tool v/);
    }
  });

  it('生成信息只是注释，代码行与不带生成信息时一致', () => {
    expect(codeLines(gen.h)).toEqual(codeLines(emitH(model)));
    expect(gen.h.replace(/^ \* @note {4}.*\n/m, '')).toBe(emitH(model));
  });

  it('日期可注入：同一天两次生成逐字节相同，换一天只差那一行', () => {
    const a = emitFiles(model, { now: DAY });
    const b = emitFiles(model, { now: new Date(2026, 0, 5, 23, 59, 59) });
    expect(a).toEqual(b);

    const c = emitFiles(model, { now: new Date(2026, 0, 6) });
    const la = a.h.split('\n');
    const lc = c.h.split('\n');
    expect(la.length).toBe(lc.length);
    const diff = la.map((l, i) => [l, lc[i]!] as const).filter(([x, y]) => x !== y);
    expect(diff).toHaveLength(1);
    expect(diff[0]![1]).toContain('2026-01-06');
  });

  it('默认取当天日期（不传 now 时也是合法日期）', () => {
    const now = new Date();
    const text = emitFiles(model).h;
    expect(text).toContain(`生成于 ${formatStamp(now)}`);
  });
});

describe('yaml 记录工具版本（不记录日期，保持可复现）', () => {
  const yaml = emitConfigYaml(model);

  it('generator 段写出工具名与版本', () => {
    expect(yaml).toContain('generator:');
    expect(yaml).toContain(`  tool: ${TOOL_NAME}`);
    expect(yaml).toContain(`  version: '${TOOL_VERSION}'`);
  });

  it('schema 独占一行、格式版本与常量一致', () => {
    expect(yaml.split('\n')).toContain(`schema: ${SCHEMA_VERSION}`);
  });

  it('头部注释写明目标库版本（yaml 字段不变，只是注释）', () => {
    expect(yaml).toContain(`目标库 V${LIB_VERSION}`);
    // 只加注释，不动字段：旧版工具读这份文件仍按老规则解析
    expect(yaml).not.toMatch(/^lib:/m);
  });

  it('没有日期，重复导出逐字节相同', () => {
    expect(yaml).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(emitConfigYaml(model)).toBe(yaml);
  });

  it('导出 → 解析 → 再导出，generator 段原样保留', () => {
    const back = parseConfigText(yaml);
    expect(back.ok).toBe(true);
    if (back.ok) expect(emitConfigYaml(back.model)).toBe(yaml);
  });

  it('解析后能读到 generator 信息（UI 用来提示"这份文件是谁写的"）', () => {
    const back = parseConfigText(yaml);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.meta).toEqual({ tool: TOOL_NAME, version: TOOL_VERSION });
  });
});

describe('兼容性：向下兼容，不向上兼容', () => {
  it('旧文件没有 generator 段：照读，meta 为空', () => {
    const r = parseConfigText(legacyText());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta).toBeUndefined();
      expect(r.model).toEqual(model);
    }
  });

  it('格式号比本工具新：F2 报错，并提示升级工具', () => {
    const r = parseConfigText(withSchema('volm-cfg/2'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const d = r.diags.find((x) => x.code === 'F2' && x.path === 'schema');
    expect(d, r.diags.map((x) => x.code).join(',')).toBeTruthy();
    expect(d!.message).toContain('新');
    expect(d!.message).toContain('升级');
  });

  it('格式号比本工具旧但没有升级路径：F2 报错（不猜着读）', () => {
    const r = parseConfigText(withSchema('volm-cfg/0'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const d = r.diags.find((x) => x.code === 'F2' && x.path === 'schema');
    expect(d).toBeTruthy();
    expect(d!.message).toContain('旧');
    expect(d!.message).toContain('升级步骤');
  });

  it('族名不对：F2 报错，指出这不是 vol_cfg.yaml', () => {
    const r = parseConfigText(withSchema('other-cfg/1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diags.some((x) => x.code === 'F2' && x.path === 'schema')).toBe(true);
  });

  it('版本写法坏了（缺版本号）：F2 报错', () => {
    const r = parseConfigText(withSchema('volm-cfg'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diags.some((x) => x.code === 'F2' && x.path === 'schema')).toBe(true);
  });

  it('缺 schema / 非字符串：F4 / F2 报错', () => {
    const noSchema = emitConfigYaml(model).replace(/^schema: .*$/m, '');
    const r1 = parseConfigText(noSchema);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.diags.some((x) => x.code === 'F4' && x.path === 'schema')).toBe(true);

    const r2 = parseConfigText(emitConfigYaml(model).replace(/^schema: .*$/m, 'schema: 1'));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.diags.some((x) => x.code === 'F2' && x.path === 'schema')).toBe(true);
  });

  it('版本判定函数本身：current / older / newer / foreign / malformed', () => {
    expect(checkSchemaCompat(SCHEMA_VERSION)).toEqual({ kind: 'current' });
    expect(checkSchemaCompat('volm-cfg/0')).toEqual({ kind: 'older', version: 0 });
    expect(checkSchemaCompat('volm-cfg/9')).toEqual({ kind: 'newer', version: 9 });
    expect(checkSchemaCompat('foo-cfg/1')).toEqual({ kind: 'foreign', family: 'foo-cfg' });
    expect(checkSchemaCompat('volm-cfg')).toEqual({ kind: 'malformed' });
  });
});

describe('generator 段的校验（写坏了不影响配置，但必须指出来）', () => {
  function withGenerator(block: string): string {
    return legacyText().replace(
      `schema: ${SCHEMA_VERSION}`,
      `schema: ${SCHEMA_VERSION}\n\n${block}\n`,
    );
  }

  it('未知字段：F3', () => {
    const r = parseConfigText(withGenerator('generator:\n  tool: vol-cfg-tool\n  version: 0.2.0\n  date: 2026-01-05'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diags.some((x) => x.code === 'F3' && x.path === 'generator.date')).toBe(true);
  });

  it('不是映射：F5', () => {
    const r = parseConfigText(withGenerator('generator: vol-cfg-tool 0.2.0'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diags.some((x) => x.code === 'F5' && x.path === 'generator')).toBe(true);
  });

  it('版本号不是 主.次.修订：F5', () => {
    const r = parseConfigText(withGenerator('generator:\n  tool: vol-cfg-tool\n  version: v0.2'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diags.some((x) => x.code === 'F5' && x.path === 'generator.version')).toBe(true);
  });
});

describe('升级链（migrate）机制：只为下次升格式时能用', () => {
  const table: Record<number, Migration> = {
    1: (r) => ({ ...r, one: true }),
    2: (r) => ({ ...r, two: true }),
  };

  it('逐级执行，记录走过的版本', () => {
    const r = runMigrations({ a: 1 }, 1, 3, table);
    expect(r.ok).toBe(true);
    expect(r.raw).toMatchObject({ a: 1, one: true, two: true });
    expect(r.applied).toEqual([1, 2]);
  });

  it('缺任何一级就整体失败，并指出缺哪一级', () => {
    const r = runMigrations({ a: 1 }, 1, 3, { 1: table[1]! });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(2);
    expect(r.raw).toEqual({ a: 1, one: true });
  });

  it('源版本即目标版本：什么都不做', () => {
    const r = runMigrations({ a: 1 }, 3, 3, table);
    expect(r).toEqual({ ok: true, raw: { a: 1 }, applied: [] });
  });

  it('不改动调用方传入的原始文档', () => {
    const src = { a: 1 };
    runMigrations(src, 1, 3, table);
    expect(src).toEqual({ a: 1 });
  });

  it('默认升级表为空——当前只有 volm-cfg/1，没有更旧的格式', () => {
    expect(runMigrations({ a: 1 }, 1, 2).ok).toBe(false);
  });
});
