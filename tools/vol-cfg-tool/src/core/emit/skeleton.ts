/**
 * @file    skeleton.ts
 * @brief   vol_cfg.h / vol_cfg.c 的固定骨架文本（自动生成，勿手改）
 *
 * 由 scripts/gen-skeleton.mjs 从库当前参考文件切片而来：
 *   参考：..\..\inc\vol_cfg.h / vol_cfg.c
 * 重新生成：node scripts/gen-skeleton.mjs
 */

export const H_SEG_A = `/**
 * @file    vol_cfg.h
 * @brief   Lib_VolM 编译期静态配置（由 vol-cfg-tool 生成，请勿手工修改）
 *
 * 设计约定（架构 §3）：
 *   - 所有参数都是宏，运行时没有任何配置接口；
 *   - 合法性由 src/vol_cfg.c 中的编译期断言保证，配错直接编译失败；
 *   - 全部为整数：电压 mV、电阻 Ω（注意：不是 kΩ）、增益 ppm、时间 ms。
 *
 * 本文件由 vol-cfg-tool 依据 vol_cfg.yaml 生成：改配置请回工具里改后重新生成，
 * 手工修改会在下次生成时被覆盖。
 */
#ifndef VOL_CFG_H
#define VOL_CFG_H

#include "vol_types.h"

/* ==========================================================================
 * 0. 编译期断言宏（架构 §8）
 *    优先使用 C11 的 _Static_assert；C99 回退为"负数组长度"技巧。
 *    两条路径都是纯编译期机制：不分配存储、不生成代码、零运行开销。
 *    注意：本宏与断言编号 C11 无关。
 * ========================================================================== */
#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
#define VOL_STATIC_ASSERT(cond, tag)    _Static_assert((cond), #tag)
#else
#define VOL_STATIC_ASSERT(cond, tag)    typedef char vol_sa_##tag[((cond) ? 1 : -1)]
#endif

/* ==========================================================================
 * 1. 模块级配置（架构 §3.2）
 * ========================================================================== */

/** 通道实例数，1 .. VOL_CHANNEL_NUM_MAX */
`;

export const H_SEG_B = `
/** 期望采样周期，单位 ms；仅用于 FILT_BY_TIME 模式的窗口换算，须 >= 1 */
`;

export const H_SEG_C = `
/** 单通道滤波窗口上限（仅用于断言） */
`;

export const H_SEG_D = `
/** 单通道状态数上限（仅用于断言） */
`;

export const H_SEG_E = `
/** 通道数上限（仅用于断言） */
`;

export const H_SEG_F = `
/**
 * 分压电阻上限，单位 Ω（仅用于断言，不参与运算）。
 * 作用：为 VOL_CH_SCALE_Q16_64 的编译期中间量提供可证明的 uint64 上界（架构 §4.2），
 *      同时拦住"5.1k 写成 5100000"这类量级手误。它不是业务假设。
 */
`;

export const H_SEG_G = `
/**
 * 临界区钩子（架构 §7）。
 * 默认空实现：适用于 Vol_SetAdcValue 与 Vol_Task 在同一上下文调用的场景。
 * 若采样在 ADC 中断、Task 在主循环，由应用在工程配置中覆盖这两个宏，例如：
 *     #define VOL_CRITICAL_ENTER()   __disable_irq()
 *     #define VOL_CRITICAL_EXIT()    __enable_irq()
 */
#ifndef VOL_CRITICAL_ENTER
#define VOL_CRITICAL_ENTER()            do { } while (0)
#endif
#ifndef VOL_CRITICAL_EXIT
#define VOL_CRITICAL_EXIT()             do { } while (0)
#endif

/** 滤波配置模式 */
#define VOL_FILT_BY_SAMPLE              0   /**< FILT_ARG = 采样次数 */
#define VOL_FILT_BY_TIME                1   /**< FILT_ARG = 滤波时间(ms) */

/* ==========================================================================
`;

export const H_SEG_H = ` * ========================================================================== */

`;

export const H_TAIL_A = `/* ==========================================================================
 * 3. 派生量（由上面的宏在编译期算出，不要手工修改）
 * ========================================================================== */

/** 窗口换算：TIME 模式按采样周期向上取整为采样次数，至少 1 次（架构 §3.3） */
#define VOL_FILT_WINDOW_CALC(mode, arg)                                       \\
    (((mode) == VOL_FILT_BY_TIME)                                             \\
        ? ((((arg) + VOL_ADC_SAMPLE_PERIOD_MS - 1u) / VOL_ADC_SAMPLE_PERIOD_MS)) \\
        : (arg))

`;

