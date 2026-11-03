/**
 * @file    index.ts
 * @brief   生成器对外入口：一份模型 → 两份完整可替换的 C 文件。
 */
import type { ConfigModel } from '../../model/types';
import { emitC } from './c';
import { emitH } from './h';
import { genInfo, withGenNote, type GenInfo } from './geninfo';

export interface GeneratedFiles {
  /** inc/vol_cfg.h 全文（LF 换行，UTF-8 无 BOM） */
  h: string;
  /** src/vol_cfg.c 全文 */
  c: string;
}

export interface EmitOptions {
  /** 生成日期来源，默认当前时间；测试固定它以保证逐字节可比 */
  now?: Date;
  /** 工具版本，默认 TOOL_VERSION；仅测试用 */
  version?: string;
}

export type { GenInfo };

/** 本次生成写入文件头的信息（UI 用来提示"这一次导出"的版本与日期） */
export function currentGenInfo(opts: EmitOptions = {}): GenInfo {
  return genInfo(opts.now, opts.version);
}

export function emitFiles(model: ConfigModel, opts: EmitOptions = {}): GeneratedFiles {
  const info = currentGenInfo(opts);
  // 生成信息只加在文件头注释里：两份文件共用同一个 info，日期不会各说各话
  return { h: withGenNote(emitH(model), info), c: withGenNote(emitC(model), info) };
}
