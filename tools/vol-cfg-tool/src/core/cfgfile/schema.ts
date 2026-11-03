/**
 * @file    schema.ts
 * @brief   vol_cfg.yaml 的结构校验与模型构建。
 *
 * 只负责"文件层面的错"：键名、类型、整数性、数组长度、枚举取值、版本号。
 * 业务规则（C1~C11 容量/边界/迟滞等）在 P3 的 rules.ts，这里一条都不判——
 * 否则同一个错会出两条不同编号的提示。
 *
 * 三条硬原则：
 *   1. **未知字段即错**：拼错 `voltage_maxv_mv` 若被静默忽略，用户会以为配置生效了；
 *   2. **缺失字段即错**：不提供默认值，默认值会让"忘了填"看起来像"填成了默认"；
 *   3. 错误一律带字段路径，UI 才能点到对应输入框。
 */
import type {
  Boundary,
  CalibPoint,
  ChannelCfg,
  ConfigModel,
  Diagnostic,
  FilterMode,
  ModuleCfg,
} from '../../model/types';
import {
  SCHEMA_FAMILY,
  SCHEMA_VERSION,
  SCHEMA_VERSION_NUM,
  checkSchemaCompat,
} from '../../version';
import { runMigrations } from './migrate';

export interface ValidateResult {
  /** 有任何 error 时为 null，调用方不得使用半成品模型 */
  model: ConfigModel | null;
  diags: Diagnostic[];
  /** 文件里的 generator 段（旧文件没有）；只用于"这份文件是谁写的"提示，不参与判断 */
  meta?: GeneratorMeta;
}

