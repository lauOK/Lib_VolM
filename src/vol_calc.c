/**
 * @file    vol_calc.c
 * @brief   码值 → 电压换算实现（架构 §4.2）
 *
 * 关键点：偏置标定量可以是负数（例如 -10 mV），因此偏置相加必须用**有符号**
 * 中间量。若把 offset 当作 uint32 与乘积相加，0 码值 + (-10 mV) 会回绕成
 * 4 294 957 296 µV，经限幅后输出通道量程上限（示例配置下是 20000 mV 而不是 0），
 * 属于"看起来在工作、实际全错"的静默失效。
 */
#include "vol_calc.h"

/** µV / mV */
#define VOL_CALC_UV_PER_MV      ((int64_t)1000)

Vol_VoltageType Vol_Calc_Convert(const Vol_ChannelCfgType *cfg, Vol_AdcValueType adc)
{
    /* 步骤 1~3：引脚电压 → 还原分压 → 增益，全部折叠在 scale_q16 里。
     * adc <= 65535、scale_q16 < 2^32（C9 保证）→ 乘积 < 2^48，64 位足够。 */
    const uint64_t prod_uv = ((uint64_t)adc * (uint64_t)cfg->scale_q16) >> 16;

    /* 步骤 4：偏置标定。用 int64 过渡，避免负偏置在无符号域回绕。 */
    int64_t uv  = (int64_t)prod_uv + (int64_t)cfg->offset_uv;
    int64_t lim = (int64_t)cfg->voltage_max_mv * VOL_CALC_UV_PER_MV;

    /* 步骤 5：限幅到 [0, 本通道量程]，再四舍五入到 mV。
     * 限幅只作用于对外值，不改变滤波缓冲内的样本语义（滤波同样工作在限幅后的 mV 域）。 */
    if (uv < 0)
    {
        uv = 0;
    }
    if (uv > lim)
    {
        uv = lim;
    }

    /* 限幅后 uv <= 65535 * 1000，必然落在 uint32 内。
     * 这里刻意用 32 位除法：64 位除法在 Cortex-M 上会引入 __aeabi_ldivmod 库函数，
     * 单次上百周期；32 位除以常数 1000 由编译器折叠成乘加移位，无库调用。 */
    {
        const uint32_t uv_clamped = (uint32_t)uv;

        return (Vol_VoltageType)((uv_clamped + 500u) / 1000u);
    }
}
