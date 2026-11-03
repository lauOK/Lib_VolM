/**
 * @file    geninfo.ts
 * @brief   把"谁在什么时候生成的"写进生成文件的文件头。
 *
 * 生成物一旦离开工具就没有上下文：现场反馈"这版 vol_cfg.c 是哪来的"，只能靠文件自己说。
 * 因此 vol_cfg.h / vol_cfg.c 的 `@file` 头里固定带一行 `@note`：
 *
 *     * @note    由 vol-cfg-tool v0.2.0 生成于 2026-11-03（目标库 Lib_VolM V1.4 · 配置格式 volm-cfg/1）
 *
 * 三个版本号各管一件事：工具版本回答"谁生成的"，目标库版本回答"适配哪版库"，
 * 配置格式号回答"字段能不能读"。只写工具版本的话，库升到 1.5 后这份文件
 * 到底还能不能用就看不出来了。
 *
 * 两个约束：
 *   · 只写日期不写时刻——同一天重新生成不产生 diff（理由见 version.ts 的 formatStamp）；
 *   · 只写注释——黄金基准要求"代码行序列与手写原件完全一致"，生成信息不能落成代码。
 */
import { LIB_VERSION, TOOL_NAME, TOOL_VERSION, SCHEMA_VERSION, formatStamp } from '../../version';

export interface GenInfo {
  tool: string;
  version: string;
  /** 生成日期 YYYY-MM-DD */
  date: string;
  /** 目标库版本（inc/vol.h 的 VOL_VERSION_STRING） */
  lib: string;
  /** 写文件时的配置格式版本 */
  schema: string;
}

/** 用当前时间与当前工具版本构造生成信息；测试可显式传入固定值 */
export function genInfo(now: Date = new Date(), version: string = TOOL_VERSION): GenInfo {
  return { tool: TOOL_NAME, version, date: formatStamp(now), lib: LIB_VERSION, schema: SCHEMA_VERSION };
}

/** @note 行的正文 */
export function noteText(info: GenInfo): string {
  return (
    `由 ${info.tool} v${info.version} 生成于 ${info.date}` +
    `（目标库 Lib_VolM V${info.lib} · 配置格式 ${info.schema}）`
  );
}

/** ` * @brief` 行——文件头里唯一稳定的插入锚点（.h 与 .c 都有，且各只出现一次） */
const BRIEF_LINE = /^ \* @brief\b/;

/**
 * 在文件头的 `@brief` 行之后插入 `@note` 生成信息。
 *
 * 锚点缺失是骨架被改坏的信号（skeleton.ts 由脚本从库文件切片生成），
 * 这种时候静默跳过会让生成信息无声消失，所以直接抛错——测试会先撞上它。
 */
export function withGenNote(text: string, info: GenInfo): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => BRIEF_LINE.test(l));
  if (i < 0) {
    throw new Error('生成文件的骨架里找不到 `@brief` 行，无法写入生成信息（skeleton.ts 被改动过？）');
  }
  lines.splice(i + 1, 0, ` * @note    ${noteText(info)}`);
  return lines.join('\n');
}
