# Lib_VolM — 汽车 ECU 电压管理组件

面向 32 位 ARM MCU（C99，无浮点、无动态内存、无运行时配置接口）的通用电压管理库。可实例化 1~8 个电压管理通道，每个通道对应一路 ADC：对传入的采样码值做**真实电压换算**与**滑动均值滤波**，并按**编译期配置的电压状态表（上下行独立迟滞）**进行状态切换。

| 特性 | 说明 |
|---|---|
| 全整数定点 | 换算系数在**编译期**合成 Q16 定点值，运行时每样本仅 1 次 64 位乘（Cortex-M 单条 `UMULL`）+ 移位 + 加法；无浮点、无除法库调用 |
| 编译期配置校验 | 全部配置为宏，30+ 条静态断言（C1~C11）——分压比、迟滞、量程等配错**直接编译失败**，报错指向规则编号 |
| 非对称迟滞 | 每个状态的**上行 / 下行迟滞独立配置**，四个门限互不约束 |
| 仅测量通道 | `STATE_NUM = 0` 即 RBIN 类通道：只换算 + 滤波 + 提供电压，不管状态 |
| 通道级量程 | 每通道独立量程上限，RBIN 测 24 V 电池不会被低压通道的 20 V 截断 |
| 中断安全 | 采样可在 ADC 中断高频调用；跨上下文竞争由临界区宏保护（默认空宏） |

---

## 1. 目录结构

```
Lib_VolM/
├─ inc/
│  ├─ vol_types.h     基础类型与返回码（对外可见）
│  ├─ vol_cfg.h       编译期配置 —— 集成时唯一需要修改的文件
│  └─ vol.h           对外接口（严格 5 个）
├─ src/
│  ├─ vol_cfg.c/.h    配置落地：缓冲、状态表、配置表、全部编译期断言
│  ├─ vol_calc.c/.h   ADC 码值 → mV 定点换算
│  ├─ vol_filt.c/.h   mV 域滑动均值滤波（环形缓冲 + 运行和，O(1)/样本）
│  ├─ vol_sm.c/.h     电压状态机（纯函数，上下行独立迟滞）
│  ├─ vol_priv.h      运行期上下文（应用不可见）
│  └─ vol.c           对外接口实现 / 通道调度
├─ Template/main.c    可独立编译运行的双通道演示（含 RBIN 通道）
├─ UnitTest/          宿主机回归用例 + build.sh（不进入 MCU 构建）
├─ tools/vol-cfg-tool/  配置生成工具（网页单文件，见其 README；samples/ 为示例三件套）
└─ doc/VolM_Architecture.md  架构基线（V1.4）
```

---

## 2. 对外接口（严格 5 个）

```c
void            Vol_Init(void);
void            Vol_Task(void);
Vol_ReturnType  Vol_SetAdcValue(uint8_t ch, Vol_AdcValueType adc);
Vol_ReturnType  Vol_GetVoltage(uint8_t ch, Vol_VoltageType *v_mv);
Vol_ReturnType  Vol_GetState(uint8_t ch, uint8_t *state);
```

| 接口 | 调用上下文 | 行为 |
|---|---|---|
| `Vol_Init` | 上电一次 | 复位全部通道（缓冲清零、电压/状态复位）；**可重入，重初始化前须先停采样源** |
| `Vol_Task` | 主循环 / OS 任务，5~10 ms 周期 | 逐通道跑状态机；仅测量通道跳过；未初始化直接返回 |
| `Vol_SetAdcValue` | ADC 采样中断，每采样点一次 | 换算 + 入窗 + 更新电压；可在各通道以不同速率调用 |
| `Vol_GetVoltage` | 应用按需 | 返回滤波后电压（mV）；窗口未满 → `E_NOT_READY` 且 `*v_mv = 0` |
| `Vol_GetState` | 应用按需 | 返回状态号；判定顺序：未初始化 → 指针 → 通道号 → **无状态** → 窗口未满 |

**返回码**：`VOL_OK` / `VOL_E_NOT_INIT`（未初始化）/ `VOL_E_PARAM`（通道越界或空指针，不写输出）/ `VOL_E_NOT_READY`（窗口未满，输出写安全值）/ `VOL_E_NO_STATE`（该通道 `STATE_NUM = 0`，`*state = 0xFF`）。

**两个已文档化的瞬态语义**：

1. **窗口刚满、首个 `Vol_Task` 之前**：`Vol_GetState` 返回 `VOL_OK` 且 `*state = 0xFF`（`VOL_STATE_INVALID` 自描述"尚无有效状态"），一个 Task 周期后消失。应用判断状态时按 `!= VOL_STATE_INVALID` 处理。
2. **迟滞保持**：电压掉进相邻状态区间但未破当前状态的迟滞门限时，状态**保持不变**（例：S2 正常区电压掉到 8000 mV，因下行门限 7000 未破，状态仍是 S2）。这是特性不是 bug。

---

## 3. 集成步骤（5 分钟版）

