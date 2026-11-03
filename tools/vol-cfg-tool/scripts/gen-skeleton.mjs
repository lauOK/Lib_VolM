/**
 * 从库当前的两份参考文件切出"固定骨架"文本，生成 src/core/emit/skeleton.ts。
 *
 * 为什么要生成而不是手抄：宏值列位、注释列位、行尾反斜杠前的空格都必须逐字符一致，
 * 手抄迟早错一位。切片后由 golden 测试兜底；参考文件若变更，重跑本脚本即可。
 *
 * 用法：node scripts/gen-skeleton.mjs [参考库根目录]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REF_DIR = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT;

const hPath = path.join(REF_DIR, 'inc', 'vol_cfg.h');
const cPath = path.join(REF_DIR, 'src', 'vol_cfg.c');
const hLines = readFileSync(hPath, 'utf8').split('\n');
const cLines = readFileSync(cPath, 'utf8').split('\n');

/** 取 1-based 闭区间切片 */
function slice(lines, from, to) {
  return lines.slice(from - 1, to).join('\n') + '\n';
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

/** 头部注释改写：原文假设"手改 vol_cfg.h"，现在由工具生成，措辞需要同步 */
function patchHeaderSeg(lines) {
  const out = [...lines];
  out[2] = ' * @brief   Lib_VolM 编译期静态配置（由 vol-cfg-tool 生成，请勿手工修改）';
  out[9] = ' * 本文件由 vol-cfg-tool 依据 vol_cfg.yaml 生成：改配置请回工具里改后重新生成，';
  out[10] = ' * 手工修改会在下次生成时被覆盖。';
  return out;
}

const segA = patchHeaderSeg(hLines.slice(0, 34)).join('\n') + '\n';

const chunks = {
  H_SEG_A: segA, // 1..34 文件头 + 守卫 + §0 断言宏 + §1 标题 + 通道实例数注释
  H_SEG_B: slice(hLines, 36, 37),
  H_SEG_C: slice(hLines, 39, 40),
  H_SEG_D: slice(hLines, 42, 43),
  H_SEG_E: slice(hLines, 45, 46),
  H_SEG_F: slice(hLines, 48, 53),
  H_SEG_G: slice(hLines, 55, 74),
  H_SEG_H: slice(hLines, 76, 77),
  H_TAIL_A: slice(hLines, 134, 143), // §3 标题 + 窗口换算宏
  H_TAIL_B: slice(hLines, 146, 196), // 其余派生量 + §4 类型 + extern + #endif
  C_PRE: slice(cLines, 1, 47), // 文件头 + 模块断言 + VOL_ASSERT_CH_COMMON
  C_TABLE_PRE: slice(cLines, 132, 138), // 配置表标题 + 声明 + {
};

const body = Object.entries(chunks)
  .map(([name, text]) => `export const ${name} = \`${esc(text)}\`;\n`)
  .join('\n');

const header = `/**
 * @file    skeleton.ts
 * @brief   vol_cfg.h / vol_cfg.c 的固定骨架文本（自动生成，勿手改）
 *
 * 由 scripts/gen-skeleton.mjs 从库当前参考文件切片而来：
 *   参考：${path.relative(process.cwd(), hPath)} / ${path.relative(process.cwd(), cPath).split(path.sep).pop()}
 * 重新生成：node scripts/gen-skeleton.mjs
 */

`;

const outPath = path.join(__dirname, '..', 'src', 'core', 'emit', 'skeleton.ts');
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, header + body, 'utf8');
console.log('written', outPath, Object.keys(chunks).length, 'chunks');
