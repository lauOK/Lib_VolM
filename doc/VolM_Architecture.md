# Lib_VolM 软件架构设计

> 目标平台：32 位 ARM Cortex-M MCU（无 FPU 亦可用）
> 组件定位：汽车 ECU 电压管理组件（多通道 ADC 采样 → 滤波 → 真实电压换算 → 电压状态机）
> 文档状态：**V1.4 已修订（2026-11-02），作为编码基线**
> 决策依据：D1 单通道写入、D2 迟滞按状态且上下行独立、D3 电压 mV/`uint16_t` 全整数、D6 单元测试入工程
> V1.1 变更：迟滞由"每状态单值（隐式对称）"改为"每状态 `hyst_up` / `hyst_down` 两个独立值"，支持任意非对称门限；校验规则改为与应用无关的通式。
> V1.2 变更：补实现层澄清——类型归属、系数截断（C9 改为强转前断言）、异常路径契约（D9）、临界区保护范围、初始化时序、应用侧集成约束。
> V1.3 变更：新增 C11 配置量闭区间断言与 `VOL_R_MAX_OHM`（1 MΩ）；补编译期中间量的 `uint64` 上界证明（§4.2）。宏与算法结构不变。
> V1.4 变更：新增仅测量通道（RBIN，`state_num == 0`，D11/D13）与通道级电压量程 `VOL_CHn_VOLTAGE_MAX_MV`（D12，取消全局量程）。

---

## 1. 范围

### 1.1 本组件做什么

1. 支持 **1..N 个电压管理通道** 的静态实例化，每个通道绑定一路 ADC 采样值输入。
2. 对每通道原始 ADC 码值执行 **滑动窗口滤波**（窗口大小可按"采样次数"或"滤波时间"静态配置）。
3. 将滤波后的 ADC 码值换算为 **真实电压**（考虑参考电压、ADC 满量程、分压电阻比、增益偏差、偏置偏差）。
4. 依据换算电压执行 **电压状态切换**，每个状态有独立的上下限阈值与 **上下行独立的迟滞量**，状态数量、边界位置、门限全部由配置决定。**通道可选择只测电压、不管理状态**（仅测量通道 / RBIN，`state_num == 0`），此时功能 1~3 照常，跳过第 4 项。
5. 向上仅提供 5 个接口：初始化、周期 Task、写入 ADC 值、读取电压、读取状态。
6. 每通道的 **电压量程独立配置**（`VOL_CHn_VOLTAGE_MAX_MV`），用于该通道的限幅与状态表末端校验；不同通道可覆盖不同电压范围。

### 1.2 本组件明确不做（防止范围蔓延）

| 不做的事 | 原因 |
|---|---|
| ADC 驱动 / 采样触发 / DMA 配置 | 由 MCU 抽象层负责，本组件只接收已采样的码值 |
| 运行时动态配置（阈值、窗口、分压比等） | 需求明确要求全部编译期静态配置 |
| 标定数据存储（NVM/EEPROM）、诊断服务（UDS/DEM/DTC） | 属 ECU 其他组件职责 |
| 电压状态变化的回调 / 通知机制 | 未在需求中提出，上层通过周期查询获取状态 |
| 故障注入、超时监控、看门狗、任务调度 | 由 OS/调度层负责 |
| 对具体业务场景的假设（如"9 V 算低压"） | 库只提供机制，状态数量与门限全部由应用配置 |
| 浮点运算、动态内存、递归 | 平台与安全约束（见 §8） |

---

## 2. 总体架构

### 2.1 分层

```
┌──────────────────────────────────────────────────────────────┐
│  应用层（ECU 其他 SWC）                                        │
│    Vol_Init() / Vol_Task() / Vol_SetAdcValue()                │
│    Vol_GetVoltage() / Vol_GetState()                          │
└───────────────────────────┬──────────────────────────────────┘
                            │ 5 个公开接口（vol.h）
┌───────────────────────────▼──────────────────────────────────┐
│  vol.c  对外接口层 / 通道调度层                                 │
│    · 初始化状态守卫（E_NOT_INIT）                              │
│    · 通道号合法性检查（E_PARAM）                               │
│    · 通道上下文数组遍历                                        │
└──────┬───────────────────┬───────────────────┬───────────────┘
       │                   │                   │
┌──────▼──────┐   ┌────────▼────────┐   ┌──────▼──────────────┐
│ vol_calc.c  │   │ vol_filt.c      │   │ vol_sm.c            │
│ 码值→mV     │   │ 滑动窗口均值     │   │ 电压状态机 + 迟滞    │
│ 定点乘加    │   │ 环形缓冲/运行和  │   │ 纯函数，无副作用      │
└──────┬──────┘   └────────┬────────┘   └──────┬──────────────┘
       │                   │                   │
┌──────▼───────────────────▼───────────────────▼──────────────┐
│  vol_cfg.c / vol_cfg.h   编译期静态配置                        │
│    · 通道参数表（const）· 状态阈值表（const）· 滤波缓冲（static）│
│    · 编译期断言（CONFIG_CHECK）                                │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 模块职责与文件清单

| 模块 | 文件 | 职责 | 依赖 |
|---|---|---|---|
| 公开接口 | `inc/vol.h` | 5 个 API 声明 | `vol_types.h`、`vol_cfg.h` |
| 类型定义 | `inc/vol_types.h` | `Vol_ReturnType`、`Vol_VoltageType(uint16 mV)`、`Vol_AdcValueType(uint16)`、状态常量 | `<stdint.h>` |
| 静态配置 | `inc/vol_cfg.h`、`src/vol_cfg.c` | 通道宏、参数表、阈值表、滤波缓冲、编译期断言 | `vol_types.h` |
| 接口/调度 | `src/vol.c` | API 实现、通道上下文管理、上下文守卫 | 全部内部模块 |
| 电压换算 | `src/vol_calc.c` / `.h` | 码值 → mV（Q16 定点，无浮点、无运行时除法） | `vol_cfg.h` |
| 滑动滤波 | `src/vol_filt.c` / `.h` | 环形缓冲、运行和、输出均值 | `vol_cfg.h` |
| 状态机 | `src/vol_sm.c` / `.h` | 状态迁移判定（上下行独立迟滞），纯函数 | `vol_cfg.h` |
| 内部接口 | `src/vol_priv.h` | 通道运行时上下文结构、内部函数原型 | — |
| 单元测试 | `UnitTest/` | 断言式回归（换算/滤波/状态机/集成） | 全部 |
| 集成示例 | `Template/main.c` | 可直接编译运行的 `main` 示例 | 全部 |

> 目录约定：`inc/` 对外（应用可见），`src/` 内部实现（`vol_priv.h` 不对外），`UnitTest/` 与 `Template/` 只在宿主机编译，不进入 MCU 构建。

### 2.3 数据流

```
   ADC 采样完成中断 / 周期采样
            │
            ▼
   Vol_SetAdcValue(ch, raw)          ← 数据路径（每采样一次调用一次）
            │
            ├─► vol_calc: raw → mV（Q16 定点乘 + 移位 + 偏置 + 限幅）
            │
            └─► vol_filt: 压入环形缓冲，运行和更新，窗口满则更新 v_mv
                                              （未满 → valid = FALSE）

   Vol_Task()                         ← 状态路径（固定周期调用）
            │
            └─► 逐通道：valid ? vol_sm(v_mv) : 保持 VOL_STATE_INVALID
