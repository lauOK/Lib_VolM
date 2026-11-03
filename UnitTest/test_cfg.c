/**
 * @file    test_cfg.c
 * @brief   P0 用例：配置体系自检——派生量与手算一致、条件编译边界正确
 *
 * 验证点（对应开发计划 P0 验收）：
 *   1. 派生量打印与手算一致：CH0 scale_q16 = 363593728、window = 8
 *   2. CH0 为 4 状态通道，state_cfg 非空
 *   3. CH1 为仅测量通道，state_num = 0 且 state_cfg == NULL（C12 构造保证）
 *   4. 通道级量程互相独立（20000 / 44000）
 */
#include <stdio.h>
#include <stddef.h>

#include "vol_cfg.h"

static int g_fail;

#define CHECK(cond)                                                      \
    do {                                                                 \
        if (!(cond)) {                                                   \
            (void)printf("  [FAIL] %s  (line %d)\n", #cond, __LINE__);   \
            g_fail++;                                                    \
        }                                                                \
    } while (0)

static void print_channel(unsigned ch)
{
    const Vol_ChannelCfgType *c = &Vol_ChannelCfgTable[ch];

    (void)printf("  CH%u: scale_q16=%lu  offset_uv=%ld  vmax=%u mV  "
                 "window=%u  state_num=%u  state_cfg=%s\n",
                 ch,
                 (unsigned long)c->scale_q16,
                 (long)c->offset_uv,
                 (unsigned)c->voltage_max_mv,
                 (unsigned)c->window,
                 (unsigned)c->state_num,
                 (c->state_cfg == NULL) ? "NULL" : "表");

    if (c->state_cfg != NULL)
    {
        unsigned i;
        for (i = 0u; i < (unsigned)c->state_num; i++)
        {
            (void)printf("        S%u: [%5u, %5u)  hyst_up=%4u  hyst_down=%4u   "
                         "上行门限=%5u  下行门限=%5d\n",
                         i,
                         (unsigned)c->state_cfg[i].lower_mv,
                         (unsigned)c->state_cfg[i].upper_mv,
                         (unsigned)c->state_cfg[i].hyst_up_mv,
                         (unsigned)c->state_cfg[i].hyst_down_mv,
                         (unsigned)c->state_cfg[i].upper_mv + c->state_cfg[i].hyst_up_mv,
                         (int)c->state_cfg[i].lower_mv - (int)c->state_cfg[i].hyst_down_mv);
        }
    }
}

int main(void)
{
    (void)printf("=== Lib_VolM P0 配置自检 ===\n");
    (void)printf("VOL_CHANNEL_NUM=%u  SAMPLE_PERIOD=%u ms  R_MAX=%u ohm  "
                 "WINDOW_MAX=%u  STATE_NUM_MAX=%u\n",
                 (unsigned)VOL_CHANNEL_NUM,
                 (unsigned)VOL_ADC_SAMPLE_PERIOD_MS,
                 (unsigned)VOL_R_MAX_OHM,
                 (unsigned)VOL_FILTER_WINDOW_MAX,
                 (unsigned)VOL_STATE_NUM_MAX);

    print_channel(0u);
    print_channel(1u);

    (void)printf("\n--- 断言 ---\n");

    /* 1. 派生量与手算一致 */
    CHECK(VOL_CH_SCALE_Q16(CH0) == 363593728UL);
    CHECK(VOL_CH0_FILT_WINDOW == 8u);
    CHECK(VOL_CH1_FILT_WINDOW == 16u);
    CHECK(VOL_CH_OFFSET_UV(CH0) == -10000);
    CHECK(VOL_CH_OFFSET_UV(CH1) == 0);

    /* 2. 通道 0：状态通道 */
    CHECK(Vol_ChannelCfgTable[0].state_num == 4u);
    CHECK(Vol_ChannelCfgTable[0].state_cfg != NULL);
    CHECK(Vol_ChannelCfgTable[0].voltage_max_mv == 20000u);
    CHECK(Vol_ChannelCfgTable[0].filt_buf != NULL);
    CHECK(Vol_ChannelCfgTable[0].window == VOL_CH0_FILT_WINDOW);

    /* 状态表内容与配置宏一致（防止表项与宏脱节） */
    CHECK(Vol_ChannelCfgTable[0].state_cfg[2].lower_mv == 9000u);
    CHECK(Vol_ChannelCfgTable[0].state_cfg[2].hyst_down_mv == 2000u);
    CHECK(Vol_ChannelCfgTable[0].state_cfg[2].hyst_up_mv == 500u);
    CHECK(Vol_ChannelCfgTable[0].state_cfg[3].upper_mv == 20000u);

    /* 3. 通道 1：仅测量通道，C12 由构造保证 */
    CHECK(Vol_ChannelCfgTable[1].state_num == 0u);
    CHECK(Vol_ChannelCfgTable[1].state_cfg == NULL);
    CHECK(Vol_ChannelCfgTable[1].voltage_max_mv == 44000u);
    CHECK(Vol_ChannelCfgTable[1].filt_buf != NULL);

    /* 4. 结构体尺寸：指针 4 字节的目标上为 24 字节（架构 §8 的资源估算）；宿主机 64 位为 32 */
    (void)printf("\nsizeof(Vol_ChannelCfgType) = %u 字节（宿主机指针宽度 %u 字节）\n",
                 (unsigned)sizeof(Vol_ChannelCfgType), (unsigned)sizeof(void *));

    (void)printf("\n%s（失败 %d 项）\n", (g_fail == 0) ? "P0 自检通过" : "P0 自检失败", g_fail);

    return (g_fail == 0) ? 0 : 1;
}
