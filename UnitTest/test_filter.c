/**
 * @file    test_filter.c
 * @brief   P2 滑动均值滤波用例（架构 §5.1 / 计划 P2 验收）
 *
 * 覆盖：填充过程（部分均值）、稳态、阶跃响应、window=1 退化、
 *       环形回绕、与朴素参考实现逐点比对、极限和校验（window=1024）。
 */
#include <stdio.h>
#include "vol_filt.h"

static unsigned g_fail = 0u;

#define CHECK(cond)                                                      \
    do {                                                                 \
        if (!(cond)) {                                                   \
            (void)printf("  [FAIL] %s:%d  %s\n", __FILE__, __LINE__, #cond); \
            g_fail++;                                                    \
        }                                                                \
    } while (0)

/* 朴素参考实现：每次全窗口重算，与被测实现做逐点比对 */
static unsigned naive_mean(const Vol_ChannelCfgType *cfg,
                           const Vol_FiltCtxType *ctx)
{
    unsigned i;
    unsigned n = (ctx->count < cfg->window) ? (unsigned)ctx->count
                                            : (unsigned)cfg->window;
    unsigned sum = 0u;
    /* 从最新样本往回取 n 个：最新在 (idx-1+n) % window 处 */
    unsigned start = ((unsigned)ctx->idx + (unsigned)cfg->window - n)
                     % (unsigned)cfg->window;
    for (i = 0u; i < n; i++)
    {
        sum += cfg->filt_buf[(start + i) % (unsigned)cfg->window];
    }
    return (n == 0u) ? 0u : (sum / n);
}

static void test_fill_steady(void)
{
    static Vol_FiltCtxType ctx;
    const Vol_ChannelCfgType *cfg = &Vol_ChannelCfgTable[0]; /* window=8 */

    (void)printf("-- 1. 填充过程（部分均值）--\n");
    Vol_Filt_Reset(&ctx, cfg);
    CHECK(ctx.count == 0u);
    CHECK(Vol_Filt_IsReady(&ctx, cfg) == 0u);

    /* 依次喂 1000,2000,...：第 n 个样本后输出 = (1000+...+1000n)/n */
    unsigned k;
    for (k = 1u; k <= 8u; k++)
    {
        unsigned exp_sum = 1000u * k * (k + 1u) / 2u; /* 1000+..+1000k */
        unsigned got = Vol_Filt_Input(&ctx, cfg, (Vol_VoltageType)(1000u * k));
        CHECK(got == exp_sum / k);
        CHECK(ctx.count == k);
        CHECK(ctx.sum == exp_sum);
    }
    CHECK(Vol_Filt_IsReady(&ctx, cfg) == 1u);
    (void)printf("  填充期输出 = sum/count，填满后 ready=1  OK\n");

    (void)printf("-- 2. 稳态（恒输入，含过渡期）--\n");
    /* 填充期窗口内容为 1000..8000，喂 12345 需 8 拍才能完全替换旧样本：
     * 第 k 拍（k=1..8）sum = 36000 - (1000+..+1000k) + 12345k */
    {
        unsigned old_sum = 0u; /* 1000+..+8000 */
        unsigned k;
        for (k = 1u; k <= 8u; k++) { old_sum += 1000u * k; }
        for (k = 1u; k <= 8u; k++)
        {
            unsigned exp = (old_sum - 1000u * k * (k + 1u) / 2u
                            + 12345u * k) / 8u;
            CHECK(Vol_Filt_Input(&ctx, cfg, 12345u) == exp);
        }
    }
    for (k = 0u; k < 16u; k++)
    {
        CHECK(Vol_Filt_Input(&ctx, cfg, 12345u) == 12345u);
    }
    (void)printf("  过渡期按替换公式收敛，8 拍后恒为 12345 mV  OK\n");
}

static void test_step(void)
{
    static Vol_FiltCtxType ctx;
    const Vol_ChannelCfgType *cfg = &Vol_ChannelCfgTable[0]; /* window=8 */

    (void)printf("-- 3. 阶跃响应 --\n");
    Vol_Filt_Reset(&ctx, cfg);
    unsigned k;
    for (k = 0u; k < 8u; k++)
    {
        (void)Vol_Filt_Input(&ctx, cfg, 10000u);
    }
    CHECK(Vol_Filt_Output(&ctx, cfg) == 10000u);

    /* 从 10000 阶跃到 11000：第 j 个样本后
     * sum = 10000*(8-j) + 11000*j，输出 = sum/8（整数） */
    for (k = 1u; k <= 8u; k++)
    {
        unsigned exp = (10000u * (8u - k) + 11000u * k) / 8u;
        CHECK(Vol_Filt_Input(&ctx, cfg, 11000u) == exp);
    }
    /* 阶跃结束后第 9 个样本起恢复恒值 */
    CHECK(Vol_Filt_Input(&ctx, cfg, 11000u) == 11000u);
    (void)printf("  10000->11000 阶跃：8 个样本内按公式线性收敛  OK\n");
}

static void test_window1(void)
{
    static Vol_FiltCtxType ctx;
    const Vol_ChannelCfgType *cfg = &Vol_ChannelCfgTable[0];

    (void)printf("-- 4. window=1 退化 --\n");
    {
        /* 局部配置：指向 1 深度缓冲 */
        static Vol_FilterSampleType buf1[1];
        Vol_ChannelCfgType c1 = *cfg;
        c1.filt_buf = buf1;
        c1.window   = 1u;

        Vol_Filt_Reset(&ctx, &c1);
        CHECK(Vol_Filt_Input(&ctx, &c1, 777u) == 777u);  /* 首样本即输出 */
        CHECK(Vol_Filt_IsReady(&ctx, &c1) == 1u);
        CHECK(Vol_Filt_Input(&ctx, &c1, 999u) == 999u);  /* 立即跟随 */
        CHECK(Vol_Filt_Input(&ctx, &c1, 0u)   == 0u);
    }
    (void)printf("  window=1：输出恒等于最新样本  OK\n");
}

static void test_wrap_and_naive(void)
{
    static Vol_FiltCtxType ctx;
    const Vol_ChannelCfgType *cfg = &Vol_ChannelCfgTable[0]; /* window=8 */

    (void)printf("-- 5. 环形回绕 + 与朴素实现逐点比对 --\n");
    Vol_Filt_Reset(&ctx, cfg);

    /* 伪随机序列（LCG），300 个样本远超窗口，覆盖多轮回绕 */
    unsigned seed = 12345u;
    unsigned i;
    for (i = 0u; i < 300u; i++)
    {
        seed = (seed * 1103515245u + 12345u) & 0xFFFFu;
        Vol_VoltageType s = (Vol_VoltageType)(seed % 20000u);
        unsigned got = Vol_Filt_Input(&ctx, cfg, s);
        unsigned exp = naive_mean(cfg, &ctx);
        if (got != exp)
        {
            (void)printf("  [FAIL] i=%u sample=%u got=%u exp=%u\n",
                         i, s, got, exp);
            g_fail++;
        }
    }
    (void)printf("  300 个伪随机样本与朴素重算逐点一致  OK\n");
}

static void test_limit_sum(void)
{
    static Vol_FiltCtxType ctx;
    const Vol_ChannelCfgType *cfg = &Vol_ChannelCfgTable[0];

    (void)printf("-- 6. 运行和上限（window=1024，满幅样本）--\n");
    {
        static Vol_FilterSampleType big[1024];
        Vol_ChannelCfgType c = *cfg;
        c.filt_buf = big;
        c.window   = 1024u;

        Vol_Filt_Reset(&ctx, &c);
        unsigned k;
        Vol_VoltageType out = 0u;
        for (k = 0u; k < 1024u; k++)
        {
            out = Vol_Filt_Input(&ctx, &c, 65535u);
        }
        CHECK(out == 65535u);
        CHECK(ctx.sum == 65535u * 1024u);   /* 6.71e7 < 2^32，无回绕 */
        CHECK(Vol_Filt_IsReady(&ctx, &c) == 1u);
    }
    (void)printf("  1024×65535 = %lu  无 uint32 回绕  OK\n",
                 (unsigned long)(65535u * 1024u));
}

static void test_reinit(void)
{
    static Vol_FiltCtxType ctx;
    const Vol_ChannelCfgType *cfg = &Vol_ChannelCfgTable[0];

    (void)printf("-- 7. 重复 Reset（残留缓冲回归）--\n");
    /* 先跑出非零缓冲，再 Reset，验证清零路径 */
    (void)Vol_Filt_Input(&ctx, cfg, 19999u);
    Vol_Filt_Reset(&ctx, cfg);
    CHECK(ctx.sum == 0u);
    CHECK(ctx.count == 0u);
    /* Reset 后首样本必须干净：sum 只含新样本 */
    CHECK(Vol_Filt_Input(&ctx, cfg, 500u) == 500u);
    (void)printf("  重初始化后无残留污染  OK\n");
}

int main(void)
{
    (void)printf("== test_filter ==\n");
    test_fill_steady();
    test_step();
    test_window1();
    test_wrap_and_naive();
    test_limit_sum();
    test_reinit();

    if (g_fail != 0u)
    {
        (void)printf("== test_filter: %u 项失败 ==\n", g_fail);
        return 1;
    }
    (void)printf("== test_filter: 全部通过 ==\n");
    return 0;
}
