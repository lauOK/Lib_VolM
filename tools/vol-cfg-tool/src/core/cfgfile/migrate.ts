/**
 * @file    migrate.ts
 * @brief   配置文件格式的向下兼容：旧格式逐级升级到当前格式。
 *
 * 策略只有一条：**新工具读旧文件必须成功，旧工具读新文件必须报错**。
 * 所以这里只提供 from → from+1 的单向升级链，永不提供降级路径。
 *
 * 升级表当前为空——volm-cfg/1 是第一个格式，没有更旧的文件存在。这不是"没做兼容"，
 * 而是"暂时没有旧格式可兼容"：机制已就位，下次升格式时按下面的步骤补一条即可。
 *
 * 升 SCHEMA_VERSION 的步骤（刻意写在这里，免得下次忘了）：
 *   1. version.ts：SCHEMA_VERSION_NUM + 1；
 *   2. 本文件 MIGRATIONS：补一条 `旧号: (raw) => 新形状`，只处理"新增必填 / 改名 / 改单位"
 *      的字段。纯新增的**可选**字段不必升号（本次加 generator 就是纯新增，故仍是 volm-cfg/1）——
 *      老文件没有它，新工具按"缺省"处理即可；
 *   3. tests/version.test.ts：加一份旧格式样例，验证"能读进来 + 导出即新格式"。
 */

/** 从版本 n 升到 n+1：入参是一份可自由修改的纯数据副本 */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/** 升级链：键 = 源版本号，值 = 升到 源版本+1 的函数 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export interface MigrateResult {
  ok: boolean;
  /** 升级后的文档；ok 为 false 时是原样副本，调用方不应使用 */
  raw: Record<string, unknown>;
  /** 实际走过的源版本号，如 [1, 2] 表示 1→2→3 */
  applied: number[];
  /** 缺失的那一级（ok 为 false 时有效） */
  missing?: number;
}

/**
 * 从 `from` 逐级升到 `to`（左闭右开：不执行 to → to+1）。
 * 任一级缺失就整体失败——半个升级的配置比读不进来更危险。
 */
export function runMigrations(
  raw: Record<string, unknown>,
  from: number,
  to: number,
  table: Readonly<Record<number, Migration>> = MIGRATIONS,
): MigrateResult {
  // 深拷贝：升级函数可能原地改字段，不能污染调用方的原始文档（报错时还要用它做诊断）
  let cur = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const applied: number[] = [];

  for (let v = from; v < to; v++) {
    const step = table[v];
    if (!step) return { ok: false, raw: cur, applied, missing: v };
    cur = step(cur);
    applied.push(v);
  }
  return { ok: true, raw: cur, applied };
}