export const H_TAIL_B = `
/**
 * 换算系数（µV/LSB，Q16 定点）。
 * 参数是通道记号 CH0 / CH1（不是数字 0 / 1）。
 *
 * 64 位形式供编译期断言使用：断言必须落在 (uint32_t) 强转之前，
 * 否则截断已发生，断言恒真（架构 §4.2 / C9）。
 */
#define VOL_CH_SCALE_Q16_64(ch)                                               \\
    (((((uint64_t)VOL_##ch##_VREF_MV * 1000ULL)                               \\
        * ((uint64_t)VOL_##ch##_R_HIGH_OHM + (uint64_t)VOL_##ch##_R_LOW_OHM)  \\
        * (uint64_t)(1000000LL + VOL_##ch##_GAIN_PPM))                        \\
        / (((uint64_t)VOL_##ch##_ADC_FS * (uint64_t)VOL_##ch##_R_LOW_OHM)     \\
        * 1000000ULL)) * 65536ULL)

/** 32 位形式：仅用于写入配置表；截断风险由 C9 在强转前拦截 */
#define VOL_CH_SCALE_Q16(ch)    ((uint32_t)VOL_CH_SCALE_Q16_64(ch))

/** 偏置标定量，µV（mV × 1000，编译期完成） */
#define VOL_CH_OFFSET_UV(ch)    ((int32_t)(VOL_##ch##_OFFSET_MV) * 1000)

/* ==========================================================================
 * 4. 配置表类型（架构 §3.4）
 *    应用要直接书写配置表，故这两个类型必须对外可见。
 * ========================================================================== */

/** 单个电压状态的定义 */
typedef struct
{
    Vol_VoltageType lower_mv;       /**< 状态下限（含） */
    Vol_VoltageType upper_mv;       /**< 状态上限（不含） */
    Vol_VoltageType hyst_up_mv;     /**< 离开本状态向上：门限 = upper + hyst_up */
    Vol_VoltageType hyst_down_mv;   /**< 离开本状态向下：门限 = lower - hyst_down */
} Vol_StateCfgType;

/** 单个通道的编译期配置 */
typedef struct
{
    uint32_t scale_q16;             /**< 编译期算好的 µV/LSB，Q16 定点 */
    int32_t  offset_uv;             /**< 编译期算好的偏置 µV */
    uint16_t voltage_max_mv;        /**< 本通道量程上限（通道级，非全局） */
    uint16_t window;                /**< 滤波窗口深度（采样次数） */
    uint8_t  state_num;             /**< 状态数；0 = 仅测量通道（RBIN） */
    const Vol_StateCfgType *state_cfg;  /**< state_num == 0 时为 NULL（C12） */
    Vol_FilterSampleType   *filt_buf;   /**< 指向 static 缓冲，Vol_Init 时装载 */
} Vol_ChannelCfgType;

/** 通道配置表，定义于 src/vol_cfg.c */
extern const Vol_ChannelCfgType Vol_ChannelCfgTable[VOL_CHANNEL_NUM];

#endif /* VOL_CFG_H */
`;

