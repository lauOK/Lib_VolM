/**
 * @file    vol_cfg.h
 * @brief   Lib_VolM 编译期静态配置（由 vol-cfg-tool 生成，请勿手工修改）
 * @note    由 vol-cfg-tool v0.2.0 生成于 2026-11-03（目标库 Lib_VolM V1.4 · 配置格式 volm-cfg/1）
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
#define VOL_CHANNEL_NUM                 2

/** 期望采样周期，单位 ms；仅用于 FILT_BY_TIME 模式的窗口换算，须 >= 1 */
#define VOL_ADC_SAMPLE_PERIOD_MS        10

/** 单通道滤波窗口上限（仅用于断言） */
#define VOL_FILTER_WINDOW_MAX           64

/** 单通道状态数上限（仅用于断言） */
#define VOL_STATE_NUM_MAX               12

/** 通道数上限（仅用于断言） */
#define VOL_CHANNEL_NUM_MAX             8

/**
 * 分压电阻上限，单位 Ω（仅用于断言，不参与运算）。
 * 作用：为 VOL_CH_SCALE_Q16_64 的编译期中间量提供可证明的 uint64 上界（架构 §4.2），
 *      同时拦住"5.1k 写成 5100000"这类量级手误。它不是业务假设。
 */
#define VOL_R_MAX_OHM                   1000000

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
 * 2. 通道级配置（架构 §3.3，示例为 12 V 系统 + 一路 RBIN）
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * 通道 0：KL30 常电，分压 10 kΩ / 2 kΩ，12 位 ADC，5 V 参考，4 个状态
 * ------------------------------------------------------------------------ */
#define VOL_CH0_ADC_FS                  4095        /* 12 位 ADC 满量程码值 */
#define VOL_CH0_VREF_MV                 5000        /* 参考电压 mV */
#define VOL_CH0_R_HIGH_OHM              10000       /* 上臂 10 kΩ，填 10000（单位 Ω） */
#define VOL_CH0_R_LOW_OHM               2000        /* 下臂 2 kΩ，填 2000（单位 Ω） */
#define VOL_CH0_GAIN_PPM                0
#define VOL_CH0_OFFSET_MV               0
#define VOL_CH0_FILT_MODE               VOL_FILT_BY_SAMPLE
#define VOL_CH0_FILT_ARG                10          /* 10 个采样点 */
#define VOL_CH0_VOLTAGE_MAX_MV          20000       /* 本通道量程 20 V（= b4，限幅 + C4） */

#define VOL_CH0_STATE_NUM               4

/* 状态 0：严重欠压 / 断线   0 ~ 6 V */
#define VOL_CH0_S0_LOWER_MV             0
#define VOL_CH0_S0_UPPER_MV             6000
#define VOL_CH0_S0_HYST_UP_MV           0           /* 首状态，外边界无定义 */
#define VOL_CH0_S0_HYST_DOWN_MV         0           /* 首状态，外边界无定义 */

/* 状态 1：低压   6 ~ 9 V */
#define VOL_CH0_S1_LOWER_MV             6000
#define VOL_CH0_S1_UPPER_MV             9000
#define VOL_CH0_S1_HYST_UP_MV           1000        /* 10.0 V 才进正常 */
#define VOL_CH0_S1_HYST_DOWN_MV         500         /* 5.5 V 才掉回严重欠压 */

/* 状态 2：正常   9 ~ 16 V */
#define VOL_CH0_S2_LOWER_MV             9000
#define VOL_CH0_S2_UPPER_MV             16000
#define VOL_CH0_S2_HYST_UP_MV           500         /* 16.5 V 才进高压 */
#define VOL_CH0_S2_HYST_DOWN_MV         2000        /* 7.0 V 才掉回低压 */

/* 状态 3：高压   16 ~ 20 V */
#define VOL_CH0_S3_LOWER_MV             16000
#define VOL_CH0_S3_UPPER_MV             20000
#define VOL_CH0_S3_HYST_UP_MV           0           /* 末状态，外边界无定义 */
#define VOL_CH0_S3_HYST_DOWN_MV         500         /* 15.5 V 才回正常 */

/* --------------------------------------------------------------------------
 * 通道 1：RBIN 冗余蓄电池采样（24 V 系统），分压 100 kΩ / 8.2 kΩ
 * 仅测量通道：只做「换算 + 滤波 + 提供电压」，不管理状态。
 * STATE_NUM = 0 时下列 S<i> 宏一个都不需要定义（架构 D11 / C12）。
 * ------------------------------------------------------------------------ */
#define VOL_CH1_ADC_FS                  4095        /* 12 位 ADC 满量程码值 */
#define VOL_CH1_VREF_MV                 5000        /* 参考电压 mV */
#define VOL_CH1_R_HIGH_OHM              100000      /* 上臂 100 kΩ，填 100000（单位 Ω） */
#define VOL_CH1_R_LOW_OHM               8200        /* 下臂 8.2 kΩ，填 8200（单位 Ω） */
#define VOL_CH1_GAIN_PPM                0
#define VOL_CH1_OFFSET_MV               0
#define VOL_CH1_FILT_MODE               VOL_FILT_BY_SAMPLE
#define VOL_CH1_FILT_ARG                16          /* 16 个采样点 */
#define VOL_CH1_VOLTAGE_MAX_MV          44000       /* 本通道量程 44 V（限幅 + C4） */

#define VOL_CH1_STATE_NUM               0           /* 0 = 仅测量通道（RBIN） */

/* ==========================================================================
 * 3. 派生量（由上面的宏在编译期算出，不要手工修改）
 * ========================================================================== */

/** 窗口换算：TIME 模式按采样周期向上取整为采样次数，至少 1 次（架构 §3.3） */
#define VOL_FILT_WINDOW_CALC(mode, arg)                                       \
    (((mode) == VOL_FILT_BY_TIME)                                             \
        ? ((((arg) + VOL_ADC_SAMPLE_PERIOD_MS - 1u) / VOL_ADC_SAMPLE_PERIOD_MS)) \
        : (arg))

#define VOL_CH0_FILT_WINDOW     VOL_FILT_WINDOW_CALC(VOL_CH0_FILT_MODE, VOL_CH0_FILT_ARG)
#define VOL_CH1_FILT_WINDOW     VOL_FILT_WINDOW_CALC(VOL_CH1_FILT_MODE, VOL_CH1_FILT_ARG)

/**
 * 换算系数（µV/LSB，Q16 定点）。
 * 参数是通道记号 CH0 / CH1（不是数字 0 / 1）。
 *
 * 64 位形式供编译期断言使用：断言必须落在 (uint32_t) 强转之前，
 * 否则截断已发生，断言恒真（架构 §4.2 / C9）。
 */
#define VOL_CH_SCALE_Q16_64(ch)                                               \
    (((((uint64_t)VOL_##ch##_VREF_MV * 1000ULL)                               \
        * ((uint64_t)VOL_##ch##_R_HIGH_OHM + (uint64_t)VOL_##ch##_R_LOW_OHM)  \
        * (uint64_t)(1000000LL + VOL_##ch##_GAIN_PPM))                        \
        / (((uint64_t)VOL_##ch##_ADC_FS * (uint64_t)VOL_##ch##_R_LOW_OHM)     \
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