```

**职责切分原则**：`Vol_SetAdcValue` 只做"数据"，`Vol_Task` 只做"状态"。采样速率与 Task 周期解耦：采样可在中断里高频调用，状态判定频率由 Task 周期决定且可控。

---

## 3. 编译期配置体系

### 3.1 配置原则

- 所有参数以 **宏** 形式集中在 `inc/vol_cfg.h`，通过 `const` 表在 `src/vol_cfg.c` 落地；运行时无任何 setter。
- 参数分两级：**模块级**（通道总数、采样周期、窗口与状态数上限、电阻上限）与 **通道级**（分压比、**电压量程**、偏差、滤波、状态表）。
- 合法性由 **编译期断言** 保证（`vol_cfg.c` 内 `VOL_STATIC_ASSERT`），非法配置直接编译失败，不占运行时开销。
- 所有数值均为 **整数**：电压 mV、电阻 Ω、增益 ppm、时间 ms、窗口 采样次数。
- 库不含任何业务假设：状态数量、边界位置、迟滞量全部由应用配置。

### 3.2 模块级宏

| 宏 | 含义 | 典型值 | 约束 |
|---|---|---|---|
| `VOL_CHANNEL_NUM` | 通道实例数 | 1..8 | ≥1 且 ≤ `VOL_CHANNEL_NUM_MAX`(8) |
| `VOL_ADC_SAMPLE_PERIOD_MS` | 期望采样周期（TIME 模式换算基准） | 1 | ≥1 |
| `VOL_FILTER_WINDOW_MAX` | 单通道窗口上限（用于断言） | 64 | 1..1024 |
| `VOL_STATE_NUM_MAX` | 单通道状态数上限（用于断言） | 12 | 1..12 |
| `VOL_R_MAX_OHM` | 分压电阻上限（用于断言，不参与运算） | 1000000 | ≥1；工程上、下臂均不超过 1 MΩ |
| `VOL_CRITICAL_ENTER()` / `VOL_CRITICAL_EXIT()` | 临界区钩子（默认空） | 空 | 见 §7 |

> **电压量程是通道属性，不设全局值**（V1.4）。各通道的分压比、ADC 位数、被测量对象不同，量程天然不同；单值全局量程会让"仅测量通道"被迫与状态通道共用一个上限，导致高量程通道被静默截断。故量程由每通道的 `VOL_CHn_VOLTAGE_MAX_MV` 独立指定，用于该通道的限幅与状态表末端校验。

### 3.3 通道级宏（以通道 0 为例）

| 宏 | 含义 | 单位 | 约束 |
|---|---|---|---|
| `VOL_CH0_ADC_FS` | ADC 满量程码值 | LSB | 1..65535（12 位用 4095） |
| `VOL_CH0_VREF_MV` | ADC 参考电压 | mV | 1..5000 |
| `VOL_CH0_R_HIGH_OHM` | 分压上臂电阻 | Ω | 0..`VOL_R_MAX_OHM`，且 RH+RL>0 |
| `VOL_CH0_R_LOW_OHM` | 分压下臂电阻 | Ω | 1..`VOL_R_MAX_OHM` |
| `VOL_CH0_GAIN_PPM` | 增益偏差（标定） | ppm | -100000..100000 |
| `VOL_CH0_OFFSET_MV` | 偏置偏差（标定） | mV | -1000..1000 |
| `VOL_CH0_FILT_MODE` | 滤波配置模式 | — | `VOL_FILT_BY_SAMPLE` / `VOL_FILT_BY_TIME` |
| `VOL_CH0_FILT_ARG` | 次数 或 时间(ms) | 次 / ms | ≥1 |
| `VOL_CH0_VOLTAGE_MAX_MV` | 该通道电压量程上限（限幅、状态表末端） | mV | 1..65535；按分压比与被测对象独立取值 |
| `VOL_CH0_STATE_NUM` | 该通道状态数；**0 = 仅测量通道（RBIN），不管理状态** | — | 0..12 |
| `VOL_CH0_S<i>_LOWER_MV` | 状态 i 下限（含） | mV | 见 §5.3 校验规则；`STATE_NUM==0` 时无需定义 |
| `VOL_CH0_S<i>_UPPER_MV` | 状态 i 上限（不含） | mV | 同上 |
| `VOL_CH0_S<i>_HYST_UP_MV` | 状态 i **上行**迟滞 | mV | ≥0；首末状态外边界为 0 |
| `VOL_CH0_S<i>_HYST_DOWN_MV` | 状态 i **下行**迟滞 | mV | ≥0；首末状态外边界为 0 |

**窗口换算（编译期完成）**：

```c
#define VOL_CH0_FILT_WINDOW                                                   \
    ((VOL_CH0_FILT_MODE == VOL_FILT_BY_TIME)                                  \
        ? (((VOL_CH0_FILT_ARG) + VOL_ADC_SAMPLE_PERIOD_MS - 1u)               \
           / VOL_ADC_SAMPLE_PERIOD_MS)          /* 向上取整，至少 1 次 */      \
        : (VOL_CH0_FILT_ARG))
