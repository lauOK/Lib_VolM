/**
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
#define VOL_ASSERT_CH_COMMON(ch)                                                       \
    VOL_STATIC_ASSERT((VOL_##ch##_STATE_NUM) <= (VOL_STATE_NUM_MAX), c1_##ch);          \
    VOL_STATIC_ASSERT((VOL_##ch##_FILT_WINDOW) >= 1, c8_##ch##_lo);                     \
    VOL_STATIC_ASSERT((VOL_##ch##_FILT_WINDOW) <= (VOL_FILTER_WINDOW_MAX), c8_##ch##_hi); \
    VOL_STATIC_ASSERT(((VOL_##ch##_ADC_FS) >= 1) && ((VOL_##ch##_ADC_FS) <= 65535), c11_##ch##_fs); \
    VOL_STATIC_ASSERT(((VOL_##ch##_VREF_MV) >= 1) && ((VOL_##ch##_VREF_MV) <= 5000), c11_##ch##_vref); \
    VOL_STATIC_ASSERT(((VOL_##ch##_R_HIGH_OHM) >= 0) && ((VOL_##ch##_R_HIGH_OHM) <= (VOL_R_MAX_OHM)), c11_##ch##_rh); \
    VOL_STATIC_ASSERT(((VOL_##ch##_R_LOW_OHM) >= 1) && ((VOL_##ch##_R_LOW_OHM) <= (VOL_R_MAX_OHM)), c11_##ch##_rl); \
    VOL_STATIC_ASSERT(((VOL_##ch##_GAIN_PPM) >= -100000) && ((VOL_##ch##_GAIN_PPM) <= 100000), c11_##ch##_gain); \
    VOL_STATIC_ASSERT(((VOL_##ch##_OFFSET_MV) >= -1000) && ((VOL_##ch##_OFFSET_MV) <= 1000), c11_##ch##_offset); \
    VOL_STATIC_ASSERT(((VOL_##ch##_VOLTAGE_MAX_MV) >= 1) && ((VOL_##ch##_VOLTAGE_MAX_MV) <= 65535), c11_##ch##_vmax); \
    VOL_STATIC_ASSERT(((VOL_##ch##_R_HIGH_OHM) + (VOL_##ch##_R_LOW_OHM)) > 0, c9_##ch##_div); \
    VOL_STATIC_ASSERT(VOL_CH_SCALE_Q16_64(ch) < (1ULL << 32), c9_##ch##_scale);

/* ==========================================================================
 * 通道 0：4 个状态，状态区间 [0,6000) [6000,9000) [9000,16000) [16000,20000)
 * ========================================================================== */
#if (VOL_CHANNEL_NUM > 0)

/** 滤波缓冲：窗口深度由配置宏在编译期算出 */
static Vol_FilterSampleType vol_ch0_buf[VOL_CH0_FILT_WINDOW];

#if (VOL_CH0_STATE_NUM > 0)
static const Vol_StateCfgType vol_ch0_states[VOL_CH0_STATE_NUM] =
{
    { VOL_CH0_S0_LOWER_MV, VOL_CH0_S0_UPPER_MV, VOL_CH0_S0_HYST_UP_MV, VOL_CH0_S0_HYST_DOWN_MV },
    { VOL_CH0_S1_LOWER_MV, VOL_CH0_S1_UPPER_MV, VOL_CH0_S1_HYST_UP_MV, VOL_CH0_S1_HYST_DOWN_MV },
    { VOL_CH0_S2_LOWER_MV, VOL_CH0_S2_UPPER_MV, VOL_CH0_S2_HYST_UP_MV, VOL_CH0_S2_HYST_DOWN_MV },
    { VOL_CH0_S3_LOWER_MV, VOL_CH0_S3_UPPER_MV, VOL_CH0_S3_HYST_UP_MV, VOL_CH0_S3_HYST_DOWN_MV }
};
#define VOL_CH0_STATE_CFG   vol_ch0_states
#else
#define VOL_CH0_STATE_CFG   NULL
#endif

VOL_ASSERT_CH_COMMON(CH0)

#if (VOL_CH0_STATE_NUM > 0)
/* C3 / C4：覆盖本通道量程的上下两端 */
VOL_STATIC_ASSERT((VOL_CH0_S0_LOWER_MV) == 0, c3_CH0_first_lower);
VOL_STATIC_ASSERT((VOL_CH0_S3_UPPER_MV) == (VOL_CH0_VOLTAGE_MAX_MV), c4_CH0_last_upper);

/* C5：相邻状态无缝隙、无重叠 */
VOL_STATIC_ASSERT((VOL_CH0_S0_UPPER_MV) == (VOL_CH0_S1_LOWER_MV), c5_CH0_0);
VOL_STATIC_ASSERT((VOL_CH0_S1_UPPER_MV) == (VOL_CH0_S2_LOWER_MV), c5_CH0_1);
VOL_STATIC_ASSERT((VOL_CH0_S2_UPPER_MV) == (VOL_CH0_S3_LOWER_MV), c5_CH0_2);

/* C6：区间非退化 */
VOL_STATIC_ASSERT((VOL_CH0_S0_LOWER_MV) < (VOL_CH0_S0_UPPER_MV), c6_CH0_0);
VOL_STATIC_ASSERT((VOL_CH0_S1_LOWER_MV) < (VOL_CH0_S1_UPPER_MV), c6_CH0_1);
VOL_STATIC_ASSERT((VOL_CH0_S2_LOWER_MV) < (VOL_CH0_S2_UPPER_MV), c6_CH0_2);
VOL_STATIC_ASSERT((VOL_CH0_S3_LOWER_MV) < (VOL_CH0_S3_UPPER_MV), c6_CH0_3);