1. 把 `inc/`、`src/` 加入工程（C99，建议 `-Wall -Wextra -Werror`）。
2. 在 `inc/vol_cfg.h` 按注释填写模块级与通道级宏（见 §4）。
3. 若 `Vol_SetAdcValue` 在 ADC 中断、`Vol_Task` 在主循环（典型用法），在工程配置中覆盖临界区宏：
   ```c
   #define VOL_CRITICAL_ENTER()   __disable_irq()   /* 或 OS 临界区 */
   #define VOL_CRITICAL_EXIT()    __enable_irq()
   ```
   同一上下文调用则保持默认空宏（零开销）。
4. 上电调 `Vol_Init()`；ADC 完成中断里调 `Vol_SetAdcValue(ch, raw)`；主循环周期调 `Vol_Task()`。
5. 编译。**若配置有误，编译期断言会直接报错**，错误信息中的 tag（如 `c7_CH0_2`）对应架构文档 §5.3 的规则编号。

---

## 4. 配置项全表（`inc/vol_cfg.h`）

### 4.1 模块级

| 宏 | 示例值 | 说明 |
|---|---|---|
| `VOL_CHANNEL_NUM` | 2 | 通道实例数（1~8） |
| `VOL_ADC_SAMPLE_PERIOD_MS` | 1 | 采样周期 ms，仅用于 TIME 滤波模式换算窗口 |
| `VOL_FILTER_WINDOW_MAX` | 64 | 单通道窗口上限（≤1024，仅用于断言） |
| `VOL_STATE_NUM_MAX` / `VOL_CHANNEL_NUM_MAX` | 12 / 8 | 容量上限（仅用于断言） |
| `VOL_R_MAX_OHM` | 1000000 | 分压电阻上限 Ω（仅用于断言；拦住量级手误 + 保证中间量上界证明成立） |
| `VOL_CRITICAL_ENTER/EXIT()` | 空 | 临界区钩子，见集成步骤 3 |

### 4.2 通道级（每通道一组 `VOL_CHn_*`，n = 0,1,...）

| 宏 | 单位 | 说明 |
|---|---|---|
| `_ADC_FS` | 码值 | ADC 满量程码值（12 位填 4095，16 位填 65535） |
| `_VREF_MV` | mV | ADC 参考电压 |
| `_R_HIGH_OHM` / `_R_LOW_OHM` | **Ω**（不是 kΩ！） | 分压上/下臂阻值。5.1 kΩ 填 `5100` |
| `_GAIN_PPM` | ppm | 增益标定残差（修正量，实测偏低为正）。±100000 内 |
| `_OFFSET_MV` | mV | 偏置标定残差（固定偏移）。±1000 内 |
| `_FILT_MODE` / `_FILT_ARG` | — | `VOL_FILT_BY_SAMPLE`：按采样次数；`VOL_FILT_BY_TIME`：按滤波时间 ms（自动按采样周期换算为次数） |
| `_VOLTAGE_MAX_MV` | mV | **本通道量程上限**：既是输出限幅值，也是状态表末项 `S{n-1}.upper` 必须等于的值（C4）。选值原则：≥ 被测电压实际最大值 × 1.1 余量；不必等于其他通道 |
| `_STATE_NUM` | — | 状态数；**0 = 仅测量通道**（见 4.4） |

### 4.3 状态宏与迟滞语义（`STATE_NUM > 0` 时）

每状态 4 个宏：`VOL_CHn_S<i>_LOWER_MV` / `_UPPER_MV` / `_HYST_UP_MV` / `_HYST_DOWN_MV`。

**上下行独立的门限规则**（这是本库最容易误读的一点）：

```
上行门限 = 本状态 UPPER + 本状态 HYST_UP      （从本状态向上离开）
下行门限 = 本状态 LOWER − 本状态 HYST_DOWN    （从本状态向下离开）
```

| 想实现 | 填哪里 |
|---|---|
| 电压升到 16.5 V 才判高压（S2 → S3） | `S2_HYST_UP = 500`（16 V 边界 + 0.5 V） |
| 电压降到 7.0 V 才判低压（S2 → S1） | `S2_HYST_DOWN = 2000`（9 V 下边界 − 2 V） |
| 电压升到 10.0 V 才回正常（S1 → S2） | `S1_HYST_UP = 1000`（9 V 上边界 + 1 V） |
| 电压降到 15.5 V 才出高压（S3 → S2） | `S3_HYST_DOWN = 500`（16 V 下边界 − 0.5 V） |

即：**一条边界的上行门限由低侧状态的 `HYST_UP` 决定，下行门限由高侧状态的 `HYST_DOWN` 决定，二者互不相干**。同一状态的两个迟滞可以完全不同（非对称）。

状态区间要求（由断言强制）：按电压升序、`S0.lower = 0`、末项 `upper` = 本通道量程、相邻区间无缝、每状态的"两侧门限之和 < 区间宽度"（C7，保证可进入也可保持）、首末状态外侧迟滞为 0（C10）。