```

> TIME 模式按"一次采样周期采一个点"的工程约定换算为采样次数，换算结果即实际窗口深度；该前提在 ReadMe 中显式写明。
>
> 实现上抽为 `VOL_FILT_WINDOW_CALC(mode, arg)` 宏，各通道再派生 `VOL_CHn_FILT_WINDOW`，语义与上式一致；抽宏是为了避免每个通道重复一遍三目表达式。

### 3.4 参数表结构（`src/vol_cfg.c`）

```c
typedef struct {
    Vol_VoltageType lower_mv;        /* 状态下限（含） */
    Vol_VoltageType upper_mv;        /* 状态上限（不含） */
    Vol_VoltageType hyst_up_mv;      /* 离开本状态向上：门限 = upper + hyst_up */
    Vol_VoltageType hyst_down_mv;    /* 离开本状态向下：门限 = lower - hyst_down */
} Vol_StateCfgType;

typedef struct {
    uint32_t scale_q16;          /* 编译期算好的 µV/LSB，Q16 定点 */
    int32_t  offset_uv;          /* 编译期算好的偏置 µV */
    uint16_t voltage_max_mv;     /* 本通道量程上限（V1.4：通道级，非全局） */
    uint16_t window;             /* 滤波窗口深度（采样次数） */
    uint8_t  state_num;          /* 状态数；0 = 仅测量通道（RBIN），不管理状态 */
    const Vol_StateCfgType *state_cfg;  /* state_num == 0 时必须为 NULL（C12） */
    Vol_FilterSampleType   *filt_buf;   /* 指向 static 缓冲，Init 时装载 */
} Vol_ChannelCfgType;

extern const Vol_ChannelCfgType Vol_ChannelCfgTable[VOL_CHANNEL_NUM];
```

**仅测量通道（RBIN）**：`state_num == 0` 即表示该通道只做"换算 + 滤波 + 提供电压值"，不参与状态管理。此时：

- `state_cfg` 必须为 `NULL`，应用无需定义任何 `VOL_CHn_S<i>_*` 宏；
- `Vol_Task` 直接跳过该通道，不访问状态表；
- `Vol_GetVoltage` 行为与普通通道**完全一致**（含限幅、窗口未满返回 `VOL_E_NOT_READY`）；
- `Vol_GetState` 返回 `VOL_E_NO_STATE`，`*state = VOL_STATE_INVALID`；
- 省下一整张 `Vol_StateCfgType` 表（ROM）和一个状态变量（RAM）。

> 实现注意：状态相关的编译期断言与静态表必须用 `#if VOL_CHn_STATE_NUM > 0` 包住。`STATE_NUM == 0` 的通道不会定义 `S0_LOWER_MV` 等宏，若无条件引用会直接编译失败。`state_cfg` 指针与 `state_num` 由同一组条件编译派生（见 §5.3 C12），不要在表项里手写指针。

**类型归属**（P0 第一步就要定，否则头文件互相引用会卡住）：

| 类型 | 所在头文件 | 原因 |
|---|---|---|
| `Vol_VoltageType` / `Vol_AdcValueType` / `Vol_FilterSampleType` / `Vol_ReturnType` | `inc/vol_types.h` | 基础类型，全部模块可见 |
| `Vol_StateCfgType` / `Vol_ChannelCfgType` | `inc/vol_cfg.h` | 应用要直接书写配置表，必须对外可见 |
| `Vol_FilterType` / `Vol_ChannelType` | `src/vol_priv.h` | 纯运行期上下文，不对外暴露 |

`scale_q16` 由宏在编译期算出（整数常量折叠，无浮点）：

```c
/* 64 位形式：供编译期断言使用，禁止直接参与运行期运算 */
#define VOL_CH_SCALE_Q16_64(ch)                                               \
    (((((uint64_t)VOL_##ch##_VREF_MV * 1000ULL)                                \
        * ((uint64_t)VOL_##ch##_R_HIGH_OHM + (uint64_t)VOL_##ch##_R_LOW_OHM)   \
        * (uint64_t)(1000000LL + VOL_##ch##_GAIN_PPM))                         \
        / (((uint64_t)VOL_##ch##_ADC_FS * (uint64_t)VOL_##ch##_R_LOW_OHM)      \
        * 1000000ULL)) * 65536ULL)

/* 32 位形式：写入配置表；截断风险由 C9 在强转前断言拦截 */
#define VOL_CH_SCALE_Q16(ch)     ((uint32_t)VOL_CH_SCALE_Q16_64(ch))
```

> 参数 `ch` 传的是**通道记号** `CH0` / `CH1`（展开后拼成 `VOL_CH0_VREF_MV` 等），不是数字 `0` / `1`。断言宏 `VOL_ASSERT_CH_COMMON(CH0)` 同理。

> 已用宿主机验证：vref=3300、fs=4095、RH=30k、RL=5.1k、gain=+500ppm、offset=-10mV 时 `VOL_CH_SCALE_Q16 = 363593728`，adc=2048 → 11352 mV，与理论值 11.35 V 一致。

### 3.5 新增一个通道的成本

在 `vol_cfg.h` 增加一组 `VOL_CHn_*` 宏 → 在 `vol_cfg.c` 增加一个 `static` 缓冲与一条表项 → `VOL_CHANNEL_NUM` +1。无代码改动，无 RAM 动态申请。

---

## 4. 计算链路设计（vol_calc）

### 4.1 公式链

| 步骤 | 公式 | 说明 |
|---|---|---|
| 1 | `V_pin = raw × VREF / FS` | ADC 引脚电压 |
| 2 | `V_bat = V_pin × (RH + RL) / RL` | 还原分压前电压 |
| 3 | `V_cal = V_bat × (1e6 + GAIN_PPM) / 1e6` | 增益标定 |
| 4 | `V_cal + OFFSET_MV × 1000` | 偏置标定（µV） |
| 5 | 限幅 `[0, VOL_CHn_VOLTAGE_MAX_MV]`、四舍五入到 mV | 输出 `uint16_t`；量程按通道独立 |

其中增益偏差（乘性，决定斜率）与偏置偏差（加性，决定截距）都是板级标定残差，编译期合并进 `scale_q16` 与 `offset_uv`，运行时零开销。

### 4.2 定点实现（关键性能设计）

步骤 1..3 均为常数系数，**在编译期合成为一个 Q16 定点系数**，运行时每采样点仅需：

```c
uint64_t prod = ((uint64_t)adc * cfg->scale_q16) >> 16;     /* 名义 µV，无符号 */
int64_t  uv   = (int64_t)prod + (int64_t)cfg->offset_uv;    /* 偏置可为负，必须有符号 */
int64_t  lim  = (int64_t)cfg->voltage_max_mv * 1000;

if (uv < 0)     { uv = 0; }        /* 负偏置在 0 码值处会算出负电压 */
if (uv > lim)   { uv = lim; }      /* 通道级量程限幅 */

uint16_t mv = (uint16_t)(((uint32_t)uv + 500u) / 1000u);    /* µV → mV，四舍五入 */
```

