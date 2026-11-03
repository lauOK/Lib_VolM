/**
 * @file    index.ts
 * @brief   配置文件（vol_cfg.yaml）读写入口。
 *
 * 契约：解析与生成互为逆运算——model → YAML → model 深比较相等，
 * YAML → model → YAML 逐字节相同；否则"导入再导出"就会悄悄改掉用户的数据。
 *
 * 版本契约见 src/version.ts：向下兼容旧格式（走 migrate.ts 的升级链），
 * 不向上兼容新格式（F2 报错）。
 */
export { CONFIG_FILENAME, emitConfigYaml } from './emit';
export { MIGRATIONS, runMigrations, type Migration, type MigrateResult } from './migrate';
export { parseConfigText, type ParseFail, type ParseOk, type ParseResult } from './parse';
export { validateConfig, type GeneratorMeta, type ValidateResult } from './schema';
