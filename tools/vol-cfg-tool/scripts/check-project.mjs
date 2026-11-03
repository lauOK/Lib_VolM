/**
 * 检查 IAR 工程里的 VolM 副本与主库的一致性（只读，不改工程任何文件）。
 *
 * 背景：工程 CODE/BSW/Lib/VolM 是主库的拷贝，其中 vol_cfg.h / vol_cfg.c
 * 本来就该是"每个工程自己的一份配置生成物"，内容不同是正常的；真正要盯的是
 * 其余库文件（vol.c / vol_calc / vol_filt / vol_sm / 公共头）有没有漂移——
 * 一旦主库修了 bug 而工程副本没跟，两边行为就不一致了。
 *
 * 用法：  node scripts/check-project.mjs [工程根目录]
 * 默认：  ../..（即 Lib_VolM/SA427L3_APP）
 *
 * 退出码：0 = 无漂移（允许的 vol_cfg 差异之外全部一致）；1 = 有漂移或结构问题。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB_ROOT = path.resolve(TOOL_DIR, '../../..');
const PROJ_ROOT = path.resolve(process.argv[2] ?? path.join(LIB_ROOT, '..', 'SA427L3_APP'));

const VOLM = path.join(PROJ_ROOT, 'CODE', 'BSW', 'Lib', 'VolM');
const EWP = path.join(PROJ_ROOT, 'PROJ', 'CY2B75.ewp');

/** 库代码文件（必须逐字节一致）；vol_cfg.h/c 除外——它们是配置生成物 */
const LIB_FILES = [
  'inc/vol.h',
  'inc/vol_types.h',
  'src/vol.c',
  'src/vol_calc.c',
  'src/vol_calc.h',
  'src/vol_filt.c',
  'src/vol_filt.h',
  'src/vol_sm.c',
  'src/vol_sm.h',
  'src/vol_priv.h',
];

console.log(`主库   : ${LIB_ROOT}`);
console.log(`工程   : ${PROJ_ROOT}`);
console.log(`副本   : ${VOLM}\n`);

let problems = 0;

/* ---------- 1. 库代码一致性 ---------- */
for (const f of LIB_FILES) {
  const a = path.join(LIB_ROOT, f);
  const b = path.join(VOLM, f);
  if (!existsSync(b)) {
    console.log(`缺失  ${f}（工程副本里没有）`);
    problems++;
    continue;
  }
  const same = readFileSync(a, 'utf8') === readFileSync(b, 'utf8');
  console.log(`${same ? '一致' : '漂移'}  ${f}`);
  if (!same) problems++;
}

/* ---------- 2. 配置生成物：只提示，不计问题 ---------- */
for (const f of ['inc/vol_cfg.h', 'src/vol_cfg.c']) {
  const a = path.join(LIB_ROOT, f);
  const b = path.join(VOLM, f);
  if (!existsSync(b)) {
    console.log(`缺失  ${f}（工程副本里没有）`);
    problems++;
    continue;
  }
  // 配置文件允许不同，但检查两件事：库断言模板是否同版、工程配置是否自洽
  const libText = readFileSync(a, 'utf8');
  const projText = readFileSync(b, 'utf8');

  // .c 里看 m_state_num_max 断言的上界；.h 里看 VOL_STATE_NUM_MAX 的默认值
  const capOf = (t) =>
    f.endsWith('.c')
      ? (t.split('\n').find((l) => l.includes('m_state_num_max'))?.match(/<=\s*(\d+)/)?.[1] ?? '?')
      : (t.match(/#define\s+VOL_STATE_NUM_MAX\s+(\d+)/)?.[1] ?? '?');
  console.log(`配置  ${f}（内容可不同；状态上限 主库=${capOf(libText)} 工程=${capOf(projText)}）`);
  if (capOf(libText) !== capOf(projText)) {
    console.log(
      `      ⚠ 工程副本的状态上限是 ${capOf(projText)}（主库 ${capOf(libText)}）：在工程里配置 ` +
        `9~12 状态前，先同步 m_state_num_max 断言与 VOL_STATE_NUM_MAX 默认值`,
    );
  }
}

/* ---------- 3. ewp 引用核对 ---------- */
if (!existsSync(EWP)) {
  console.log(`\n缺失  ${EWP}（找不到 IAR 工程文件）`);
  problems++;
} else {
  const ewp = readFileSync(EWP, 'utf8');
  console.log(`\n工程文件 CY2B75.ewp 引用的 VolM 内容：`);
  for (const f of ['vol.c', 'vol_calc.c', 'vol_filt.c', 'vol_sm.c', 'vol_cfg.c']) {
    const ok = ewp.includes(`VolM${path.sep}src${path.sep}${f}`) || ewp.includes(`VolM/src/${f}`) || ewp.includes(f);
    console.log(`${ok ? '引用' : '未引用'}  src/${f}`);
    if (!ok) problems++;
  }
  const incOk = ewp.includes('VolM/inc') || ewp.includes(`VolM${path.sep}inc`);
  console.log(`${incOk ? '引用' : '未引用'}  inc/ 头文件路径`);
  if (!incOk) problems++;
}

console.log(`\n结论：${problems === 0 ? '无漂移，工程副本与主库同步' : `发现 ${problems} 处需要处理（见上）`}`);
process.exit(problems === 0 ? 0 : 1);
