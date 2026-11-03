/**
 * 打包分发版本（产出 zip）。
 *
 * 包结构（staging 后压缩）：
 *   Lib_VolM_v{LIB}_{DATE}/
 *     README.md                  ← 顶层导航（release/README.md 模板替换版本占位）
 *     lib/                       ← 库：inc src Template UnitTest doc ReadMe.md
 *     tools/vol-cfg-tool/        ← 工具：index.html start.cmd README samples src tests scripts package.json
 *     config/                    ← 预置配置三件套（= samples/）
 *
 * 用法：node scripts/package.mjs [输出目录]
 * 默认输出：../../..（Lib_VolM 根）/release/
 *
 * 产物：release/Lib_VolM_v{LIB}_{DATE}.zip 与同名 staging 目录（zip 校验失败时人工查看用）。
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url)); // scripts/
const TOOL_ROOT = path.resolve(TOOL_DIR, '..'); // tools/vol-cfg-tool
const LIB_ROOT = path.resolve(TOOL_ROOT, '../..'); // Lib_VolM/Lib_VolM
const OUT_BASE = path.resolve(process.argv[2] ?? path.join(LIB_ROOT, '..', 'release'));

const LIB_VERSION = readFileSync(path.join(TOOL_ROOT, 'src/version.ts'), 'utf8')
  .match(/export const LIB_VERSION = '([^']+)'/)?.[1];
const TOOL_VERSION = JSON.parse(readFileSync(path.join(TOOL_ROOT, 'package.json'), 'utf8')).version;
if (!LIB_VERSION || !TOOL_VERSION) {
  console.error('读不到 LIB_VERSION / TOOL_VERSION');
  process.exit(1);
}

const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const DATE = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
const PKG_NAME = `Lib_VolM_v${LIB_VERSION}_${DATE}`;
const STAGE = path.join(OUT_BASE, PKG_NAME);

console.log(`库 V${LIB_VERSION} · 工具 v${TOOL_VERSION} · 打包 ${DATE}`);
console.log(`输出 ${STAGE}\n`);

/* ---------- 清理旧的 staging ---------- */
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

/** 拷目录，跳过排除名 */
function copyTree(src, dest, exclude = []) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (exclude.includes(name)) continue;
    cpSync(path.join(src, name), path.join(dest, name), { recursive: true });
  }
}

/* ---------- 1. 库 ---------- */
copyTree(path.join(LIB_ROOT, 'inc'), path.join(STAGE, 'lib', 'inc'));
copyTree(path.join(LIB_ROOT, 'src'), path.join(STAGE, 'lib', 'src'));
copyTree(path.join(LIB_ROOT, 'Template'), path.join(STAGE, 'lib', 'Template'));
copyTree(path.join(LIB_ROOT, 'UnitTest'), path.join(STAGE, 'lib', 'UnitTest'), ['build']);
copyTree(path.join(LIB_ROOT, 'doc'), path.join(STAGE, 'lib', 'doc'));
cpSync(path.join(LIB_ROOT, 'ReadMe.md'), path.join(STAGE, 'lib', 'ReadMe.md'));

/* ---------- 2. 工具（成品 + 源码，不带 node_modules / dist） ---------- */
const TOOL_STAGE = path.join(STAGE, 'tools', 'vol-cfg-tool');
cpSync(path.join(TOOL_ROOT, 'dist', 'index.html'), path.join(TOOL_STAGE, 'index.html'));
for (const f of ['start.cmd', 'README.md', 'package.json', 'package-lock.json']) {
  cpSync(path.join(TOOL_ROOT, f), path.join(TOOL_STAGE, f));
}
copyTree(path.join(TOOL_ROOT, 'samples'), path.join(TOOL_STAGE, 'samples'));
copyTree(path.join(TOOL_ROOT, 'src'), path.join(TOOL_STAGE, 'src'));
copyTree(path.join(TOOL_ROOT, 'tests'), path.join(TOOL_STAGE, 'tests'));
copyTree(path.join(TOOL_ROOT, 'scripts'), path.join(TOOL_STAGE, 'scripts'));
// vite/tsconfig 等配置文件
for (const f of readdirSync(TOOL_ROOT).filter((n) => /\.(json|ts|js)$/.test(n) || n.startsWith('.'))) {
  if (['package.json', 'package-lock.json'].includes(f)) continue;
  cpSync(path.join(TOOL_ROOT, f), path.join(TOOL_STAGE, f));
}

/* ---------- 3. 预置配置三件套 ---------- */
copyTree(path.join(TOOL_ROOT, 'samples'), path.join(STAGE, 'config'));

/* ---------- 4. 顶层 README（替换版本占位） ---------- */
const tpl = readFileSync(path.join(TOOL_ROOT, 'release', 'README.md'), 'utf8');
writeFileSync(
  path.join(STAGE, 'README.md'),
  tpl.replaceAll('{{LIB}}', LIB_VERSION).replaceAll('{{TOOL}}', TOOL_VERSION).replaceAll('{{DATE}}', DATE),
  'utf8',
);

/* ---------- 5. 冒烟检查：包内的东西必须能直接用 ---------- */
const checks = [
  [path.join(STAGE, 'lib', 'inc', 'vol.h'), 'lib/inc/vol.h'],
  [path.join(STAGE, 'lib', 'src', 'vol.c'), 'lib/src/vol.c'],
  [path.join(STAGE, 'lib', 'UnitTest', 'build.sh'), 'lib/UnitTest/build.sh'],
  [path.join(STAGE, 'tools', 'vol-cfg-tool', 'index.html'), 'tools/vol-cfg-tool/index.html'],
  [path.join(STAGE, 'config', 'vol_cfg.yaml'), 'config/vol_cfg.yaml'],
  [path.join(STAGE, 'config', 'vol_cfg.h'), 'config/vol_cfg.h'],
  [path.join(STAGE, 'config', 'vol_cfg.c'), 'config/vol_cfg.c'],
  [path.join(STAGE, 'README.md'), 'README.md'],
];
let missing = 0;
for (const [f, label] of checks) {
  const ok = readFileSync(f, 'utf8').length > 0;
  console.log(`${ok ? 'OK ' : '缺失'} ${label}`);
  if (!ok) missing++;
}
// 包内配置三件套必须同源：yaml 头部注释的库版本、h 文件 @note 的库版本一致
const cfgH = readFileSync(path.join(STAGE, 'config', 'vol_cfg.h'), 'utf8');
if (!cfgH.includes(`目标库 Lib_VolM V${LIB_VERSION}`)) {
  console.error(`config/vol_cfg.h 的 @note 库版本不是 V${LIB_VERSION}，样例过期`);
  missing++;
}
if (missing > 0) {
  console.error(`\n${missing} 项缺失，中止打包`);
  process.exit(1);
}

/* ---------- 6. 压缩（PowerShell Compress-Archive，Windows 自带） ---------- */
const zip = `${STAGE}.zip`;
rmSync(zip, { force: true });
const ps = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${STAGE.replace(/'/g, "''")}\\*' -DestinationPath '${zip.replace(/'/g, "''")}' -Force`,
  ],
  { encoding: 'utf8' },
);
if (ps.status !== 0) {
  console.error(`压缩失败：\n${ps.stderr || ps.stdout}`);
  console.error(`staging 目录保留在 ${STAGE}，可手动压缩`);
  process.exit(1);
}

console.log(`\n打包完成：${zip}`);
console.log(`staging：${STAGE}（可删除）`);
