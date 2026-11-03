/**
 * @file    export.test.ts
 * @brief   无界面导出：vol_cfg.yaml → vol_cfg.h + vol_cfg.c（默认跳过）。
 *
 * UI 的"下载"按钮在浏览器里，自动化/CI 拿不到；本用例把同一条链路
 * （解析 → 结构校验 → 规则校验 → 生成）搬到命令行，产出与界面下载逐字节相同。
 *
 * 用法：
 *   VOLCFG_IN=<工程>/cfg/vol_cfg.yaml VOLCFG_OUT=<临时目录> \
 *     npx vitest run tests/export.test.ts
 *
 * 退出语义：解析失败、存在 error 级诊断、或规则校验有 error，用例即失败；
 * warning（W1~W8）只打印，不阻止导出——与界面一致。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { emitConfigYaml, parseConfigText } from '../src/core/cfgfile';
import { emitFiles } from '../src/core/emit';
import { checkRules } from '../src/core/rules';

const INPUT = process.env['VOLCFG_IN'];
const OUT = process.env['VOLCFG_OUT'];
const ENABLED = Boolean(INPUT && OUT);

describe.skipIf(!ENABLED)('无界面导出', () => {
  it('校验通过并把两份 C 文件写到 VOLCFG_OUT', () => {
    const text = readFileSync(INPUT!, 'utf8');
    const parsed = parseConfigText(text);
    if (!parsed.ok) {
      throw new Error(
        '配置解析失败：\n' +
          parsed.diags.map((d) => `  [${d.code}] ${d.path} ${d.message}`).join('\n'),
      );
    }

    const schemaErrors = parsed.diags.filter((d) => d.severity === 'error');
    expect(schemaErrors, '结构校验不应有 error').toHaveLength(0);

    const rules = checkRules(parsed.model);
    const ruleErrors = rules.filter((d) => d.severity === 'error');
    if (ruleErrors.length > 0) {
      throw new Error(
        '规则校验失败：\n' +
          ruleErrors.map((d) => `  [${d.code}] ${d.path} ${d.message}`).join('\n'),
      );
    }

    const { h, c } = emitFiles(parsed.model);
    mkdirSync(OUT!, { recursive: true });
    writeFileSync(path.join(OUT!, 'vol_cfg.h'), h, 'utf8');
    writeFileSync(path.join(OUT!, 'vol_cfg.c'), c, 'utf8');
    // 规范化后的 yaml：确认"导入再导出"没有丢字段（与输入逐字节相同即无漂移）
    writeFileSync(path.join(OUT!, 'vol_cfg.roundtrip.yaml'), emitConfigYaml(parsed.model), 'utf8');

    const warnings = rules.filter((d) => d.severity === 'warning');
    console.log(`\n== 导出完成：${path.resolve(OUT!)} ==`);
    console.log(`   通道数 ${parsed.model.channels.length}，结构 error 0，规则 error 0，warning ${warnings.length}`);
    for (const w of warnings) console.log(`   [${w.code}] ${w.path} ${w.message}`);
    console.log(`   yaml 与输入${emitConfigYaml(parsed.model) === text ? '逐字节一致' : '存在差异（见 roundtrip 文件）'}`);
  });
});
