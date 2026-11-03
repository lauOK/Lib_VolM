/**
 * @file    Template/main.c
 * @brief   Lib_VolM 集成示例：双通道演示（可独立编译运行）
 *
 * 演示内容：
 *  - CH0（KL30，4 状态，非对称迟滞）：模拟一次"正常 → 曲轴拖动跌落 →
 *    恢复 → 高压 → 恢复"的电压历程，观察状态机按迟滞门限迁移；
 *  - CH1（RBIN 冗余蓄电池，仅测量通道）：只提供电压，状态项显示 N/A；
 *  - 周期模型：每 1 ms 采样一次（模拟 ADC 中断），每 5 ms 调一次 Vol_Task
 *    （模拟主循环任务），与 VOL_ADC_SAMPLE_PERIOD_MS = 1 的配置一致。
 *
 * 编译（宿主机验证）：
 *     gcc -std=c99 -Wall -Wextra -Iinc -Isrc Template/main.c src/vol_cfg.c \
 *         src/vol_calc.c src/vol_filt.c src/vol_sm.c src/vol.c -o vol_demo
 *
 * 移植到 MCU：把本文件中的"模拟采样"替换为真实 ADC 中断调用
 * Vol_SetAdcValue，主循环/OS 任务里周期调用 Vol_Task 即可。
 */
#include <stdio.h>

#include "vol.h"

/* --------------------------------------------------------------------
 * 模拟 ADC：把目标 mV 反算为码值（含偏置补偿）。
 * 真实系统中删除本节，直接把 ADC 原始码值传给 Vol_SetAdcValue。
 * ------------------------------------------------------------------ */
static unsigned sim_mv_to_raw(uint8_t ch, unsigned mv)
{
    const Vol_ChannelCfgType *c = &Vol_ChannelCfgTable[ch];
    uint64_t uv = (uint64_t)mv * 1000u + (uint64_t)(uint32_t)(-(c->offset_uv));
    return (unsigned)((uv << 16) / c->scale_q16);
}

/** 历程分段点 */
typedef struct
{
    unsigned t_ms;      /**< 该段起始时刻 */
    unsigned mv;        /**< 该段电压 */
} SimPoint;

/** CH0 电压历程：{起始 ms, 电压 mV}，分段恒值，模拟整车电压事件 */
static const SimPoint ch0_profile[] =
{
    {   0u, 12000u },   /* 正常 12 V */
    {  50u,  5000u },   /* 曲轴拖动：跌到 5 V（越过 7000 门限 → S0） */
    { 150u, 12000u },   /* 恢复（越过 S0 上行门限 6000 → 直接回 S2） */
    { 300u, 18000u },   /* 负载突卸：18 V（越过 16500 → S3） */
    { 400u, 12000u },   /* 回落（越过 15500 → S2） */
    { 600u,  6500u },   /* 掉到低压区（6500 破 S2 下行门限 7000 → S1；
                           若只掉到 8000，因迟滞保持 S2，属正常语义） */
};

/** CH1 电池电压历程：仅测量，慢变化 */
static const SimPoint ch1_profile[] =
{
    {   0u, 24000u },
    { 200u, 26000u },   /* 充电 */
    { 500u, 22000u },   /* 放电 */
};

#define PROF_N(p)  (sizeof(p) / sizeof((p)[0]))

static unsigned profile_mv(const SimPoint *p, unsigned n, unsigned t_ms)
{
    unsigned v = p[0].mv;
    unsigned i;

    for (i = 0u; i < n; i++)
    {
        if (t_ms >= p[i].t_ms)
        {
            v = p[i].mv;
        }
    }
    return v;
}

/* --------------------------------------------------------------------
 * 演示主循环
 * ------------------------------------------------------------------ */
static const char *state_name(uint8_t s)
{
    static const char *const names[] = { "严重欠压", "低压  ", "正常  ", "高压  " };
    return (s < 4u) ? names[s] : "无效  ";
}

int main(void)
{
    unsigned t;
    uint8_t  prev_state = VOL_STATE_INVALID;

    (void)printf("=== Lib_VolM 双通道演示（1 ms 采样 / 5 ms Task）===\n\n");

    Vol_Init();

    for (t = 0u; t < 800u; t++)                 /* 模拟 800 ms */
    {
        /* -- 采样节拍（真实系统：ADC 完成中断里调用）-- */
        (void)Vol_SetAdcValue(0u, (Vol_AdcValueType)sim_mv_to_raw(0u, profile_mv(ch0_profile, PROF_N(ch0_profile), t)));
        (void)Vol_SetAdcValue(1u, (Vol_AdcValueType)sim_mv_to_raw(1u, profile_mv(ch1_profile, PROF_N(ch1_profile), t)));

        /* -- 任务节拍（真实系统：主循环 / OS 任务，5 ms 周期）-- */
        if ((t % 5u) == 0u)
        {
            Vol_VoltageType v0 = 0u;
            Vol_VoltageType v1 = 0u;
            uint8_t         s0 = VOL_STATE_INVALID;
            uint8_t         s1 = VOL_STATE_INVALID;

            Vol_Task();

            (void)Vol_GetVoltage(0u, &v0);
            (void)Vol_GetState(0u, &s0);
            (void)Vol_GetVoltage(1u, &v1);
            (void)Vol_GetState(1u, &s1);        /* 恒返回 E_NO_STATE */

            /* CH0：状态迁移打印（窗口未满或未迁移时保持安静） */
            if (s0 != prev_state)
            {
                if (s0 == VOL_STATE_INVALID)
                {
                    (void)printf("[%3u ms] CH0 窗口充填中...\n", t);
                }
                else
                {
                    (void)printf("[%3u ms] CH0 %u.%03u V -> %s (S%u)\n",
                                 t, v0 / 1000u, v0 % 1000u, state_name(s0), s0);
                }
                prev_state = s0;
            }

            /* CH1：仅测量通道，每 100 ms 打印一次电压，状态恒 N/A */
            if ((t % 100u) == 0u)
            {
                (void)printf("[%3u ms] CH1 %u.%03u V  状态 N/A (仅测量通道)\n",
                             t, v1 / 1000u, v1 % 1000u);
            }
        }
    }

    (void)printf("\n=== 演示结束：CH0 依次经历 正常->严重欠压->正常->高压->正常->低压 ===\n");
    return 0;
}