> **偏置相加必须有符号**（P1 实测修正）：早期草稿写成 `(uint32_t)(...) + (uint32_t)cfg->offset_uv`，`offset_uv = -10 mV` 时 `0 + (uint32_t)(-10000)` 回绕成 4 294 957 296 µV，限幅后输出的是量程上限 **20000 mV** 而不是 0——静默失效，接口上看不出错。现改为 `int64_t` 过渡；限幅后数值 ≤ 65535×1000，再转 `uint32_t` 做除法，避免 64 位除法引入 `__aeabi_ldivmod`（实测 `vol_calc.o` 零未定义符号）。

- ✅ 运行时 **无浮点**；除法仅 1 次 `uint32/1000`，因除数是字面常量，编译器折叠为乘加移位，实测无 `__udivsi3` 调用。
- ✅ 每采样点 ≈ 1 次 64 位乘（`UMULL`）+ 1 次移位 + 1 次 64 位加 + 2 次比较（Cortex-M3/M4 约 10~15 周期）。
- ✅ 内部以 µV 计算（限幅上限 65535 mV = 6.55e7 µV，`int32` 装得下），避免 mV 级截断再滤波的双重量化。
- ✅ 系数由物理量（Vref、FS、电阻比、ppm）在编译期推导，配置侧保持物理含义可读。
- 溢出与截断：`raw × scale_q16` 用 64 位计算，最大 2^48 < 2^63；但真正会出事的是**系数本身的截断**——宏算出 64 位结果后要强转 `uint32_t`，因此断言必须落在**强转之前**。若断言强转后的值，`(uint32_t)` 已静默截断，断言恒真、形同虚设（实测：上臂电阻误写成 3 GΩ 时 `K64 = 5.5e10`，截断成 `3.4e9`，断言照样通过，换算结果 106 V）。所以 C9 校验的是 64 位表达式 `VOL_CH_SCALE_Q16_64(ch) < 2^32`。注意 C9 只保证**系数本身**不溢出，并不保证 `adc × scale_q16 >> 16` 一定 < 2^32（分压比极大时可能超出）；因此中间量用 `int64` 承接，超出部分由量程限幅吞掉，不会回绕。

**编译期中间量的 `uint64` 上界**（C11 生效后成立）：

宏内三个因子连乘 `VREF(mV)×1000 × (RH+RL) × (1e6+GAIN_PPM)`，取 C11 允许的最坏值：

```
5,000,000 µV（VREF=5000）× 2,000,000 Ω（RH+RL，两者均 ≤1M）× 1,100,000（GAIN=+10%）
= 1.10e19  <  2^64 ≈ 1.845e19        余量 1.68 倍
```

分母 `FS × RL × 1e6` 最小为 `1 × 1 × 1e6 = 1e6`，恒正（除零由 C9 保证）。因此 **`uint64` 足够，不需要 `uint128`，也不需要重排乘法顺序或先约分**；乘法全在编译期常量折叠，运行期零开销。

反过来说：**没有 C11 就没有这个上界证明**。`R_HIGH` 误写成 3 GΩ 时因子变成 `3e9`，乘积约 `1.5e22`，`uint64` 直接回绕，而回绕值可能恰好落在 `2^32` 以下，C9 挡不住（实测已找到 `5.66 MΩ`、`11.3 MΩ` 等多个漏检点）。所以 `VOL_R_MAX_OHM` 不是业务假设，而是让编译期算术可证明的**前提条件**——它把"工程上电阻不超过 1 MΩ"这条事实转成了编译期可校验的约束。

### 4.3 对外电压单位

`Vol_GetVoltage` 输出 **mV（`uint16_t`）**。1 mV 分辨率对应 12 位 ADC/3.3 V 的 LSB≈0.81 mV，不损失状态判定能力；电压恒为非负，故用无符号类型。

换算结果在进入滤波前限幅到 `[0, cfg->voltage_max_mv]`（该通道自己的量程），负偏置或超量程输入不会向上层输出非物理值；限幅后滤波输出天然落在合法区间，状态机无需再做范围保护。量程按通道独立，因此一条 RBIN 通道可以设 40000 mV 而不影响另一条 20000 mV 的状态通道。

---

## 5. 滤波与状态机设计

### 5.1 滑动窗口均值（vol_filt）

- 结构：环形缓冲 `uint16 buf[window]`（mV）+ 写索引 + 已填充计数 + 运行和 `uint32 sum`。
- 算法：新样本覆盖最旧样本，`sum += new - old`，`mean = sum / count`。
- 复杂度：O(1)/样本（1 次 32 位加、1 次 32 位减、1 次 32 位除）。
- RAM：`window × 2 + 8` 字节/通道。
- 溢出：`65535 × 1024 = 6.7e7`，`uint32` 安全。
- 窗口未满：**不输出有效电压**，`valid = FALSE`，状态保持 `VOL_STATE_INVALID`（0xFF 保留值），Get 返回 `VOL_E_NOT_READY`。
- 抗抖动取舍：滑动均值对阶跃为线性斜坡，窗口深度即等效延迟，N 个采样点后完全响应。

> 备选（如评审要求更快收敛）：首样本预填充整个窗口，使第 1 个采样点即可输出。默认不启用，保持行为确定。

### 5.2 迟滞语义（D2，V1.1 修订为上下行独立）

**每个状态配置两个独立的迟滞量**，分别作用于它的上边界与下边界：

- 离开状态 i **向上**：门限 `U_i = upper_i + hyst_up_i`，即上行进入 i+1
- 离开状态 i **向下**：门限 `D_i = lower_i − hyst_down_i`，即下行进入 i−1

因此每条边界 `b_i`（= `upper_i` = `lower_{i+1}`）有 **两条互不相关的门限**：

| 门限 | 表达式 | 由哪个字段决定 |
|---|---|---|
| 上行 `U_i` | `b_i + hyst_up_i` | 低侧状态 i 的 `hyst_up_mv` |
| 下行 `D_i` | `b_i − hyst_down_{i+1}` | 高侧状态 i+1 的 `hyst_down_mv` |

