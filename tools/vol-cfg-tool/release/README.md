# Lib_VolM 电压管理库 — 分发包

车载/工业电源电压监视 C 库 + 配套配置生成工具。纯 C99、零动态内存、编译期配置校验。

**版本信息**

| 项 | 版本 | 含义 |
|---|---|---|
| 库 | V{{LIB}} | 接口与状态机语义版本（`inc/vol.h` 的 `VOL_VERSION_STRING`） |
| 配置工具 | v{{TOOL}} | 生成 `vol_cfg.h` / `vol_cfg.c` 的网页工具 |
| 配置格式 | volm-cfg/1 | `vol_cfg.yaml` 的字段格式（向下兼容，不向上兼容） |

打包日期：{{DATE}}

## 目录导航

```
lib/                    库源码（C99，可直接编译）
  inc/                  对外头文件：vol.h（5 个 API）、vol_types.h、vol_cfg.h（配置，可被工具生成物覆盖）
  src/                  实现：vol_calc / vol_filt / vol_sm / vol + vol_cfg.c（配置落地 + 全部编译期断言）
  UnitTest/             宿主机单元测试（build.sh，需 gcc）
  Template/main.c       集成示例：双通道演示，可独立编译运行
  doc/VolM_Architecture.md  架构基线（含全部设计决策 D1~D13 与校验规则 C1~C11）
  ReadMe.md             库的详细说明（接口、集成步骤、资源占用）

tools/vol-cfg-tool/     配置生成工具
  index.html            单文件网页工具，双击即用（离线、无网络请求）
  start.cmd             双击启动入口
  README.md             工具用法
  samples/              示例配置三件套（yaml + 由它生成的 h/c）
  src/ tests/ scripts/  工具源码（可选：npm install && npm run build 重新构建）

config/                 预置配置（12 V 系统：4 状态 + 一路 RBIN，板上参数）
  vol_cfg.yaml          配置唯一真源
  vol_cfg.h / vol_cfg.c 与该 yaml 完全对应的生成物
```

## 快速开始

**A. 直接用库（不改配置）**

1. 把 `lib/inc/` 与 `lib/src/` 加进工程（5 个 .c：vol、vol_calc、vol_filt、vol_sm、vol_cfg）；
2. 上电调 `Vol_Init()`，ADC 中断里 `Vol_SetAdcValue(ch, raw)`，主循环按采样周期调 `Vol_Task()`；
3. 查询：`Vol_GetVoltage(ch, &mv)`（滤波后电压）、`Vol_GetState(ch, &st)`（当前状态号）。

**B. 改配置（推荐流程）**

1. 双击 `tools/vol-cfg-tool/index.html`（或 `start.cmd`）；
2. 点"导入配置"载入 `config/vol_cfg.yaml`，在页面上改参数；
3. 看到 **0 错误** 后点"下载 vol_cfg.h + vol_cfg.c"，覆盖 `lib/inc/vol_cfg.h` 与 `lib/src/vol_cfg.c`；
4. 点"导出配置"更新 `vol_cfg.yaml`，与两份 C 文件一起入库。

> 改配置永远回工具里改：手改 C 文件会在下次生成时被整份覆盖。

**C. 宿主机自检（可选，需 gcc）**

```
cd lib
bash UnitTest/build.sh        # 五个用例：配置自检/换算/滤波/状态机/接口
gcc -std=c99 -Wall -Iinc -Isrc Template/main.c src/vol_cfg.c src/vol_calc.c \
    src/vol_filt.c src/vol_sm.c src/vol.c -o vol_demo && ./vol_demo   # 双通道演示
```

## 三个版本号的关系

- **库 V{{LIB}}**：接口/语义变化才升（`VOL_VERSION_STRING`）；
- **配置格式 volm-cfg/1**：yaml 字段变化才升；新版工具能读旧配置（自动升级），旧工具读到新格式直接报错；
- **工具 v{{TOOL}}**：每次发布都升，只用于追溯，不影响兼容。

生成的 `vol_cfg.h/c` 文件头带 `@note` 行（工具版本 + 生成日期 + 目标库版本），
现场拿到一份文件就能确定它是哪版工具、对着哪版库生成的。

## 环境要求

- 库：C99 编译器（IAR / GCC 均可），无动态内存、无库依赖；
- 宿主机自检：gcc（或任意 C99 编译器）+ bash；
- 配置工具：任意现代浏览器（Chrome / Edge / Firefox），双击 index.html 即可，无需安装。
