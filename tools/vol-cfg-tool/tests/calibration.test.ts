/**
 * @file    calibration.test.ts
 * @brief   标定打点：求解精度 / 退化与越界 / yaml 往返 / C 摘要 / store action。
 *
 * 验收口径：
 *   - predMv 必须与库的 Vol_Calc_Convert 整数流水线逐位一致（这是"图上残差 = 板上残差"的前提）；
 *   - 干净数据的 2 点解残差 ≤ 1 mV（只剩 mV 取整）；
 *   - 求解出的 gain 不必等于真值，但 scale_q16 必须落在真值同一台阶（输出行为等价）。
 */
import { describe, expect, it } from 'vitest';

import { emitConfigYaml, parseConfigText } from '../src/core/cfgfile';
import { evalResiduals, fitCalibration, fitLine, pinOf, predMv } from '../src/core/calibrate';
import { emitFiles } from '../src/core/emit';
import { scaleQ16 } from '../src/core/scale';
import { presetDefault } from '../src/model/presets';
import type { CalibPoint } from '../src/model/types';
import { reducer } from '../src/ui/store';
import { codeLines } from './helpers/compare';
import { modelWithCalibPoints } from './helpers/models';

/** 默认预设 CH0：ratio 6、量程 20000，数字好读，拟合测试都用它 */
const ch0 = presetDefault().channels[0]!;
const vmax0 = 20000;

/** 用"真值标定"造实测点：这些点的 predMv 就是板上会报出的数 */
function makePoints(
  codes: number[],
  truth: { gainPpm: number; offsetMv: number },
  adc = ch0.adc,
  divider = ch0.divider,
  vmax = vmax0,
): CalibPoint[] {
  return codes.map((code) => ({ code, inMv: predMv(code, adc, divider, truth, vmax) }));
}

describe('predMv 与 C 整数流水线逐位一致', () => {
  it('随机码值与手写 BigInt 版本完全一致（含限幅与取整）', () => {
    const calib = { gainPpm: 4200, offsetMv: -37 };
    const scale = scaleQ16(ch0.adc, ch0.divider, calib);
    for (let code = 0; code <= ch0.adc.fs; code += 97) {
      const uvRaw = (BigInt(code) * BigInt(scale)) >> 16n;
      const uv = uvRaw + BigInt(calib.offsetMv * 1000);
      const lim = uv < 0n ? 0n : uv > BigInt(vmax0 * 1000) ? BigInt(vmax0 * 1000) : uv;
      const want = Number((lim + 500n) / 1000n);
      expect(predMv(code, ch0.adc, ch0.divider, calib, vmax0)).toBe(want);
    }
  });

  it('code=0 只剩偏置，code=fs 触到限幅或满量程', () => {
    expect(predMv(0, ch0.adc, ch0.divider, { gainPpm: 0, offsetMv: -30 }, vmax0)).toBe(0);
    expect(predMv(0, ch0.adc, ch0.divider, { gainPpm: 0, offsetMv: 30 }, vmax0)).toBe(30);
    // 满量程码值的理论输出 30000 > 量程 20000 → 必须被限幅
    expect(predMv(ch0.adc.fs, ch0.adc, ch0.divider, { gainPpm: 0, offsetMv: 0 }, vmax0)).toBe(vmax0);
  });
});

describe('fitCalibration 求解精度', () => {
  it('2 点精确解：干净数据残差 ≤ 1 mV，scale_q16 落在真值同一台阶', () => {
    const truth = { gainPpm: 800, offsetMv: -5 };
    const pts = makePoints([800, 2400], truth);
    const r = fitCalibration(pts, ch0.adc, ch0.divider, vmax0);
    expect(r.ok, r.note).toBe(true);
    expect(r.maxAbsMv).toBeLessThanOrEqual(1);
    expect(r.offsetMv).toBe(-5);
    // 楼梯宽度 ~136 ppm：解不必逐 ppm 等于真值，但输出行为必须等价
    expect(
      scaleQ16(ch0.adc, ch0.divider, { gainPpm: r.gainPpm, offsetMv: r.offsetMv }),
    ).toBe(scaleQ16(ch0.adc, ch0.divider, truth));
  });

  it('5 点 + ±3 mV 噪声：RMS ≤ 4 mV，解仍在真值台阶上', () => {
    const truth = { gainPpm: 4200, offsetMv: -37 };
    const pts = makePoints([400, 900, 1400, 1900, 2400], truth).map((p, i) => ({
      ...p,
      // 固定噪声（不用随机数，保证测试可复现）
      inMv: p.inMv + [3, -2, 1, -3, 2][i]!,
    }));
    const r = fitCalibration(pts, ch0.adc, ch0.divider, vmax0);
    expect(r.ok, r.note).toBe(true);
    expect(r.rmsMv).toBeLessThanOrEqual(4);
    expect(
      scaleQ16(ch0.adc, ch0.divider, { gainPpm: r.gainPpm, offsetMv: r.offsetMv }),
    ).toBe(scaleQ16(ch0.adc, ch0.divider, truth));
  });

  it('求解结果与 predMv 闭环：残差就是 evalResiduals 对解的评估', () => {
    const pts = makePoints([400, 1000, 1600, 2200], { gainPpm: -1500, offsetMv: 12 });
    const r = fitCalibration(pts, ch0.adc, ch0.divider, vmax0);
    expect(r.ok, r.note).toBe(true);
    const again = evalResiduals(pts, ch0.adc, ch0.divider, { gainPpm: r.gainPpm, offsetMv: r.offsetMv }, vmax0);
    expect(again.residualsMv).toEqual(r.residualsMv);
    expect(again.rmsMv).toBeCloseTo(r.rmsMv, 10);
  });
});