/* C7：hyst_up_{i-1} + hyst_down_{i+1} < (upper_i - lower_i)，越界项按 0 计 */
VOL_STATIC_ASSERT(((0 + VOL_CH0_S1_HYST_DOWN_MV) < ((VOL_CH0_S0_UPPER_MV) - (VOL_CH0_S0_LOWER_MV))), c7_CH0_0);
VOL_STATIC_ASSERT(((VOL_CH0_S0_HYST_UP_MV + VOL_CH0_S2_HYST_DOWN_MV) < ((VOL_CH0_S1_UPPER_MV) - (VOL_CH0_S1_LOWER_MV))), c7_CH0_1);
VOL_STATIC_ASSERT(((VOL_CH0_S1_HYST_UP_MV + VOL_CH0_S3_HYST_DOWN_MV) < ((VOL_CH0_S2_UPPER_MV) - (VOL_CH0_S2_LOWER_MV))), c7_CH0_2);
VOL_STATIC_ASSERT(((VOL_CH0_S2_HYST_UP_MV + 0) < ((VOL_CH0_S3_UPPER_MV) - (VOL_CH0_S3_LOWER_MV))), c7_CH0_3);

/* C10：首末状态的外侧边界没有对应状态，迟滞必须为 0 */
VOL_STATIC_ASSERT((VOL_CH0_S0_HYST_DOWN_MV) == 0, c10_CH0_first_down);
VOL_STATIC_ASSERT((VOL_CH0_S3_HYST_UP_MV) == 0, c10_CH0_last_up);
#endif /* VOL_CH0_STATE_NUM > 0 */

#endif /* VOL_CHANNEL_NUM > 0 */

/* ==========================================================================
 * 通道 1：仅测量通道（RBIN），STATE_NUM = 0
 * 不定义任何 VOL_CH1_S<i>_* 宏，状态表与状态断言整体被条件编译跳过。
 * ========================================================================== */
#if (VOL_CHANNEL_NUM > 1)

static Vol_FilterSampleType vol_ch1_buf[VOL_CH1_FILT_WINDOW];

#if (VOL_CH1_STATE_NUM > 0)
/* 本示例把 CH1 配置为仅测量通道。若要启用状态管理，必须在本文件内补齐三件事：
 *   1) 在 inc/vol_cfg.h 定义 VOL_CH1_S<i>_LOWER/UPPER/HYST_UP/HYST_DOWN_MV；
 *   2) 用与通道 0 相同的形式写出 vol_ch1_states[] 的全部表项；
 *   3) 参照通道 0 增加 C3~C7/C10 断言。
 * 补齐之前保持 #error，避免出现"表项数量不足、剩余状态被零填充"这种能编译通过、
 * 但区间退化成 [0,0) 的错误配置。 */
#error "VOL_CH1_STATE_NUM > 0，但 CH1 的状态表尚未实现；请按本文件上方注释补齐后再删除本行"
#else
#define VOL_CH1_STATE_CFG   NULL
#endif

VOL_ASSERT_CH_COMMON(CH1)

#endif /* VOL_CHANNEL_NUM > 1 */

/* 新增通道时，上面必须有对应的缓冲/状态表块，下面必须有对应的表项。
 * 表项数量少于 VOL_CHANNEL_NUM 时，C 语言会把剩余元素零初始化（filt_buf = NULL），
 * 运行到 Vol_Init 才暴露。故在此显式拦住，强制先补齐代码。 */
#if (VOL_CHANNEL_NUM > 2)
#error "VOL_CHANNEL_NUM > 2：请先在 src/vol_cfg.c 为通道 2 及之后补缓冲、状态表与表项，再删除本行"
#endif

/* ==========================================================================
 * 通道配置表
 * state_num 与 state_cfg 由同一个 VOL_CHn_STATE_NUM 经条件编译派生（C12 构造保证），
 * 因此二者不可能不一致，无需也不应手写 state_cfg。
 * ========================================================================== */
const Vol_ChannelCfgType Vol_ChannelCfgTable[VOL_CHANNEL_NUM] =
{
#if (VOL_CHANNEL_NUM > 0)
    {
        VOL_CH_SCALE_Q16(CH0),              /* scale_q16 */
        VOL_CH_OFFSET_UV(CH0),              /* offset_uv */
        (uint16_t)VOL_CH0_VOLTAGE_MAX_MV,   /* voltage_max_mv */
        (uint16_t)VOL_CH0_FILT_WINDOW,      /* window */
        (uint8_t)VOL_CH0_STATE_NUM,         /* state_num */
        VOL_CH0_STATE_CFG,                  /* state_cfg */
        vol_ch0_buf                         /* filt_buf */
    },
#endif
#if (VOL_CHANNEL_NUM > 1)
    {
        VOL_CH_SCALE_Q16(CH1),
        VOL_CH_OFFSET_UV(CH1),
        (uint16_t)VOL_CH1_VOLTAGE_MAX_MV,
        (uint16_t)VOL_CH1_FILT_WINDOW,
        (uint8_t)VOL_CH1_STATE_NUM,
        VOL_CH1_STATE_CFG,
        vol_ch1_buf
    }
#endif
};