```
       状态 i                     b_i                     状态 i+1
  ────────────┤──────── D_i ┄┄┄┄┄┼┄┄┄┄┄ U_i ────────├────────────
                            ↑                       ↑
                    从 i+1 下行进入 i        从 i 上行进入 i+1
```

`D_i` 与 `U_i` 之间是不动作带，宽度为 `hyst_up_i + hyst_down_{i+1}`。两条门限 **不要求关于边界对称**，因此可以表达：

- 上行迟滞与下行迟滞不同（例如"上升 0.5 V 才算过压，回落 2 V 才算欠压"）；
- 同一条边界的两侧由不同状态分别控制（上行看低侧状态，下行看高侧状态）；
- 任意状态数量（1..12）与任意边界位置，全部由配置决定，库不做业务假设；状态表是外部 const 数组 + 指针，放宽上限不改变 `Vol_ChannelCfgType` 大小。

> 历史说明：V1.0 用单值 `hyst_mv` 同时作用于上下边界，数学上强制 `(U + D) / 2 == b`，无法表达非对称门限（例如边界 9 V 要求上行 10 V、下行 7 V 时中点 8.5 ≠ 9）。V1.1 拆成两个字段后此限制消除。

### 5.3 状态表合法性（编译期断言）

| 编号 | 规则 | 目的 |
|---|---|---|
| C1 | `state_num ≤ VOL_STATE_NUM_MAX`；`0` 表示仅测量通道（RBIN） | 容量；允许无状态通道 |
| C2 | 表项按电压升序（由 C5 + C6 保证） | 单调性 |
| C3 | `S0.lower == 0`（仅 `state_num > 0` 时） | 覆盖最低端 |
| C4 | `S{n-1}.upper == VOL_CHn_VOLTAGE_MAX_MV`（仅 `state_num > 0` 时） | 覆盖本通道量程顶端 |
| C5 | `S{i}.upper == S{i+1}.lower` | 无缝隙、无重叠 |
| C6 | `S{i}.lower < S{i}.upper` | 区间非退化 |
| C7 | `hyst_up_{i−1} + hyst_down_{i+1} < (upper_i − lower_i)`，越界项按 0 计 | 状态 i 的可进入区间非空；上行门限不越下一条边界、下行门限不越上一条边界 |
| C8 | `window ∈ [1, VOL_FILTER_WINDOW_MAX]` | 缓冲尺寸 |
| C9 | `RL > 0`、`FS > 0`、`VREF > 0`、`VOL_CH_SCALE_Q16_64(ch) < 2^32`（**强转前**的 64 位值） | 除零与系数截断（见 §4.2） |
| C10 | `S0.hyst_down == 0`、`S{n−1}.hyst_up == 0` | 首末状态外边界无对应状态，强制为 0 防误配 |
| C11 | 配置量闭区间：`1 ≤ VREF ≤ 5000`、`1 ≤ FS ≤ 65535`、`|GAIN_PPM| ≤ 100000`、`|OFFSET_MV| ≤ 1000`、`0 ≤ R_HIGH ≤ VOL_R_MAX_OHM`、`1 ≤ R_LOW ≤ VOL_R_MAX_OHM`、`1 ≤ VOLTAGE_MAX_MV ≤ 65535` | ① 保证 `1e6+GAIN_PPM > 0`，避免负增益转 `uint64` 变成巨值；② 为编译期中间量提供可证明的 `uint64` 上界（见 §4.2）；③ 拦住单位手误（5.1k 写成 5100000） |
| C12 | `state_num == 0` ⇔ `state_cfg == NULL`（由条件编译**构造保证**，**不做**静态断言） | 仅测量通道不持有状态表；状态通道必须持有，防止空指针解引用 |

> **C12 为什么不能做成静态断言**：C99 下 `(const Vol_StateCfgType *)0` 参与的比较**不是整型常量表达式**，负数组长度技巧会退化成变长数组，在文件作用域直接非法——实测 gcc 报 `variably modified 'vol_sa_c12_ch1' at file scope`，断言既不报错也不生效。因此改为**构造性保证**：`state_cfg` 与 `state_num` 由同一个 `VOL_CHn_STATE_NUM` 经条件编译派生，二者同源，不可能不一致。
>
> ```c
> #if VOL_CH1_STATE_NUM > 0
> static const Vol_StateCfgType ch1_states[VOL_CH1_STATE_NUM] = { /* ... */ };
> #define VOL_CH1_STATE_CFG   ch1_states
> #else
> #define VOL_CH1_STATE_CFG   NULL
> #endif
> ```
>
> 运行期还有两道保险：`Vol_Task` 判 `state_num == 0` 跳过、`Vol_GetState` 判 `state_num == 0` 返回 `E_NO_STATE`，即使指针意外为 `NULL` 也不会解引用。

> C3~C7、C10 仅在 `state_num > 0` 时适用，实现上用 `#if VOL_CHn_STATE_NUM > 0` 条件编译包住——RBIN 通道不定义任何 `S<i>` 宏，无条件引用会直接编译失败。

> **C11 为什么必须有**（实测依据）：
> - `GAIN_PPM = -1000000`（-100%）时 `scale_q16 = 0`，C9 判定 `0 < 2^32` **通过**，编译成功但全通道恒输出 0 mV —— 静默失效，最难定位。
> - 电阻超限时 C9 拦不全：遍历 `R_HIGH` 发现 `5.66 MΩ`、`11.3 MΩ` 等多处 `scale_q16` 回落到 `2^32` 以下的点，C9 照样通过，换算结果却错两个数量级。C9 只检查**下游结果**，C11 检查**上游输入**，两者不可互相替代。
> - 现场手误几乎都是"多写三个零"，`R_HIGH ≤ VOL_R_MAX_OHM` 一条就能挡住。

> C7 是唯一与"非对称"相关的约束，形式与应用场景无关：它只要求每个状态能进得去、留得住。首末状态外侧的迟滞不参与判定（C10 强制为 0）。

### 5.4 状态迁移算法（vol_sm，纯函数）