export const C_PRE = `/**
 * @file    vol_cfg.c
 * @brief   编译期配置落地：滤波缓冲、状态阈值表、通道配置表、全部编译期断言
 *
 * 断言编号与架构 §5.3 一一对应，报错信息中的 tag 可直接定位到规则：
 *   c1_*   状态数容量            c6_*   区间非退化
 *   c3_*   覆盖最低端            c7_*   迟滞不越界（可进入、可保持）
 *   c4_*   覆盖本通道量程顶端    c8_*   滤波窗口范围
 *   c5_*   区间无缝衔接          c9_*   除零与系数截断
 *   c10_*  首末状态外侧迟滞为 0  c11_*  配置量闭区间
 * C12（state_num == 0 ⇔ state_cfg == NULL）由条件编译构造保证，不做静态断言。
 *
 * 注意：断言只能对着"宏"写，不能对着 const 表项写——C99 下数组长度必须是
 *       整型常量表达式，而结构体成员不是。
 */
#include <stddef.h>

#include "vol_cfg.h"

/* ==========================================================================
 * 模块级容量断言（架构 §3.2）
 * ========================================================================== */
VOL_STATIC_ASSERT((VOL_CHANNEL_NUM) >= 1, m_channel_num_lo);
VOL_STATIC_ASSERT((VOL_CHANNEL_NUM) <= (VOL_CHANNEL_NUM_MAX), m_channel_num_hi);
VOL_STATIC_ASSERT((VOL_ADC_SAMPLE_PERIOD_MS) >= 1, m_sample_period);
VOL_STATIC_ASSERT(((VOL_FILTER_WINDOW_MAX) >= 1) && ((VOL_FILTER_WINDOW_MAX) <= 1024), m_window_max);
VOL_STATIC_ASSERT(((VOL_STATE_NUM_MAX) >= 1) && ((VOL_STATE_NUM_MAX) <= 12), m_state_num_max);
VOL_STATIC_ASSERT((VOL_R_MAX_OHM) >= 1, m_r_max);

/* ==========================================================================
 * 通道通用断言（C8 / C9 / C11 + C1 容量）
 * 参数为通道记号 CH0 / CH1 ...，宏内通过 ## 拼接出实际宏名。
 * 用法：VOL_ASSERT_CH_COMMON(CH0)   —— 宏体自带分号，调用处不要再加分号。
 * ========================================================================== */
#define VOL_ASSERT_CH_COMMON(ch)                                                       \\
    VOL_STATIC_ASSERT((VOL_##ch##_STATE_NUM) <= (VOL_STATE_NUM_MAX), c1_##ch);          \\
    VOL_STATIC_ASSERT((VOL_##ch##_FILT_WINDOW) >= 1, c8_##ch##_lo);                     \\
    VOL_STATIC_ASSERT((VOL_##ch##_FILT_WINDOW) <= (VOL_FILTER_WINDOW_MAX), c8_##ch##_hi); \\
    VOL_STATIC_ASSERT(((VOL_##ch##_ADC_FS) >= 1) && ((VOL_##ch##_ADC_FS) <= 65535), c11_##ch##_fs); \\
    VOL_STATIC_ASSERT(((VOL_##ch##_VREF_MV) >= 1) && ((VOL_##ch##_VREF_MV) <= 5000), c11_##ch##_vref); \\
    VOL_STATIC_ASSERT(((VOL_##ch##_R_HIGH_OHM) >= 0) && ((VOL_##ch##_R_HIGH_OHM) <= (VOL_R_MAX_OHM)), c11_##ch##_rh); \\
    VOL_STATIC_ASSERT(((VOL_##ch##_R_LOW_OHM) >= 1) && ((VOL_##ch##_R_LOW_OHM) <= (VOL_R_MAX_OHM)), c11_##ch##_rl); \\
    VOL_STATIC_ASSERT(((VOL_##ch##_GAIN_PPM) >= -100000) && ((VOL_##ch##_GAIN_PPM) <= 100000), c11_##ch##_gain); \\
    VOL_STATIC_ASSERT(((VOL_##ch##_OFFSET_MV) >= -1000) && ((VOL_##ch##_OFFSET_MV) <= 1000), c11_##ch##_offset); \\
    VOL_STATIC_ASSERT(((VOL_##ch##_VOLTAGE_MAX_MV) >= 1) && ((VOL_##ch##_VOLTAGE_MAX_MV) <= 65535), c11_##ch##_vmax); \\
    VOL_STATIC_ASSERT(((VOL_##ch##_R_HIGH_OHM) + (VOL_##ch##_R_LOW_OHM)) > 0, c9_##ch##_div); \\
    VOL_STATIC_ASSERT(VOL_CH_SCALE_Q16_64(ch) < (1ULL << 32), c9_##ch##_scale);
`;

export const C_TABLE_PRE = `/* ==========================================================================
 * 通道配置表
 * state_num 与 state_cfg 由同一个 VOL_CHn_STATE_NUM 经条件编译派生（C12 构造保证），
 * 因此二者不可能不一致，无需也不应手写 state_cfg。
 * ========================================================================== */
const Vol_ChannelCfgType Vol_ChannelCfgTable[VOL_CHANNEL_NUM] =
{
`;
