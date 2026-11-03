/**
 * @file    test_calc.c
 * @brief   P1 用例：电压换算（码值 → mV）
 *
 * 验证点（对应开发计划 P1 验收）：
 *   1. 固定测试向量：0 → 0（负偏置被限幅）、512 → 2831、2048 → 11352、4095 → 20000
 *   2. 全量程 0..4095 扫描：单调不减、相邻差 ≤ 7 mV、无回绕
 *   3. 码值 > ADC_FS 时按实际码值换算、由限幅兜住，不报错
 *   4. 与物理公式的高精度参考值比对（容差 6 mV，覆盖 Q16 系数的编译期截断）
 *   5. 双向扫描一致（纯函数，无隐藏状态）
 *   6. 仅测量通道（CH1，量程 44000）换算与限幅独立于 CH0
 *
 * 说明：本文件只跑在宿主机上，参考值用 double 计算是为了独立于被测定点实现；
 *       库代码本身不含任何浮点。
 */
#include <stdio.h>

#include "vol_calc.h"

static int g_fail;

#define CHECK(cond)                                                      \
    do {                                                                 \
        if (!(cond)) {                                                   \
            (void)printf("  [FAIL] %s  (line %d)\n", #cond, __LINE__);   \
            g_fail++;                                                    \
        }                                                                \
    } while (0)

#define CHECK_MV(ch, adc, exp)                                                     \
    do {                                                                           \
        const unsigned got_ = (unsigned)Vol_Calc_Convert(&Vol_ChannelCfgTable[ch], \
                                                         (Vol_AdcValueType)(adc)); \
        if (got_ != (unsigned)(exp)) {                                             \
            (void)printf("  [FAIL] CH%d raw=%u -> %u mV，期望 %u mV (line %d)\n",  \
                         (ch), (unsigned)(adc), got_, (unsigned)(exp), __LINE__);  \
            g_fail++;                                                              \
        }                                                                          \
    } while (0)

/** 物理公式参考值（不计 Q16 截断），单位 mV */
static double ref_mv(unsigned ch, unsigned adc)
{
    const double vref = (ch == 0u) ? 3300.0 : 3300.0;
    const double fs   = 4095.0;
    const double rh   = (ch == 0u) ? 30000.0 : 100000.0;
    const double rl   = (ch == 0u) ? 5100.0 : 8200.0;
    const double gain = (ch == 0u) ? 500.0 : 0.0;
    const double off  = (ch == 0u) ? -10.0 : 0.0;
    const double vmax = (ch == 0u) ? 20000.0 : 44000.0;

    double v = (double)adc * vref / fs * (rh + rl) / rl * (1.0 + gain / 1000000.0) + off;

    if (v < 0.0)
    {
        v = 0.0;
    }
    if (v > vmax)
    {
        v = vmax;
    }
    return v;
}

static void sweep(unsigned ch, unsigned max_step_allowed)
{
    unsigned adc;
    unsigned prev = 0u;
    unsigned max_step = 0u;
    unsigned bad_mono = 0u;
    unsigned bad_tol = 0u;
    unsigned worst = 0u;
    double worst_d = 0.0;

    for (adc = 0u; adc <= 4095u; adc++)
    {
        const unsigned mv  = (unsigned)Vol_Calc_Convert(&Vol_ChannelCfgTable[ch], (Vol_AdcValueType)adc);
        const double   ref = ref_mv(ch, adc);
        const double   d   = (double)mv - ref;

        if ((adc > 0u) && (mv < prev))
        {
            bad_mono++;
        }
        if ((adc > 0u) && ((mv - prev) > max_step))
        {
            max_step = mv - prev;
        }
        if ((d > worst_d))
        {
            worst_d = d;
            worst   = mv;
        }
        if ((d > 6.0) || (d < -6.0))
        {
            bad_tol++;
        }
        prev = mv;
    }

    (void)printf("  CH%u 全量程扫描: 单调性违例 %u 处，相邻最大差 %u mV（上限 %u），"
                 "超容差(±6 mV) %u 处，最大正偏 %+.2f mV (@%u mV)\n",
                 ch, bad_mono, max_step, max_step_allowed, bad_tol, worst_d, worst);

    CHECK(bad_mono == 0u);
    CHECK(max_step <= max_step_allowed);
    CHECK(bad_tol == 0u);
}

int main(void)
{
    (void)printf("=== Lib_VolM P1 电压换算 ===\n");

    (void)printf("\n-- 1. 固定测试向量（CH0: 30k/5.1k, +500ppm, -10mV, 量程 20000）--\n");
    CHECK_MV(0u, 0u, 0u);           /* 负偏置：0 - 10 mV 被限幅为 0 */
    CHECK_MV(0u, 1u, 0u);           /* 5548 - 10000 µV < 0 */
    CHECK_MV(0u, 2u, 1u);           /* 1096 µV → 1 mV */
    CHECK_MV(0u, 512u, 2831u);
    CHECK_MV(0u, 2048u, 11352u);    /* 中值点（理论 11.35 V） */
    CHECK_MV(0u, 4095u, 20000u);    /* 超上限被限幅 */

    (void)printf("\n-- 2. 码值超出 ADC_FS --\n");
    CHECK_MV(0u, 4096u, 20000u);
    CHECK_MV(0u, 65535u, 20000u);

    (void)printf("\n-- 3. 全量程扫描 --\n");
    /* CH0 每 LSB ≈ 5.55 mV，CH1 每 LSB ≈ 10.63 mV，相邻差上限按各自量级取 */
    sweep(0u, 7u);
    sweep(1u, 12u);

    (void)printf("\n-- 4. 仅测量通道 CH1（100k/8.2k, 量程 44000）--\n");
    CHECK_MV(1u, 0u, 0u);
    CHECK_MV(1u, 2048u, 21776u);    /* 2048 × 10.633 mV */
    CHECK_MV(1u, 4095u, 43542u);    /* 未被 CH0 的 20 V 量程截断 */
    CHECK_MV(1u, 65535u, 44000u);   /* 超量程被限幅到本通道上限 */

    (void)printf("\n-- 5. 双向扫描一致（纯函数，无隐藏状态）--\n");
    {
        static Vol_VoltageType asc[4096];
        unsigned adc;
        unsigned diff = 0u;

        for (adc = 0u; adc <= 4095u; adc++)
        {
            asc[adc] = Vol_Calc_Convert(&Vol_ChannelCfgTable[0], (Vol_AdcValueType)adc);
        }
        adc = 4095u;
        do
        {
            if (Vol_Calc_Convert(&Vol_ChannelCfgTable[0], (Vol_AdcValueType)adc) != asc[adc])
            {
                diff++;
            }
        } while (adc-- > 0u);
        (void)printf("  正反向重复换算不一致 %u 处\n", diff);
        CHECK(diff == 0u);
    }

    (void)printf("\n%s（失败 %d 项）\n", (g_fail == 0) ? "P1 换算用例通过" : "P1 换算用例失败", g_fail);

    return (g_fail == 0) ? 0 : 1;
}