describe('退化与越界', () => {
  it('单点：只解偏置，gain 固定 0，note 说明', () => {
    const pts = makePoints([1500], { gainPpm: 0, offsetMv: -25 });
    const r = fitCalibration(pts, ch0.adc, ch0.divider, vmax0);
    expect(r.ok).toBe(true);
    expect(r.gainPpm).toBe(0);
    expect(r.offsetMv).toBe(-25);
    expect(r.maxAbsMv).toBeLessThanOrEqual(1);
    expect(r.note).toContain('偏置');
  });

  it('所有点同一码值：同上，且不产生 NaN', () => {
    const pts = makePoints([1500, 1500, 1500], { gainPpm: 0, offsetMv: -25 });
    const r = fitCalibration(pts, ch0.adc, ch0.divider, vmax0);
    expect(r.ok).toBe(true);
    expect(Number.isFinite(r.gainPpm)).toBe(true);
    expect(Number.isFinite(r.offsetMv)).toBe(true);
    expect(r.note).toBeTruthy();
  });

  it('0 点：ok=false', () => {
    const r = fitCalibration([], ch0.adc, ch0.divider, vmax0);
    expect(r.ok).toBe(false);
    expect(r.note).toBeTruthy();
  });

  it('实测电压随码值下降：ok=false + 接线提示', () => {
    const pts: CalibPoint[] = [
      { code: 500, inMv: 9000 },
      { code: 2000, inMv: 3000 },
    ];
    const r = fitCalibration(pts, ch0.adc, ch0.divider, vmax0);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('没有随码值上升');
  });

  it('解超出 C11：钳位返回并说明', () => {
    // 增益真值 150000 超出 ±100000：解必须被钳在 C11 内
    const gainPts = makePoints([400, 2000], { gainPpm: 150000, offsetMv: 0 });
    const gr = fitCalibration(gainPts, ch0.adc, ch0.divider, vmax0);
    expect(gr.ok).toBe(true);
    expect(Math.abs(gr.gainPpm)).toBeLessThanOrEqual(100000);

    // 偏置真值 +2000 超出 ±1000：解钳到 +1000，且 note 指明顶到边界
    const offPts = makePoints([300, 900], { gainPpm: 0, offsetMv: 2000 });
    const or = fitCalibration(offPts, ch0.adc, ch0.divider, vmax0);
    expect(or.ok).toBe(true);
    expect(or.offsetMv).toBe(1000);
    expect(or.note).toContain('±1000');
  });

  it('小分压比（楼梯宽过整个 C11 区间）：全程扫描仍能零残差', () => {
    // RH=100/RL=1000 → ratio 1.1：scale_q16 在整个 ±10% 增益区间内几乎不变，
    // 解析初值在这种通道上可能差出几十万 ppm，只有全程扫描能兜住
    const adc = { fs: 4095, vrefMv: 3300 };
    const divider = { rHighOhm: 100, rLowOhm: 1000 };
    const truth = { gainPpm: 50000, offsetMv: 0 };
    const pts = makePoints([300, 1500, 3000], truth, adc, divider, 5000);
    const r = fitCalibration(pts, adc, divider, 5000);
    expect(r.ok, r.note).toBe(true);
    expect(r.maxAbsMv).toBeLessThanOrEqual(1);
    expect(
      scaleQ16(adc, divider, { gainPpm: r.gainPpm, offsetMv: r.offsetMv }),
    ).toBe(scaleQ16(adc, divider, truth));
  });
});

describe('fitLine 线性度', () => {
  it('共线点最大偏离 ≈ 0；带弯曲的点能测出偏离', () => {
    const straight = makePoints([400, 1200, 2000], { gainPpm: 1000, offsetMv: 0 });
    expect(fitLine(straight, ch0.adc)!.maxDevMv).toBeLessThan(1);

    // 中点抬高 400 mV：二次弯曲，两点标定救不回来
    const bent = straight.map((p, i) => (i === 1 ? { ...p, inMv: p.inMv + 400 } : p));
    const dev = fitLine(bent, ch0.adc)!.maxDevMv;
    expect(dev).toBeGreaterThan(150);
  });

  it('不足 2 个不同码值：返回 null', () => {
    expect(fitLine([], ch0.adc)).toBeNull();
    expect(fitLine([{ code: 100, inMv: 700 }], ch0.adc)).toBeNull();
    expect(
      fitLine(
        [
          { code: 100, inMv: 700 },
          { code: 100, inMv: 900 },
        ],
        ch0.adc,
      ),
    ).toBeNull();
  });

  it('pinOf 就是码值到引脚电压的线性映射', () => {
    expect(pinOf(ch0.adc.fs, ch0.adc)).toBe(ch0.adc.vrefMv);
    expect(pinOf(0, ch0.adc)).toBe(0);
  });
});

