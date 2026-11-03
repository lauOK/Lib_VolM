/**
 * @file    version.ts
 * @brief   工具版本与配置文件格式版本——两者的区别就是本工具的兼容性契约。
 *
 * 两个版本号必须分开。混成一个号，会让"改了句注释"和"改了字段含义"享受同样的待遇：
 *
 *   TOOL_VERSION    工具自身的语义化版本，每次发布都变。它写进 vol_cfg.h / vol_cfg.c 的
 *                   生成信息（@note 行）和 vol_cfg.yaml 的 generator 段，只用于追溯
 *                   "这份文件是哪个版本的工具生成的"，**不参与**兼容性判断——
 *                   工具升级不该让用户已有的配置文件失效。
 *
 *   SCHEMA_VERSION  配置文件格式版本 `volm-cfg/N`。只有 yaml 的字段增删、单位、语义
 *                   发生变化时才升号。它决定兼容性，规则只有一条：
 *                     · 新工具读旧格式 → 允许，由 migrate.ts 的升级链自动补齐；
 *                     · 旧工具读新格式 → 拒绝（F2 报错），绝不猜测。
 *                   即：只向下兼容，不向上兼容。
 */

/** 工具名，进生成文件与 yaml 的 generator 段 */
export const TOOL_NAME = 'vol-cfg-tool';

/**
 * 工具版本（语义化）。**必须与 package.json 的 version 一致**——
 * tests/version.test.ts 会直接读 package.json 校验，忘了改哪边都会红。
 */
export const TOOL_VERSION = '0.2.0';

/** 格式族名：别的工具/别的产品的配置文件不应被当成 vol_cfg.yaml */
export const SCHEMA_FAMILY = 'volm-cfg';

/**
 * 目标库版本，对应 `inc/vol.h` 的 `VOL_VERSION_STRING`。
 *
 * 为什么要单独记：生成的 vol_cfg.h/c 是"某版库 + 某份配置"的乘积，只写工具版本
 * 说明不了它适配哪版库。tests/version.test.ts 会直接读 `inc/vol.h` 的宏校验，
 * 库升版而忘了改这里，测试立刻变红。
 *
 * 三个号互不干涉：库能力（1.4）/ 配置格式（volm-cfg/1）/ 工具发布（0.2.0）。
 */
export const LIB_VERSION = '1.4';

/** 当前工具能写出的最高格式号 */
export const SCHEMA_VERSION_NUM = 1;

/** 当前格式版本字符串（写进 yaml 的 schema 字段） */
export const SCHEMA_VERSION = `${SCHEMA_FAMILY}/${SCHEMA_VERSION_NUM}`;

/* ==========================================================================
 * 格式版本判定
 * ========================================================================== */

export type SchemaCompat =
  /** 与当前格式号相同 */
  | { kind: 'current' }
  /** 旧格式：需要按 migrate.ts 的链逐级升级 */
  | { kind: 'older'; version: number }
  /** 新格式：本工具读不懂，必须报错（不向上兼容） */
  | { kind: 'newer'; version: number }
  /** 族名不是 volm-cfg：根本不是本工具的配置文件 */
  | { kind: 'foreign'; family: string }
  /** 不是 `族名/数字` 的形状 */
  | { kind: 'malformed' };

const SCHEMA_RE = /^([A-Za-z][A-Za-z0-9_-]*)\/(\d+)$/;

export function checkSchemaCompat(declared: string): SchemaCompat {
  const m = SCHEMA_RE.exec(declared.trim());
  if (!m) return { kind: 'malformed' };
  const family = m[1]!;
  const version = Number(m[2]);
  if (family !== SCHEMA_FAMILY) return { kind: 'foreign', family };
  if (version === SCHEMA_VERSION_NUM) return { kind: 'current' };
  return version < SCHEMA_VERSION_NUM ? { kind: 'older', version } : { kind: 'newer', version };
}

/* ==========================================================================
 * 生成日期
 * ========================================================================== */

/**
 * 生成日期 `YYYY-MM-DD`（本机时区）。
 *
 * 刻意只到"天"：生成的 C 文件要入库，同一天重新生成不应该产生 diff。
 * 精确到秒会让每次点下载都改一遍文件，"这次改了哪几个值"就淹在时间戳里了；
 * 要追具体时刻，git 的提交时间比文件里的字符串可靠。
 */
export function formatStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
