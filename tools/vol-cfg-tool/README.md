# vol-cfg-tool — Lib_VolM 配置生成工具

填好配置 → 直接生成可编译的 `vol_cfg.h` + `vol_cfg.c`。纯前端单文件，离线可用。

## 快速开始

1. 双击 `start.cmd`（或直接打开 `dist/index.html`）；
2. 右上角 **导入配置** 载入 `samples/vol_cfg.yaml`，或在页面上直接填写；
3. 看到 **0 错误** 后点 **下载 vol_cfg.h + vol_cfg.c**，覆盖到库的 `inc/` 与 `src/`；
4. 点 **导出配置** 把 `vol_cfg.yaml` 与两份 C 文件一起入库。

> 换配置永远回工具里改，不要手改 C 文件——生成会整份覆盖，手改的东西会丢。

## 三份文件的分工

| 文件 | 性质 | 放哪 |
|---|---|---|
| `vol_cfg.yaml` | 配置唯一真源，入库 | 工程内任意位置 |
| `vol_cfg.h` | 生成物 | `inc/` |
| `vol_cfg.c` | 生成物 | `src/` |

## 配置文件（vol_cfg.yaml）

- 顶部 `schema: volm-cfg/1` 是**格式号**；`generator` 段是"谁生成的"记录，可省略；
- **向下兼容、不向上兼容**：新工具读旧文件自动升级；旧工具读到新格式直接报错拒绝，不猜着读；
- 字段严格校验：未知键、缺键、类型错、长度不匹配都会报出**字段路径**，点错误列表可跳到对应输入框；
- 导出不含时间戳、字段顺序固定：同一配置重复导出逐字节相同，git diff 只出现真正改动的数值。

## 校验规则

- **F1~F6**：文件与语法问题（语法 / 格式版本 / 未知键 / 缺键 / 类型 / 长度）；
- **C1~C11**：库的编译期断言规则，工具在生成前就报同样的错——生成的代码必然能编译；
- **W1~W9**：工程建议（如"量程高于分压满量程"、标定点码值/实测电压不自洽），不阻止下载。

规则详情见 `../../doc/VolM_Architecture.md` §5.3。

## 标定打点（v0.2.0 新增）

每个通道卡片下方有**标定面板**：把几个实测点（ADC 码值 + 万用表读的总电压）填进去，
工具会自动拟合出修正后的 `GAIN_PPM` 与 `OFFSET_MV`：

- 点以红点画在通道折线图上，可直接拖动微调；红色虚线是拟合出的"实测曲线"；
- 求解先做最小二乘解析初值，再对 `scale_q16` 做 **1 ppm 步进精扫**——
  因为库的系数是"先整除后乘 65536"（截断），纯解析解可能偏差几百 ppm；
- 求解结果回填增益/偏置残差，蓝色名义曲线随之贴合红色实测曲线；
- 点保存在 `vol_cfg.yaml` 的 `calib_points` 段（可选段，无点时输出与旧版逐字节相同）；
- 生成的 `vol_cfg.c` 头部会带一行标定摘要（点数、最大残差、RMS）。

## 命令

```
npm install          # 依赖（React/Vite/Vitest/js-yaml）
npm run dev          # 本地开发
npm run build        # 产出单文件 dist/index.html
npm test             # 全部单元测试（e2e 默认跳过）
npm run e2e          # 端到端：生成物换进库副本跑 UnitTest + 探针比对
npm run typecheck    # tsc --noEmit
```

开发期辅助（按需）：

```
VOLCFG_DUMP=1  npx vitest run tests/dump.test.ts   # 重新生成 samples/ 三份样例 + 注释差异报告
node scripts/gen-skeleton.mjs                      # 库原件变更后刷新生成器骨架
node scripts/check-project.mjs [工程根]            # 对比 IAR 工程内 VolM 副本与主库（只读）
VOLCFG_IN=<yaml> VOLCFG_OUT=<目录> npx vitest run tests/export.test.ts
                                                   # 无界面导出（与界面下载同源，CI 用）
```

## 测试矩阵（v0.2.0 实测）

| 验证项 | 结果 |
|---|---|
| golden：12 V 库示例 → 与手写原件逐字节一致 | 0 差异 |
| 定点基准值 CH0 = 363593728 / RBIN = 696844288 | 一致 |
| 单元测试（golden/scale/rules/roundtrip/assert-parity/compile/store/version/calibration） | 196 项通过 |
| e2e-A：生成物替代手写原件，`bash UnitTest/build.sh` | 五个用例全绿 |
| e2e-B：default / 5 通道 / 12 状态三套配置，gcc C99+C11 零告警，探针比对配置表 | 逐项一致 |
| 断言对拍：规则号 ↔ C 断言 tag，含 C99 负数组长度与 C11 `_Static_assert` 两路 | 全覆盖 |
| 产物 | `dist/index.html`，约 364 KB 单文件 |

## 兼容性基线

- **状态数**：1..12（`VOL_STATE_NUM_MAX`，与库断言 `m_state_num_max` 同步；要再放宽需库、默认值、工具三处一起改，见 `src/core/rules.ts` 注释）；
- **通道数**：1..8（库已解除"最多 2 通道"限制）；
- **仅测量通道**（状态数 0，如 RBIN）：支持；
- **IAR 工程**：`node scripts/check-project.mjs` 确认工程副本与主库同步（库代码逐字节一致；工程自身的通道数/状态数是工程级配置，与上限属正常差异）。

## 已知边界

- 日期只到"天"（`@note 由 vol-cfg-tool v0.2.0 生成于 YYYY-MM-DD`）——同日重生成零 diff，时刻交给 git；
- 浏览器下载会进"下载"目录，两份文件一次下载；首次使用建议先导入 `samples/vol_cfg.yaml` 试一遍流程。