```c
uint8_t Vol_Sm_Next(const Vol_StateCfgType *cfg, uint8_t num,
                    uint8_t cur, Vol_VoltageType v_mv)
{
    uint8_t target = cur;
    uint8_t i;
    int32_t v     = (int32_t)v_mv;
    int32_t up_th;
    int32_t dn_th;

    if (num == 0u) {
        return 0u;                               /* 仅测量通道，无状态 */
    }

    for (i = 0u; i < num; i++) {                 /* 定位标称区间，O(N)，N≤12 */
        if ((v_mv >= cfg[i].lower_mv) && (v_mv < cfg[i].upper_mv)) {
            target = i;
            break;
        }
    }
    if (i == num) {                              /* 越界取端点 */
        target = (v_mv < cfg[0].lower_mv) ? 0u : (uint8_t)(num - 1u);
    }

    if (cur >= num) {
        return target;                           /* 首次定位：cur 为 0xFF，不走迟滞 */
    }

    up_th = (int32_t)cfg[cur].upper_mv + (int32_t)cfg[cur].hyst_up_mv;
    dn_th = (int32_t)cfg[cur].lower_mv - (int32_t)cfg[cur].hyst_down_mv;

    if ((target > cur) && (v >= up_th)) {
        return target;                           /* 上行，可跨多级 */
    }
    if ((target < cur) && (v <= dn_th)) {
        return target;                           /* 下行，可跨多级 */
    }
    return cur;                                  /* 落在不动作带内，保持 */
}
```

设计要点：
- **纯函数**：只依赖入参与配置表，无全局状态 → 可在宿主机穷举测试。
- **上下行独立取阈值**：上行只看 `hyst_up`，下行只看 `hyst_down`，互不影响。
- **int32 中间量**：`lower − hyst_down` 可能为负，用有符号中间量避免无符号回绕。
- **允许越级跳变**：上电或负载突卸时电压可跨多档，避免"每周期只走一档"造成状态滞后。
- **`num == 0` 不进入判定**：`Vol_Task` 对仅测量通道直接跳过；`Vol_Sm_Next` 首行加 `if (num == 0u) return 0u;` 兜底，避免 `cfg[0]` 越界与 `num - 1` 下溢。
- **首次定位不走迟滞**（`cur >= num` 时直接返回标称定位）：`Vol_Init` 后 `state = 0xFF`，窗口刚填满时第一次调用 `cur` 就是 `0xFF`。若不拦截，`cfg[0xFF]` 会越界读（仿真已复现：状态停在 `0xFF` 不再更新）。语义上也应如此——上电后第一次拿到有效电压，应立即落到对应区间，而不是从某个假状态按迟滞"爬"上来。
- **无去抖计数**：需求未要求连续 N 次确认，故不引入（保持最小实现）。

---

## 6. 对外接口设计

### 6.1 接口清单（严格 5 个）

```c
/* 初始化：复位所有通道滤波缓冲与状态；初始化前其他接口返回 E_NOT_INIT */
void Vol_Init(void);

/* 周期任务：逐通道执行状态机判定；建议 5~10 ms 周期调用 */
void Vol_Task(void);

/* 写入某通道的 ADC 采样码值（可在 ADC 中断内高频调用） */
Vol_ReturnType Vol_SetAdcValue(uint8_t ch, Vol_AdcValueType adc);

/* 读取某通道当前电压，单位 mV */
Vol_ReturnType Vol_GetVoltage(uint8_t ch, Vol_VoltageType *v_mv);

/* 读取某通道当前电压状态，0..state_num-1，0xFF = 无效（窗口未满/未初始化） */
Vol_ReturnType Vol_GetState(uint8_t ch, uint8_t *state);
```

### 6.2 返回码

| 码 | 含义 |
|---|---|
| `VOL_OK` | 成功 |
| `VOL_E_NOT_INIT` | 未调用 `Vol_Init` |
| `VOL_E_PARAM` | 通道号越界 / 空指针 |
| `VOL_E_NOT_READY` | 该通道滤波窗口未填满，电压/状态尚无效（仅 Get 类接口） |
| `VOL_E_NO_STATE` | 该通道为仅测量通道（`state_num == 0`），不提供状态（仅 `Vol_GetState`） |

> `VOL_E_NO_STATE` 与 `VOL_E_PARAM` 的区别：前者**配置就是对的**，只是该通道按设计不管状态；后者是配置或调用写错了。上层据此决定"跳过状态判断"还是"修正代码"。

### 6.3 调用时序（典型集成）

```
上电 → Vol_Init()
      ┌──────────────────────────────────────────────┐
      │ ADC 转换完成中断：Vol_SetAdcValue(ch, raw)     │  ← 每采样点
      │ 主循环 / OS Task（5 ms）：Vol_Task()           │  ← 周期
      │ 应用逻辑：Vol_GetVoltage()/Vol_GetState()      │  ← 按需
      └──────────────────────────────────────────────┘
```

### 6.4 采样值接口形态（D1 已确认）

`Vol_SetAdcValue(ch, adc)` **单通道写入**：

- 各通道可独立更新速率，无需上层组装完整数组；
- ADC 中断内调用开销最小（仅一次写入 + 换算 + 入窗）；
- 通道数扩展不改接口。

### 6.5 异常路径的行为约定（D9）

| 场景 | 返回值 | 输出参数 | 说明 |
|---|---|---|---|
| 未调用 `Vol_Init` | `VOL_E_NOT_INIT` | 不写 | `Vol_Task` 返回 void，直接 `return` |
| 通道号 ≥ `VOL_CHANNEL_NUM` | `VOL_E_PARAM` | 不写 | 先判指针，再判通道号 |
| 输出指针为 NULL | `VOL_E_PARAM` | — | 不解引用 |
| 滤波窗口未满 | `VOL_E_NOT_READY` | `*v_mv = 0`、`*state = VOL_STATE_INVALID` | 写安全值 |
| 仅测量通道调 `Vol_GetState` | `VOL_E_NO_STATE` | `*state = VOL_STATE_INVALID` | 该通道无状态管理；电压接口不受影响 |
| ADC 码值 > `ADC_FS` | `VOL_OK` | — | 按满量程处理，换算后由限幅兜住，不报错 |

判定顺序（`Vol_GetState`）：未初始化 → 指针 → 通道号 → **`state_num == 0`** → 窗口未满。先判"无状态"再判"未就绪"，是因为仅测量通道永远不会有有效状态，`E_NO_STATE` 比 `E_NOT_READY` 更准确。

原则：**错误返回时也把输出参数写成确定的安全值**，上层即使忽略返回值也不会读到脏数据。

---

## 7. 并发与上下文假设

- **默认假设**：`Vol_SetAdcValue` 与 `Vol_Task` 在 **同一上下文** 中调用，组件内部不加锁。
- 若采样在 ADC 中断、Task 在主循环（**典型用法**），存在对环形缓冲/运行和/电压值的竞争，需在配置中打开临界区钩子：