/** 写出该文件的工具（vol_cfg.yaml 的 generator 段） */
export interface GeneratorMeta {
  tool?: string;
  version?: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 值的人类可读描述，用于错误文案 */
function describe(v: unknown): string {
  if (v === undefined) return '未提供';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `数组(${v.length} 项)`;
  if (typeof v === 'string') return `字符串 "${v.length > 24 ? `${v.slice(0, 24)}…` : v}"`;
  if (typeof v === 'object') return '映射';
  return `${typeof v} ${String(v)}`;
}

const join = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

class Ctx {
  readonly diags: Diagnostic[] = [];
  err(code: string, path: string, message: string): void {
    this.diags.push({ severity: 'error', code, path, message });
  }
  get failed(): boolean {
    return this.diags.length > 0;
  }
}

/**
 * 校验一个映射的键集合：多余键报 F3、缺失必填键报 F4。
 * 返回 false 表示结构已经不可用，调用方应放弃该节点（避免级联报错）。
 */
function checkKeys(
  c: Ctx,
  path: string,
  node: Obj,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = [...required, ...optional];
  const allowSet = new Set(allowed);
  let ok = true;
  for (const k of Object.keys(node)) {
    if (!allowSet.has(k)) {
      c.err(
        'F3',
        join(path, k),
        `未知字段 "${k}"；${path || '顶层'}只接受：${allowed.join('、')}`,
      );
      ok = false;
    }
  }
  for (const k of required) {
    if (!(k in node) || node[k] === undefined || node[k] === null) {
      c.err('F4', join(path, k), `缺少必填字段 "${k}"`);
      ok = false;
    }
  }
  return ok;
}

function intField(c: Ctx, path: string, node: Obj, key: string): number | undefined {
  const v = node[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    c.err('F5', join(path, key), `"${key}" 必须是数字，实际是 ${describe(v)}`);
    return undefined;
  }
  if (!Number.isInteger(v)) {
    c.err('F5', join(path, key), `"${key}" 必须是整数，实际是 ${v}（不要写小数）`);
    return undefined;
  }
  return v;
}

function strField(c: Ctx, path: string, node: Obj, key: string, allowNewline = false): string | undefined {
  const v = node[key];
  if (typeof v !== 'string') {
    c.err('F5', join(path, key), `"${key}" 必须是字符串，实际是 ${describe(v)}`);
    return undefined;
  }
  if (v === '') {
    c.err('F5', join(path, key), `"${key}" 不能为空字符串`);
    return undefined;
  }
  if (!allowNewline && /[\r\n]/.test(v)) {
    c.err('F5', join(path, key), `"${key}" 不能包含换行`);
    return undefined;
  }
  return v;
}

/* ==========================================================================
 * 各层构建
 * ========================================================================== */

function buildModule(c: Ctx, raw: unknown): ModuleCfg | null {
  if (!isObj(raw)) {
    c.err('F5', 'module', `module 必须是映射，实际是 ${describe(raw)}`);
    return null;
  }
  if (!checkKeys(c, 'module', raw, ['sample_period_ms', 'filter_window_max', 'state_num_max', 'channel_num_max', 'r_max_ohm'], ['comment'])) {
    return null;
  }
  const samplePeriodMs = intField(c, 'module', raw, 'sample_period_ms');
  const filterWindowMax = intField(c, 'module', raw, 'filter_window_max');
  const stateNumMax = intField(c, 'module', raw, 'state_num_max');
  const channelNumMax = intField(c, 'module', raw, 'channel_num_max');
  const rMaxOhm = intField(c, 'module', raw, 'r_max_ohm');

  let comment: string | undefined;
  if (raw['comment'] !== undefined && raw['comment'] !== null) {
    comment = strField(c, 'module', raw, 'comment', true);
  }

  if (
    samplePeriodMs === undefined ||
    filterWindowMax === undefined ||
    stateNumMax === undefined ||
    channelNumMax === undefined ||
    rMaxOhm === undefined
  ) {
    return null;
  }
  return { samplePeriodMs, filterWindowMax, stateNumMax, channelNumMax, rMaxOhm, comment };
}

function buildAdc(c: Ctx, path: string, raw: unknown): ChannelCfg['adc'] | null {
  if (!isObj(raw)) {
    c.err('F5', join(path, 'adc'), `adc 必须是映射，实际是 ${describe(raw)}`);
    return null;
  }
  if (!checkKeys(c, join(path, 'adc'), raw, ['fs', 'vref_mv'])) return null;
  const fs = intField(c, join(path, 'adc'), raw, 'fs');
  const vrefMv = intField(c, join(path, 'adc'), raw, 'vref_mv');
  if (fs === undefined || vrefMv === undefined) return null;
  return { fs, vrefMv };
}

function buildDivider(c: Ctx, path: string, raw: unknown): ChannelCfg['divider'] | null {
  if (!isObj(raw)) {
    c.err('F5', join(path, 'divider'), `divider 必须是映射，实际是 ${describe(raw)}`);
    return null;
  }
  if (!checkKeys(c, join(path, 'divider'), raw, ['r_high_ohm', 'r_low_ohm'])) return null;
  const rHighOhm = intField(c, join(path, 'divider'), raw, 'r_high_ohm');
  const rLowOhm = intField(c, join(path, 'divider'), raw, 'r_low_ohm');
  if (rHighOhm === undefined || rLowOhm === undefined) return null;
  return { rHighOhm, rLowOhm };
}

function buildCalib(c: Ctx, path: string, raw: unknown): ChannelCfg['calib'] | null {
  if (!isObj(raw)) {
    c.err('F5', join(path, 'calib'), `calib 必须是映射，实际是 ${describe(raw)}`);
    return null;
  }
  if (!checkKeys(c, join(path, 'calib'), raw, ['gain_ppm', 'offset_mv'])) return null;
  const gainPpm = intField(c, join(path, 'calib'), raw, 'gain_ppm');
  const offsetMv = intField(c, join(path, 'calib'), raw, 'offset_mv');
  if (gainPpm === undefined || offsetMv === undefined) return null;
  return { gainPpm, offsetMv };
}

/**
 * 标定实测点（可选段）。
 *
 * 缺失返回 undefined（**不是空数组**）：只有"没有这个键"才能让 emit 一个字符都不写，
 * 从而保证不带点的配置导出逐字节不变。空数组是用户手写文件时的笔误，直接报 F6。
 */
function buildCalibPoints(c: Ctx, path: string, raw: Obj): CalibPoint[] | undefined {
  const v = raw['calib_points'];
  if (v === undefined || v === null) return undefined;

  const here = join(path, 'calib_points');
  if (!Array.isArray(v)) {
    c.err('F5', here, `calib_points 必须是数组（每项 { code, in_mv }），实际是 ${describe(v)}`);
    return undefined;
  }
  if (v.length === 0) {
    c.err('F6', here, 'calib_points 是空数组：没有实测点请整段省略，不要写成 []');
    return undefined;
  }

  const pts: CalibPoint[] = [];
  for (let k = 0; k < v.length; k++) {
    const pPath = join(here, String(k));
    const p = v[k];
    if (!isObj(p)) {
      c.err('F5', pPath, `实测点必须是映射 { code, in_mv }，实际是 ${describe(p)}`);
      return undefined;
    }
    if (!checkKeys(c, pPath, p, ['code', 'in_mv'])) return undefined;
    const code = intField(c, pPath, p, 'code');
    const inMv = intField(c, pPath, p, 'in_mv');
    if (code === undefined || inMv === undefined) return undefined;
    pts.push({ code, inMv });
  }
  return pts;
}

const FILTER_MODES: readonly FilterMode[] = ['by_time', 'by_sample'];
function buildFilter(c: Ctx, path: string, raw: unknown): ChannelCfg['filter'] | null {
  const here = join(path, 'filter');
  if (!isObj(raw)) {
    c.err('F5', here, `filter 必须是映射，实际是 ${describe(raw)}`);
    return null;
  }
  if (!checkKeys(c, here, raw, ['mode', 'arg'])) return null;
  const modeRaw = raw['mode'];
  if (typeof modeRaw !== 'string' || !FILTER_MODES.includes(modeRaw as FilterMode)) {
    c.err('F5', join(here, 'mode'), `"mode" 只能是 ${FILTER_MODES.join(' 或 ')}，实际是 ${describe(modeRaw)}`);
    return null;
  }
  const arg = intField(c, here, raw, 'arg');
  if (arg === undefined) return null;
  return { mode: modeRaw as FilterMode, arg };
}

function buildStates(c: Ctx, path: string, raw: unknown): ChannelCfg['states'] | null {
  const here = join(path, 'states');
  if (!isObj(raw)) {
    c.err('F5', here, `states 必须是映射，实际是 ${describe(raw)}`);
    return null;
  }
  const mode = raw['mode'];
  if (mode === 'measure_only') {
    // 仅测量通道不允许出现 names / boundaries：出现了就是用户以为它们在生效
    if (!checkKeys(c, here, raw, ['mode'])) return null;
    return { mode: 'measure_only' };
  }
  if (mode !== 'stateful') {
    c.err('F5', join(here, 'mode'), `"mode" 只能是 stateful 或 measure_only，实际是 ${describe(mode)}`);
    return null;
  }
  if (!checkKeys(c, here, raw, ['mode', 'names', 'boundaries'])) return null;

  const namesRaw = raw['names'];
  if (!Array.isArray(namesRaw)) {
    c.err('F5', join(here, 'names'), `"names" 必须是数组，实际是 ${describe(namesRaw)}`);
    return null;
  }
  const names: string[] = [];
  for (let i = 0; i < namesRaw.length; i++) {
    const v = namesRaw[i];
    if (typeof v !== 'string' || v === '') {
      c.err('F5', join(join(here, 'names'), i), `状态名必须是非空字符串，实际是 ${describe(v)}`);
      return null;
    }
    if (/[\r\n]/.test(v)) {
      c.err('F5', join(join(here, 'names'), i), '状态名不能包含换行');
      return null;
    }
    names.push(v);
  }

  const boundariesRaw = raw['boundaries'];
  if (!Array.isArray(boundariesRaw)) {
    c.err('F5', join(here, 'boundaries'), `"boundaries" 必须是数组，实际是 ${describe(boundariesRaw)}`);
    return null;
  }
  if (names.length === 0) {
    c.err('F6', join(here, 'names'), '有状态通道至少要写 1 个状态名');
    return null;
  }
  if (boundariesRaw.length !== names.length) {
    c.err(
      'F6',
      join(here, 'boundaries'),
      `边界必须是 n 条（b1..bn）：names 有 ${names.length} 个状态，boundaries 应有 ${names.length} 条，` +
        `实际 ${boundariesRaw.length} 条（b0 恒为 0，不要写；bn 是量程上限，必须写）`,
    );
    return null;
  }

  const boundaries: Boundary[] = [];
  for (let i = 0; i < boundariesRaw.length; i++) {
    const bPath = join(join(here, 'boundaries'), i);
    const b = boundariesRaw[i];
    const isLast = i === boundariesRaw.length - 1;
    if (!isObj(b)) {
      c.err('F5', bPath, `边界必须是映射 { upper_mv, hyst_up_mv, hyst_down_mv }，实际是 ${describe(b)}`);
      return null;
    }
    // 最后一条是量程端点：只有 upper_mv；两个迟滞可省略（写了必须为 0）
    if (!checkKeys(c, bPath, b, isLast ? ['upper_mv'] : ['upper_mv', 'hyst_up_mv', 'hyst_down_mv'], isLast ? ['hyst_up_mv', 'hyst_down_mv'] : [])) {
      return null;
    }
    const upperMv = intField(c, bPath, b, 'upper_mv');
    if (upperMv === undefined) return null;

    if (isLast) {
      for (const k of ['hyst_up_mv', 'hyst_down_mv']) {
        if (b[k] === undefined) continue;
        const v = intField(c, bPath, b, k);
        if (v === undefined) return null;
        if (v !== 0) {
          c.err(
            'F5',
            join(bPath, k),
            `b${i + 1} 是量程端点，没有迟滞可言（末状态没有上侧邻居，C10 要求 0）；请省略该字段`,
          );
          return null;
        }
      }
      boundaries.push({ upperMv, hystUpMv: 0, hystDownMv: 0 });
      continue;
    }

    const hystUpMv = intField(c, bPath, b, 'hyst_up_mv');
    const hystDownMv = intField(c, bPath, b, 'hyst_down_mv');
    if (hystUpMv === undefined || hystDownMv === undefined) return null;
    boundaries.push({ upperMv, hystUpMv, hystDownMv });
  }

  return { mode: 'stateful', names, boundaries };
}

function buildChannel(c: Ctx, raw: unknown, i: number): ChannelCfg | null {
  const path = `channels[${i}]`;
  if (!isObj(raw)) {
    c.err('F5', path, `通道必须是映射，实际是 ${describe(raw)}`);
    return null;
  }

  // 通道级 voltage_max_mv 只属于"没有状态表"的 measure_only 通道；
  // stateful 通道的量程是 b_n，再写一份就会两处不一致。
  const rawStates = raw['states'];
  const measureOnly = isObj(rawStates) && rawStates['mode'] === 'measure_only';

  if (!measureOnly && 'voltage_max_mv' in raw) {
    c.err(
      'F3',
      join(path, 'voltage_max_mv'),
      '有状态通道的量程由 states.boundaries 最后一条（bn）给出，不要再写 voltage_max_mv',
    );
    return null;
  }

  if (
    !checkKeys(
      c,
      path,
      raw,
      ['name', 'adc', 'divider', 'calib', 'filter', 'states', ...(measureOnly ? ['voltage_max_mv'] : [])],
      ['comment', 'calib_points'],
    )
  ) {
    return null;
  }

  const name = strField(c, path, raw, 'name');
  const adc = buildAdc(c, path, raw['adc']);
  const divider = buildDivider(c, path, raw['divider']);
  const calib = buildCalib(c, path, raw['calib']);
  const calibPoints = buildCalibPoints(c, path, raw);
  const filter = buildFilter(c, path, raw['filter']);
  const states = buildStates(c, path, raw['states']);
  const voltageMaxMv = measureOnly ? intField(c, path, raw, 'voltage_max_mv') : undefined;

  let comment: string | undefined;
  if (raw['comment'] !== undefined && raw['comment'] !== null) {
    comment = strField(c, path, raw, 'comment', true);
  }

  if (!name || !adc || !divider || !calib || !filter || !states) return null;
  if (measureOnly && voltageMaxMv === undefined) return null;
  // calibPoints 缺席时**不写这个键**（而不是写 undefined）：emit 与深比较都依赖"没有就是没有"
  const points = calibPoints ? { calibPoints } : {};
  return measureOnly
    ? { name, comment, adc, divider, calib, ...points, filter, voltageMaxMv, states }
    : { name, comment, adc, divider, calib, ...points, filter, states };
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * 版本闸门：先判格式版本、必要时升级，之后才允许做键名/类型校验。
 *
 * 顺序是有讲究的。一份 volm-cfg/2 的文件在旧工具眼里既有"未知字段"，字段语义也可能变了；
 * 先报 F3"未知字段"会把用户引向"删掉这一行就好了"，那是静默丢配置的开端。
 * 所以版本不符必须先以 F2 拦下，并明说"请用新版工具"。
 *
 * 兼容性规则（与 version.ts 一致）：向下兼容，向上报错。
 */
function resolveSchema(c: Ctx, raw: Obj): Obj | null {
  if (raw['schema'] === undefined || raw['schema'] === null) {
    c.err('F4', 'schema', `缺少必填字段 "schema"（文件格式版本，当前为 "${SCHEMA_VERSION}"）`);
    return null;
  }
  const declared = raw['schema'];
  if (typeof declared !== 'string') {
    c.err('F2', 'schema', `"schema" 必须是版本字符串，如 "${SCHEMA_VERSION}"，实际是 ${describe(declared)}`);
    return null;
  }

  const compat = checkSchemaCompat(declared);
  switch (compat.kind) {
    case 'current':
      return raw;

    case 'older': {
      // 旧格式：逐级升级。缺任何一级都整体失败——半个升级的配置比读不进来更危险。
      const m = runMigrations(raw, compat.version, SCHEMA_VERSION_NUM);
      if (!m.ok) {
        const from = `${SCHEMA_FAMILY}/${m.missing}`;
        const to = `${SCHEMA_FAMILY}/${(m.missing ?? 0) + 1}`;
        c.err(
          'F2',
          'schema',
          `文件格式 "${declared}" 比本工具（"${SCHEMA_VERSION}"）旧，但本工具没有 ${from} → ${to} 的升级步骤，` +
            '无法安全读取：请用当初生成它的那版工具把配置导出成新格式，或用本工具重新填一遍',
        );
        return null;
      }
      return m.raw;
    }

    case 'newer':
      c.err(
        'F2',
        'schema',
        `文件格式 "${declared}" 比本工具支持的最高格式 "${SCHEMA_VERSION}" 新：本工具只向下兼容旧文件，` +
          '不向上兼容新文件，因此拒绝读取（否则可能静默丢掉新字段）。请升级 vol-cfg-tool 后再导入',
      );
      return null;

    case 'foreign':
      c.err(
        'F2',
        'schema',
        `"schema" 的族名是 "${compat.family}"，本工具只认 "${SCHEMA_FAMILY}"：这看起来不是 vol_cfg.yaml`,
      );
      return null;

    case 'malformed':
      c.err(
        'F2',
        'schema',
        `"schema" 应写成 "族名/版本号"（如 "${SCHEMA_VERSION}"），实际是 ${describe(declared)}`,
      );
      return null;
  }
}

/**
 * generator 段：写出这份文件的工具与版本。
 *
 * 纯信息字段，不进模型，也不参与兼容性判断（兼容性只看 schema）——
 * 工具升级不该让用户已有的配置文件失效。
 * 允许整段缺失：那是"旧版工具写的文件"，必须照读，这是向下兼容的基本要求。
 */
function checkGenerator(c: Ctx, raw: Obj): GeneratorMeta | undefined {
  const g = raw['generator'];
  if (g === undefined || g === null) return undefined;
  if (!isObj(g)) {
    c.err('F5', 'generator', `generator 必须是映射 { tool, version }，实际是 ${describe(g)}`);
    return undefined;
  }
  if (!checkKeys(c, 'generator', g, ['tool', 'version'])) return undefined;
  const tool = strField(c, 'generator', g, 'tool');
  const v = strField(c, 'generator', g, 'version');
  if (v !== undefined && !VERSION_RE.test(v)) {
    c.err(
      'F5',
      'generator.version',
      `"version" 应是 "主.次.修订" 形式（如 "0.2.0"），实际是 ${describe(v)}；该字段只是记录，写错不影响配置，` +
        '但会让"这份文件是谁生成的"失真',
    );
    return undefined;
  }
  return { tool, version: v };
}

export function validateConfig(raw: unknown): ValidateResult {
  const c = new Ctx();

  if (!isObj(raw)) {
    c.err('F1', '', `配置文件的顶层必须是键值映射，实际是 ${describe(raw)}`);
    return { model: null, diags: c.diags };
  }

  const doc = resolveSchema(c, raw);
  if (!doc) {
    return { model: null, diags: c.diags };
  }

  if (!checkKeys(c, '', doc, ['schema', 'module', 'channels'], ['generator'])) {
    return { model: null, diags: c.diags };
  }
  const meta = checkGenerator(c, doc);

  const module = buildModule(c, doc['module']);

  const channelsRaw = doc['channels'];
  let channels: ChannelCfg[] | null = null;
  if (!Array.isArray(channelsRaw)) {
    c.err('F5', 'channels', `"channels" 必须是数组，实际是 ${describe(channelsRaw)}`);
  } else if (channelsRaw.length === 0) {
    c.err('F6', 'channels', '至少需要 1 个通道');
  } else {
    const built: ChannelCfg[] = [];
    let ok = true;
    for (let i = 0; i < channelsRaw.length; i++) {
      const ch = buildChannel(c, channelsRaw[i], i);
      if (!ch) ok = false;
      else built.push(ch);
    }
    if (ok) channels = built;
  }

  if (!module || !channels || c.failed) {
    return { model: null, diags: c.diags };
  }
  // 模型里的 schema 一律是当前格式号：旧文件读进来后已升级，内存里没有"旧格式"这回事
  return { model: { schema: SCHEMA_VERSION, module, channels }, diags: c.diags, meta };
}
