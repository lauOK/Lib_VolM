/**
 * @file    dump.test.ts
 * @brief   开发期工具（默认跳过）：把库示例配置的生成结果与"注释级差异清单"写到临时目录，
 *          方便人工评审生成文件的措辞。运行：VOLCFG_DUMP=1 npx vitest run tests/dump.test.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import { emitFiles } from '../src/core/emit';
import { emitConfigYaml } from '../src/core/cfgfile';
import { presetDefault, presetLibrary } from '../src/model/presets';
import { modelFiveChannels } from './helpers/models';
import { analyze, diffHunks, dropLines } from './helpers/compare';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TOOL_ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(tmpdir(), 'volcfg-dump');

describe.skipIf(!process.env.VOLCFG_DUMP)('dump 生成结果与注释差异', () => {
  it('写出文件与报告', () => {
    mkdirSync(OUT, { recursive: true });
    const bare = emitFiles(presetLibrary());
    writeFileSync(path.join(OUT, 'vol_cfg.h'), bare.h, 'utf8');
    writeFileSync(path.join(OUT, 'vol_cfg.c'), bare.c, 'utf8');

    const refH = readFileSync(REPO_ROOT + 'inc/vol_cfg.h', 'utf8');
    const refC = dropLines(readFileSync(REPO_ROOT + 'src/vol_cfg.c', 'utf8'), [[125, 131]]);

    const report = [
      '# vol_cfg.h 与手写原件的逐行差异（应全部落在注释上）',
      ...diffHunks(analyze(bare.h).raw, analyze(refH).raw).map((h) => {
        const minus = h.removed.map((l) => `- [原 ${l.no}] ${l.text}`).join('\n');
        const plus = h.added.map((l) => `+ [新 ${l.no}] ${l.text}`).join('\n');
        return [minus, plus].filter(Boolean).join('\n');
      }),
      '',
      '# vol_cfg.c 与手写原件的逐行差异（已剔除旧的 2 通道限制块）',
      ...diffHunks(analyze(bare.c).raw, analyze(refC).raw).map((h) => {
        const minus = h.removed.map((l) => `- [原 ${l.no}] ${l.text}`).join('\n');
        const plus = h.added.map((l) => `+ [新 ${l.no}] ${l.text}`).join('\n');
        return [minus, plus].filter(Boolean).join('\n');
      }),
    ].join('\n');
    writeFileSync(path.join(OUT, 'diff-report.txt'), report, 'utf8');

    // 多通道混合配置（8 状态 / RBIN / 1 状态 / 2 状态 / 3 状态），供人工检查断言分档
    const five = emitFiles(modelFiveChannels());
    writeFileSync(path.join(OUT, 'five_channels.h'), five.h, 'utf8');
    writeFileSync(path.join(OUT, 'five_channels.c'), five.c, 'utf8');
    writeFileSync(path.join(OUT, 'five_channels.yaml'), emitConfigYaml(modelFiveChannels()), 'utf8');

    // 配置文件样例：入库到 samples/，作为 YAML 格式的评审对象与手工对照物；
    // C 文件样例同源生成（与 yaml 是同一份配置，供"导入样例 → 应得到这两份文件"对照）
    const samples = path.join(TOOL_ROOT, 'samples');
    mkdirSync(samples, { recursive: true });
    const def = emitFiles(presetDefault());
    writeFileSync(path.join(samples, 'vol_cfg.yaml'), emitConfigYaml(presetDefault()), 'utf8');
    writeFileSync(path.join(samples, 'vol_cfg.h'), def.h, 'utf8');
    writeFileSync(path.join(samples, 'vol_cfg.c'), def.c, 'utf8');
    writeFileSync(path.join(OUT, 'vol_cfg.yaml'), emitConfigYaml(presetDefault()), 'utf8');
  });
});