```c
#define VOL_CRITICAL_ENTER()   /* 例：__disable_irq() 或 OS 临界区 */
#define VOL_CRITICAL_EXIT()    /* 例：__enable_irq() */
```

组件在 `Vol_SetAdcValue`（写路径）与 `Vol_Task`（读路径）的共享数据段外围调用该钩子。默认定义为空，零开销，也不新增接口。

- **临界区保护范围**：`Vol_SetAdcValue` 内保护"写环形缓冲 + 更新 `sum`/`count`/`v_mv`"整段；`Vol_Task` 内保护"读 `v_mv` + 写 `state`"整段。只对单个字段加锁不够——否则 Task 可能读到"新样本已入缓冲、`sum` 尚未更新"的中间态，算出错误均值。
- **初始化时序**：`Vol_Init` 把 `initialized` 标志放在最后一步置位。在此之前到来的 `Vol_SetAdcValue`（例如 ADC 中断先于初始化启动）一律返回 `VOL_E_NOT_INIT` 并丢弃采样，不会触碰半初始化上下文，因此 `Vol_Init` 本身无需关中断。

---

## 8. 编码规范与平台约束

| 约束 | 说明 |
|---|---|
| 语言标准 | C99（兼容 Keil AC5/AC6、IAR、GCC Arm） |
| 静态断言 | `VOL_STATIC_ASSERT`：编译器支持 C 语言标准的 `_Static_assert`（C11 起）时优先使用，否则用 C99 负数组长度技巧回退。**注意与断言编号 C11 无关** |
| 数据类型 | 只用 `<stdint.h>` 定宽类型；电压 `uint16_t`、ADC `uint16_t`、运行和 `uint32_t`、中间量 `uint32_t/uint64_t/int32_t` |
| 数值处理 | **全程整数定点**（Q16 系数、ppm、Ω、mV），禁止浮点与隐式浮点提升 |
| 动态内存 | 禁止 `malloc/free`；所有缓冲为 `static` 数组 |
| 递归 / 函数指针 | 禁止（栈深度不可控 / 间接调用不可分析） |
| 代码风格 | 参考 MISRA-C:2012 常用子集（单入单出、显式括号、`u` 后缀、`const` 正确性）；**不产出 MISRA 合规报告** |
| 可重入 | 无隐藏全局状态，仅通道上下文数组；单实例（非多实例类） |
| 资源估算 | ROM ≈ 1.5~2 KB；RAM ≈ 每通道 `window×2 + 12` 字节 + 配置表项 24 字节 + 状态表 `8×N` 字节（仅测量通道无状态表） |

---

## 9. 配置示例（12 V 蓄电池监测，2 通道）

> 以下仅为一个**示例**，用来演示非对称迟滞如何填写；库不预设状态数量与门限。

```c
#define VOL_CHANNEL_NUM              2
#define VOL_ADC_SAMPLE_PERIOD_MS     1

/* 通道 0：KL30 常电，分压 30k/5.1k，12 位 ADC，3.3V 参考 */
#define VOL_CH0_ADC_FS               4095
#define VOL_CH0_VREF_MV              3300
#define VOL_CH0_R_HIGH_OHM           30000
#define VOL_CH0_R_LOW_OHM            5100
#define VOL_CH0_GAIN_PPM             500
#define VOL_CH0_OFFSET_MV            (-10)
#define VOL_CH0_FILT_MODE            VOL_FILT_BY_TIME
#define VOL_CH0_FILT_ARG             8            /* 8 ms → 8 个采样点 */
#define VOL_CH0_VOLTAGE_MAX_MV       20000        /* 本通道量程 20 V */

#define VOL_CH0_STATE_NUM            4

/* 状态 0：严重欠压 / 断线   0 ~ 6 V */
#define VOL_CH0_S0_LOWER_MV          0
#define VOL_CH0_S0_UPPER_MV          6000
#define VOL_CH0_S0_HYST_UP_MV        0            /* 首状态，外边界无定义 */
#define VOL_CH0_S0_HYST_DOWN_MV      0            /* 首状态，外边界无定义 */

/* 状态 1：低压   6 ~ 9 V */
#define VOL_CH0_S1_LOWER_MV          6000
#define VOL_CH0_S1_UPPER_MV          9000
#define VOL_CH0_S1_HYST_UP_MV        1000         /* 10.0 V 才进正常 */
#define VOL_CH0_S1_HYST_DOWN_MV      500          /* 5.5 V 才掉回严重欠压 */

/* 状态 2：正常   9 ~ 16 V */
#define VOL_CH0_S2_LOWER_MV          9000
#define VOL_CH0_S2_UPPER_MV          16000
#define VOL_CH0_S2_HYST_UP_MV        500          /* 16.5 V 才进高压 */
#define VOL_CH0_S2_HYST_DOWN_MV      2000         /* 7.0 V 才算低压 */

/* 状态 3：高压   16 ~ 20 V */
#define VOL_CH0_S3_LOWER_MV          16000
#define VOL_CH0_S3_UPPER_MV          20000
#define VOL_CH0_S3_HYST_UP_MV        0            /* 末状态，外边界无定义 */
#define VOL_CH0_S3_HYST_DOWN_MV      500          /* 15.5 V 才回正常 */

/* 通道 1：RBIN 冗余蓄电池采样（24 V 系统），分压 100k/8.2k
 * 只做「换算 + 滤波 + 提供电压」，不管理状态 */
#define VOL_CH1_ADC_FS               4095
#define VOL_CH1_VREF_MV              3300
#define VOL_CH1_R_HIGH_OHM           100000
#define VOL_CH1_R_LOW_OHM            8200
#define VOL_CH1_GAIN_PPM             0
#define VOL_CH1_OFFSET_MV            0
#define VOL_CH1_FILT_MODE            VOL_FILT_BY_SAMPLE
#define VOL_CH1_FILT_ARG             16
#define VOL_CH1_VOLTAGE_MAX_MV       44000        /* 独立量程，不受 CH0 的 20 V 限制 */
#define VOL_CH1_STATE_NUM            0            /* 仅测量：一个 S<i> 宏都不用定义 */
```

该配置产生的门限：`10.0 V`（升入正常）、`7.0 V`（降回低压）、`16.5 V`（升入高压）、`15.5 V`（降回正常），四处迟滞互不相同。C7 校验：状态 1 `0 + 2000 < 3000` ✓、状态 2 `1000 + 500 < 7000` ✓、状态 3 `500 + 0 < 4000` ✓。