### 4.4 仅测量通道（RBIN）

`VOL_CHn_STATE_NUM` 填 `0` 即可：

- 不需要定义任何 `S<i>_*` 宏，状态表自动为 NULL（条件编译派生，不可能不一致）；
- `Vol_Task` 跳过该通道；`Vol_GetState` 恒返回 `VOL_E_NO_STATE`；
- 电压换算、滤波、`Vol_GetVoltage` 全部正常工作，量程独立（示例 CH1 为 44000 mV）。

---

## 5. 新增一个通道的完整步骤

1. `inc/vol_cfg.h`：复制一组 `VOL_CHn_*` 宏（含分压、标定、滤波、量程；有状态管理则含全部 `S<i>` 宏），n 顺延。
2. `src/vol_cfg.c`：新增一块通道代码——`static Vol_FilterSampleType vol_chn_buf[VOL_CHn_FILT_WINDOW];`、状态表（若有）、`VOL_ASSERT_CH_COMMON(CHn)` 与 C3~C7/C10 断言（照抄通道 0 改记号）、配置表加一条表项。
3. `VOL_CHANNEL_NUM` 加 1。
4. 编译。漏掉任何一步（缓冲、表项、状态宏）都会被 `#error` 或静态断言拦住，不会带病通过。
5. 应用代码里对通道 n 调 `Vol_SetAdcValue(n, raw)`，按需 Get。

---

## 6. 资源占用（实测，gcc -O2，宿主机验证零外部符号）

| 模块 | text | 说明 |
|---|---|---|
| vol_calc.o | 160 B | 1 次 64 位乘 + 移位 + 限幅 + 一次 `/1000`（编译期折叠为乘加） |
| vol_filt.o | 304 B | 每样本 1 减 1 加 1 除；除数为运行期变量（M3/M4 硬件除法，M0 走 `__aeabi_divmod`） |
| vol_sm.o | 264 B | 纯函数，区间定位 O(N)，N ≤ 12 |
| vol.o | 900 B | 接口层 + 调度 |
| vol_cfg.o | data = 配置表 + 状态表 | 静态数据 |

**RAM**：每通道 `window × 2 B`（滤波缓冲）+ 约 12 B（上下文）+ 12 B（配置表项）+ 状态表 `8 B × 状态数`（每状态 4 个 `uint16`）。示例 2 通道合计约 80 B。

---

## 7. 应用侧集成约束（配错会出问题，库不负责）

1. **迟滞应大于滤波后残余纹波**，否则状态会在门限附近抖动。
2. **`Vol_Task` 调用周期即状态响应上限**；滤波窗口 × 采样周期决定电压值的建立时间，上电后该时间内读数无效（`E_NOT_READY`）。
3. **采样周期非常数时用 `FILT_BY_SAMPLE` 模式**，TIME 模式的前提是固定周期采样。
4. **多通道采样率不同时**，TIME 模式换算基准取共同周期；各通道窗口独立，互不影响。
5. **通道量程必须覆盖实际最高电压**（含瞬态超调），输出会被限幅在 `_VOLTAGE_MAX_MV` 且无错误提示。
6. **运行中重初始化（不掉电）前必须先停采样源**，否则 `Vol_Init` 与采样路径存在竞争。
7. **RBIN 通道不必调 `Vol_GetState`**；调了也只得到 `E_NO_STATE`。

## 8. 已知约束

- `scale_q16` 由编译期"先整除后乘 65536"生成，系数恒为 65536 的整数倍，最大偏低 1 µV/LSB（示例配置满量程约 4 mV / 180 ppm）。相对电阻容差可忽略；如需消除可把系数宏改为四舍五入形式，但会改变标定向量。
- 温度漂移不做补偿（属硬件选型问题）；`GAIN_PPM`/`OFFSET_MV` 只修系统误差，随机噪声交给滤波。
- 负偏置在 0 码值处换算为负 µV，已在换算内部限幅到 0 mV，对外不会输出负电压。
- 滤波均值向下取整（截断），稳态恒输入时输出可能比输入低最多 (window-1)/window mV。

## 9. 验证与回归

```bash
bash UnitTest/build.sh     # C99 + C11 双路径编译，全部用例一次跑通
```

覆盖：配置自检（P0）、换算全量程扫描与浮点参考比对（P1）、滤波与朴素实现逐点比对（P2）、状态机门限逐点 + 20000 组随机比对（P3）、接口集成与并发压力（P4）。配置负向验收共 12 项——每一类配错都会编译失败且指向规则编号。

演示：`gcc -std=c99 -Iinc -Isrc Template/main.c src/vol_cfg.c src/vol_calc.c src/vol_filt.c src/vol_sm.c src/vol.c -o vol_demo && ./vol_demo`

## 10. 未验证项

- Keil AC5/AC6、IAR 上负数组长度断言的诊断等级（宿主机无 ARM 工具链）。集成时请把任一状态宏改错编译一次，确认是 **error** 而非 warning。
