/**
 * @file    parse.ts
 * @brief   把 vol_cfg.yaml（或同结构的 .json）文本解析成 ConfigModel。
 *
 * 用 js-yaml 的 JSON_SCHEMA：它只认 JSON 的标量类型，不做隐式类型推断，
 * 因此 `mode: no` 不会被悄悄变成 false（Norway problem），`1.0` 也不会变成 1。
 * JSON 是 YAML 的子集，所以 .json 文件走同一条路径，不需要单独分支。
 */
import { JSON_SCHEMA, load } from 'js-yaml';

import type { Diagnostic } from '../../model/types';
import { validateConfig, type GeneratorMeta, type ValidateResult } from './schema';

export interface ParseOk {
  ok: true;
  model: NonNullable<ValidateResult['model']>;
  /** 解析成功时仍可能带 warning（P3 起才有） */
  diags: Diagnostic[];
  /** 文件里的 generator 段；旧文件（没有该段）为 undefined */
  meta?: GeneratorMeta;
}

export interface ParseFail {
  ok: false;
  diags: Diagnostic[];
}

export type ParseResult = ParseOk | ParseFail;

/** 去掉 UTF-8 BOM：Windows 记事本另存的文件常带 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseConfigText(text: string): ParseResult {
  const body = stripBom(text);

  if (body.trim() === '') {
    return {
      ok: false,
      diags: [{ severity: 'error', code: 'F1', path: '', message: '配置文件是空的' }],
    };
  }

  let raw: unknown;
  try {
    raw = load(body, { schema: JSON_SCHEMA, filename: 'vol_cfg.yaml' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      diags: [
        {
          severity: 'error',
          code: 'F1',
          path: '',
          message: `配置文件语法错误（YAML/JSON 无法解析）：${msg.split('\n')[0]}`,
        },
      ],
    };
  }

  const { model, diags, meta } = validateConfig(raw);
  if (!model) {
    return { ok: false, diags };
  }
  return { ok: true, model, diags, meta };
}