两个通道的量程互相独立：CH0 限幅到 20000 mV，CH1 限幅到 44000 mV。C4 只对 CH0 校验 `S3.upper == 20000`；CH1 因 `STATE_NUM == 0` 跳过 C3~C7/C10，但 C12 要求其 `state_cfg == NULL`。

---

## 10. 应用侧集成约束（不是库的功能，但配错会出问题）

| 约束 | 说明 | 后果 |
|---|---|---|
| 迟滞量 > 滤波后的残余纹波 | 滑动均值后的电压仍有 ±几 mV 抖动，迟滞若小于该幅度，状态会在门限附近反复翻转 | 状态跳变、上层误动作 |
| `Vol_Task` 周期 = 状态更新延迟上限 | 状态每 Task 周期才判定一次；5~10 ms 对应 5~10 ms 的最坏响应 | 响应滞后 |
| 采样周期非常数时用 `VOL_FILT_BY_SAMPLE` | TIME 模式按 `VOL_ADC_SAMPLE_PERIOD_MS` 这个常数换算窗口，实际采样率变化会让"窗口时间"失真 | 滤波时间与设计值不符 |
| 上电后前 `window × 采样周期` 内电压无效 | 窗口未满时 Get 返回 `VOL_E_NOT_READY`；window=64、1 ms 采样即 64 ms | 上层需处理上电无效期 |
| 多通道采样率不同时，TIME 模式换算基准取共同值 | 该基准是模块级单一宏 | 个别通道滤波时间偏差 |
| 各通道 `VOLTAGE_MAX_MV` ≥ 实际可能出现的最高电压 | 换算后超过该值的采样被静默限幅，接口上没有任何提示 | 上层读到偏低的电压，可能误判为"电压正常" |
| 仅测量通道不必调用 `Vol_GetState` | 该接口对它返回 `VOL_E_NO_STATE`，忽略返回值也不会出错 | 无（仅为语义清晰） |

---

## 11. 已确认决策记录

| 编号 | 决策点 | 结论 |
|---|---|---|
| D1 | 采样值接口形态 | **单通道** `Vol_SetAdcValue(ch, adc)` |
| D2 | 迟滞语义 | **按状态、上下行独立**：`hyst_up_i` 作用于 `upper_i`，`hyst_down_i` 作用于 `lower_i`（V1.1 修订） |
| D3 | 电压单位/类型 | **`uint16_t` mV**，正电压；全整数定点放大处理，无浮点 |
| D4 | 窗口未满时行为 | 状态 = `0xFF`，Get 返回 `VOL_E_NOT_READY`，不做首样本预填充 |
| D5 | 临界区钩子 | 提供 `VOL_CRITICAL_ENTER/EXIT` 空宏，默认关闭 |
| D6 | 单元测试 | 工程内 `UnitTest/`（断言式回归）+ `Template/`（main 集成示例） |
| D7 | 上限 | 通道 ≤8、状态 ≤**12**（初版定 ≤8，随状态表外置为指针 + 数组后放宽至 12，见 §3.2）、窗口 ≤1024 |
| D8 | 业务假设 | **无**：状态数、边界、门限、迟滞全部由应用配置，库不内置任何电压段定义 |
| D9 | 异常路径输出 | 错误返回时输出参数写安全值（`0` / `0xFF`），不写则为"未定义输出" |
| D10 | 分压电阻上限 | 上、下臂均 **≤ 1 MΩ**（`VOL_R_MAX_OHM`），由 C11 校验；作用是给出编译期中间量的可证明上界，不是业务假设 |
| D11 | 仅测量通道（RBIN） | 用 **`state_num == 0`** 表示，不新增通道类型字段；此类通道只做换算+滤波+提供电压，`state_cfg` 必须为 `NULL`（C12），`Vol_Task` 跳过 |
| D12 | 电压量程 | **通道级** `VOL_CHn_VOLTAGE_MAX_MV`，取消全局 `VOL_VOLTAGE_MAX_MV`。量程是通道属性（取决于分压比与被测对象），单值全局会让高量程 RBIN 通道被静默截断 |
| D13 | 仅测量通道的 GetState | 返回 **`VOL_E_NO_STATE`**，`*state = 0xFF`；与 `VOL_E_PARAM`（调用/配置写错）区分开 |

---

## 12. 修订记录

| 版本 | 日期 | 说明 |
|---|---|---|
| V0.9 | 2026-11-02 | 初稿，待评审 |
| V1.0 | 2026-11-02 | 按 D1~D7 确认结论修订：电压改 `uint16_t` mV、滤波改 mV 域、确认单通道接口、新增 UnitTest/Template 目录 |
| V1.1 | 2026-11-02 | 迟滞拆为 `hyst_up_mv` / `hyst_down_mv` 两个独立字段，支持非对称门限；C7 改为与应用无关的通式并新增 C10；示例改为 4 状态非对称配置；新增 D8（库不含业务假设） |
| V1.2 | 2026-11-02 | 评审后补充实现层澄清：类型归属表（§3.4）、系数截断与 C9 前置断言（§4.2/§3.4/§5.3）、异常路径约定与 D9（§6.5）、临界区保护范围与初始化时序（§7）、应用侧集成约束（§10） |
| V1.3 | 2026-11-02 | 补 C11 配置量闭区间断言、新增 `VOL_R_MAX_OHM`（1 MΩ）与 D10；§4.2 增加中间量 `uint64` 上界证明；§3.3 电阻约束补上界。定点系数宏与算法结构不变 |
| V1.4 | 2026-11-02 | ① 新增仅测量通道（RBIN）：`state_num == 0` 表示不做状态管理，`Vol_Task` 跳过、`Vol_GetState` 返回新码 `VOL_E_NO_STATE`（D11/D13）；② 电压量程改为通道级 `VOL_CHn_VOLTAGE_MAX_MV`，取消全局 `VOL_VOLTAGE_MAX_MV`，C4 相应改为与本通道量程比较（D12），配置结构体新增 `voltage_max_mv` 字段；③ **修复状态机首帧越界**：`cur` 为 `0xFF` 时直接返回标称定位，不再索引 `cfg[0xFF]`；④ C12 改为条件编译构造保证（C99 指针比较非整型常量表达式，无法做静态断言） |