describe('yaml 往返', () => {
  it('带点模型：emit → parse 深相等，二次导出逐字节相同', () => {
    const m = modelWithCalibPoints();
    const yaml = emitConfigYaml(m);
    const parsed = parseConfigText(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.model.channels[0]!.calibPoints).toEqual(m.channels[0]!.calibPoints);
    expect(emitConfigYaml(parsed.model)).toBe(yaml);
    expect(yaml).toContain('calib_points:');
    expect(yaml).toContain('- code: 500');
    expect(yaml).toContain('in_mv: 2775');
  });

  it('无点模型：yaml 里完全不出现 calib_points（连注释都没有）', () => {
    const yaml = emitConfigYaml(presetDefault());
    expect(yaml).not.toContain('calib_points');
    // 往返不破坏
    const parsed = parseConfigText(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(emitConfigYaml(parsed.model)).toBe(yaml);
  });

  it('负向：非数组 F5 / 空数组 F6 / 缺键 F4 / 小数 F5', () => {
    const base = emitConfigYaml(modelWithCalibPoints());
    const keyLine = /^ {4}calib_points:.*$/m;

    const expectFail = (text: string, code: string, path: string): void => {
      const r = parseConfigText(text);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(
        r.diags.some((d) => d.code === code && d.path.startsWith(path)),
        `期望 ${code}@${path}，实际 ${r.diags.map((d) => `${d.code}@${d.path}`).join('、')}`,
      ).toBe(true);
    };

    // calib_points: 5（同时去掉块序列项，否则整份 YAML 都不合法，只会报 F1）
    expectFail(
      base
        .replace(keyLine, '    calib_points: 5')
        .split('\n')
        .filter((l) => !/^ {6}- code:/.test(l) && !/^ {8}in_mv:/.test(l))
        .join('\n'),
      'F5',
      'channels[0].calib_points',
    );

    // 空数组：显式 [] 要报 F6（整段省略才是合法的"没有点"）
    expectFail(
      base
        .replace(keyLine, '    calib_points: []')
        .split('\n')
        .filter((l) => !/^ {6}- code:/.test(l) && !/^ {8}in_mv:/.test(l))
        .join('\n'),
      'F6',
      'channels[0].calib_points',
    );

    // 缺 in_mv
    expectFail(
      base.split('\n').filter((l) => !/^ {8}in_mv:/.test(l)).join('\n'),
      'F4',
      'channels[0].calib_points',
    );

    // 小数码值
    expectFail(base.replace('- code: 500', '- code: 500.5'), 'F5', 'channels[0].calib_points');
  });
});

describe('C 文件标定摘要', () => {
  it('有点的通道 banner 带摘要，且重复生成逐字节相同', () => {
    const m = modelWithCalibPoints();
    const a = emitFiles(m).c;
    const b = emitFiles(m).c;
    expect(a).toBe(b);
    expect(a).toContain('标定：3 点实测拟合');
    expect(a).toContain('gain +1234 ppm');
  });

  it('摘要只是注释：剥掉注释后与"无点模型"的代码行完全一致', () => {
    const withPts = emitFiles(modelWithCalibPoints()).c;
    const noPtsModel = modelWithCalibPoints();
    const { calibPoints: _drop, ...rest } = noPtsModel.channels[0]!;
    noPtsModel.channels = [{ ...rest }];
    const without = emitFiles(noPtsModel).c;
    expect(codeLines(withPts)).toEqual(codeLines(without));
  });

  it('黄金基准（presetLibrary）不带点，banner 无摘要', () => {
    expect(emitConfigYaml(presetDefault())).not.toContain('calib_points');
  });
});

describe('store：标定点 action', () => {
  it('addPoint 默认落在量程 60% 处；删空还原为 undefined；patchPoint 强制取整', () => {
    let m = presetDefault();

    m = reducer(m, { type: 'addPoint', index: 0 });
    const pts1 = m.channels[0]!.calibPoints!;
    expect(pts1).toHaveLength(1);
    expect(pts1[0]!.inMv).toBe(Math.round(vmax0 * 0.6));
    expect(pts1[0]!.code).toBeGreaterThan(0);

    m = reducer(m, { type: 'patchPoint', index: 0, k: 0, patch: { code: 123.6, inMv: 4567.4 } });
    expect(m.channels[0]!.calibPoints![0]).toEqual({ code: 124, inMv: 4567 });

    m = reducer(m, { type: 'removePoint', index: 0, k: 0 });
    expect(m.channels[0]!.calibPoints).toBeUndefined();
    // 删空后 yaml 不含该段
    expect(emitConfigYaml(m)).not.toContain('calib_points');

    m = reducer(m, { type: 'addPoint', index: 0 });
    m = reducer(m, { type: 'clearPoints', index: 0 });
    expect(m.channels[0]!.calibPoints).toBeUndefined();
  });
});
