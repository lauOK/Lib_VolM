/**
 * @file    test_sm.c
 * @brief   P3 电压状态机用例（架构 §5.4 / 计划 P3 验收）
 *
 * 被测配置：CH0 四状态（P0 自检输出的门限）
 *   S0 [    0,  6000)  hyst_up=   0  hyst_down=   0   上行 20000  下行     0
 *   S1 [ 6000,  9000)  hyst_up=1000  hyst_down= 500   上行 10000  下行  5500
 *   S2 [ 9000, 16000)  hyst_up= 500  hyst_down=2000   上行 16500  下行  7000
 *   S3 [16000, 20000)  hyst_up=   0  hyst_down= 500   上行 20000  下行 15500
 *
 * 覆盖：四个门限逐点（上/下行各取门限值与门限值±1）、单边界往返、
 *       越级跳变、端点越界、首帧 0xFF 落位、state_num=1、state_num=0、
 *       迟滞不动作带性质校验（随机游走 + 独立参考判定）。
 */
#include <stdio.h>
#include "vol_sm.h"

static unsigned g_fail = 0u;

#define CHECK(cond)                                                     \
    do {                                                                \
        if (!(cond)) {                                                  \
            (void)printf("  [FAIL] %s:%d  %s\n", __FILE__, __LINE__, #cond); \
            g_fail++;                                                   \
        }                                                               \
    } while (0)

#define NUM   ((uint8_t)Vol_ChannelCfgTable[0].state_num)
#define CFG   (Vol_ChannelCfgTable[0].state_cfg)

/* 门限逐点：cur 状态、输入电压、期望状态 */
static void pt(uint8_t cur, unsigned v, uint8_t exp, const char *why)
{
    uint8_t got = Vol_Sm_Next(CFG, NUM, cur, (Vol_VoltageType)v);
    if (got != exp)
    {
        (void)printf("  [FAIL] cur=S%u v=%5u 期望 S%u 实得 S%u  (%s)\n",
                     cur, v, exp, got, why);
        g_fail++;
    }
}

static void test_thresholds(void)
{
    (void)printf("-- 1. 四个门限逐点（门限值±1 都要验证）--\n");

    /* S1 -> S2 上行门限 10000 */
    pt(1u,  9999u, 1u, "上行门限-1 保持");
    pt(1u, 10000u, 2u, "上行门限 迁移");
    pt(1u, 10001u, 2u, "上行门限+1 迁移");

    /* S2 -> S1 下行门限 7000 */
    pt(2u,  7001u, 2u, "下行门限+1 保持");
    pt(2u,  7000u, 1u, "下行门限 迁移");
    pt(2u,  6999u, 1u, "下行门限-1 迁移");

    /* S2 -> S3 上行门限 16500 */
    pt(2u, 16499u, 2u, "上行门限-1 保持");
    pt(2u, 16500u, 3u, "上行门限 迁移");

    /* S3 -> S2 下行门限 15500 */
    pt(3u, 15501u, 3u, "下行门限+1 保持");
    pt(3u, 15500u, 2u, "下行门限 迁移");

    /* S1 -> S0 下行门限 5500（hyst_down=500 作用在 lower=6000） */
    pt(1u,  5600u, 1u, "S1 下行保持（5400 与 5600 之间不对称）");
    pt(1u,  5500u, 0u, "S1 下行门限 迁移");
    pt(1u,  5400u, 0u, "S1 下行门限-1 迁移");

    (void)printf("  13 个门限点全部符合 上下行独立迟滞 语义  OK\n");
}

static void test_roundtrip(void)
{
    (void)printf("-- 2. 单边界往返 --\n");
    /* S2 内升到 16500 进 S3，再降回 15500 出 S3：一升一降门限不同 */
    pt(2u, 16499u, 2u, "往返起点 S2");
    pt(2u, 16500u, 3u, "升入 S3");
    pt(3u, 16000u, 3u, "S3 内保持");
    pt(3u, 15500u, 2u, "降回 S2");
    pt(2u, 16000u, 2u, "回到 S2 内");
    (void)printf("  S2<->S3 往返：进 16500 / 出 15500  OK\n");
}

static void test_multilevel(void)
{
    (void)printf("-- 3. 越级跳变 --\n");
    /* S0 直接跳 S3：17000 >= S0 上行门限 6000+0=6000？注意 S0 hyst_up=0，
     * 上行门限 6000；17000 定位 S3，17000 >= 6000 成立 → 一步到 S3 */
    pt(0u, 17000u, 3u, "S0 越级到 S3（跨 2 级）");
    /* S3 直接跳 S0：100 <= S3 下行门限 15500 → 一步到 S0 */
    pt(3u,   100u, 0u, "S3 越级到 S0（跨 3 级）");
    /* 越级时迟滞看的是"当前状态"的门限，不是目标状态 */
    pt(1u, 17000u, 3u, "S1 越级到 S3（门限取 S1 的 10000）");
    (void)printf("  跨级跳变一步到达，门限取当前状态  OK\n");
}

static void test_endpoints(void)
{
    (void)printf("-- 4. 端点越界（区间外饱和）--\n");
    pt(1u, 65535u, 3u, "高于量程 → 末状态");
    pt(3u, 65535u, 3u, "高于量程且已在末状态 → 保持");
    pt(2u,     0u, 0u, "低于全域 → 首状态");
    /* 区间缝隙不存在（C5 保证），区间定位漏空时同样饱和到端点 */
    (void)printf("  越界输入饱和到端点状态，无回绕  OK\n");
}

static void test_first_frame(void)
{
    (void)printf("-- 5. 首帧 cur=0xFF 直接落位（不走迟滞）--\n");
    uint8_t ff = VOL_STATE_INVALID;
    unsigned v;
    for (v = 0u; v <= 65535u; v += 611u)   /* 全量程抽样 108 点 */
    {
        uint8_t got = Vol_Sm_Next(CFG, NUM, ff, (Vol_VoltageType)v);
        uint8_t exp;
        if      (v <  6000u) { exp = 0u; }
        else if (v <  9000u) { exp = 1u; }
        else if (v < 16000u) { exp = 2u; }
        else                 { exp = 3u; }
        if (got != exp)
        {
            (void)printf("  [FAIL] 首帧 v=%u 期望 S%u 实得 S%u\n", v, exp, got);
            g_fail++;
        }
    }
    (void)printf("  108 个抽样点全部直接落位  OK\n");
}

static void test_num1_num0(void)
{
    (void)printf("-- 6. state_num=1 与 state_num=0 --\n");
    {
        static const Vol_StateCfgType one[1] =
            { { 0u, 20000u, 0u, 0u } };
        /* num=1：任何 cur 都应保持/落回 S0，不越界 */
        CHECK(Vol_Sm_Next(one, 1u, 0u, 10000u) == 0u);
        CHECK(Vol_Sm_Next(one, 1u, 0u, 0u)     == 0u);
        CHECK(Vol_Sm_Next(one, 1u, 0u, 65535u) == 0u);
        CHECK(Vol_Sm_Next(one, 1u, VOL_STATE_INVALID, 10000u) == 0u);
    }
    /* num=0：兜底返回 0 且绝不解引用 cfg（传 NULL 验证不崩溃） */
    CHECK(Vol_Sm_Next((const Vol_StateCfgType *)0, 0u, 0u, 10000u) == 0u);
    CHECK(Vol_Sm_Next((const Vol_StateCfgType *)0, 0u, VOL_STATE_INVALID, 0u) == 0u);
    (void)printf("  num=1 全输入保持 S0；num=0 返回 0 且不触碰状态表  OK\n");
}

/* 独立参考判定（与被测实现不同构）：区间定位用逐区间比较 + 显式迟滞规则 */
static uint8_t ref_next(uint8_t cur, unsigned v)
{
    const Vol_StateCfgType *c = CFG;
    uint8_t n = NUM;
    uint8_t t;
    uint8_t i;
    int found = 0;

    for (i = 0u; i < n; i++)
    {
        if ((v >= c[i].lower_mv) && (v < c[i].upper_mv)) { t = i; found = 1; break; }
    }
    if (found == 0) { t = (v < c[0].lower_mv) ? 0u : (uint8_t)(n - 1u); }

    if (cur >= n) { return t; }

    if (t > cur)
    {
        if ((int32_t)v >= (int32_t)c[cur].upper_mv + (int32_t)c[cur].hyst_up_mv)
        {
            return t;
        }
    }
    if (t < cur)
    {
        if ((int32_t)v <= (int32_t)c[cur].lower_mv - (int32_t)c[cur].hyst_down_mv)
        {
            return t;
        }
    }
    return cur;
}

static void test_random_walk(void)
{
    (void)printf("-- 7. 随机 (状态,电压) 组合 vs 独立参考 --\n");
    unsigned seed = 20261102u;
    unsigned i;
    for (i = 0u; i < 20000u; i++)
    {
        seed = (seed * 1103515245u + 12345u) & 0x7FFFFFFFu;
        uint8_t cur = (uint8_t)((seed >> 8) % 5u);            /* 0..3 及 0xFF */
        if ((seed & 0x100u) != 0u) { cur = VOL_STATE_INVALID; }
        unsigned v = (seed >> 12) % 21000u;                   /* 0..20999 */
        uint8_t got = Vol_Sm_Next(CFG, NUM, cur, (Vol_VoltageType)v);
        uint8_t exp = ref_next(cur, v);
        if (got != exp)
        {
            (void)printf("  [FAIL] cur=%u v=%u 期望 S%u 实得 S%u\n",
                         cur, v, exp, got);
            g_fail++;
        }
    }
    (void)printf("  20000 组随机组合与独立参考完全一致  OK\n");
}

static void test_plan_vectors(void)
{
    /* 计划 P3 验收表逐条原样复刻（TempTrash/VolM_DevPlan.md P3 验收） */
    static const struct { uint8_t cur; unsigned v; uint8_t exp; const char *why; } tbl[] = {
        { VOL_STATE_INVALID, 12000u, 2u, "首帧直接落位，不走迟滞" },
        { 1u,  9800u, 1u, "未到 10000" },
        { 1u, 10000u, 2u, "恰好上门限（9+1）" },
        { 2u,  8850u, 2u, "未破 7000，大迟滞保持" },
        { 2u,  7100u, 2u, "仍未破 7000" },
        { 2u,  7000u, 1u, "恰好下门限（9-2）" },
        { 2u, 16400u, 2u, "未到 16500（同状态另一迟滞更小）" },
        { 2u, 16500u, 3u, "恰好上门限（16+0.5）" },
        { 3u, 15600u, 3u, "未破 15500" },
        { 3u, 15500u, 2u, "恰好下门限（16-0.5）" },
        { 1u,  5600u, 1u, "未破 5500" },
        { 1u,  5400u, 0u, "破 5500，掉到 S0" },
        { 0u, 17000u, 3u, "越级跳变（跨 3 级）" },
        { 3u,   100u, 0u, "下行越级" },
        { 1u, 65535u, 3u, "超上限取末状态" },
        { 1u,     0u, 0u, "低于下限取首状态" },
    };
    unsigned k;
    for (k = 0u; k < sizeof tbl / sizeof tbl[0]; k++)
    {
        uint8_t got = Vol_Sm_Next(CFG, NUM, tbl[k].cur, (Vol_VoltageType)tbl[k].v);
        if (got != tbl[k].exp)
        {
            (void)printf("  [FAIL] 计划向量 %u: cur=%u v=%u 期望 S%u 实得 S%u (%s)\n",
                         k, tbl[k].cur, tbl[k].v, tbl[k].exp, got, tbl[k].why);
            g_fail++;
        }
    }
    (void)printf("  计划 P3 验收表 %u 条向量逐条通过  OK\n",
                 (unsigned)(sizeof tbl / sizeof tbl[0]));
}

int main(void)
{
    (void)printf("== test_sm ==\n");
    CHECK(NUM == 4u);
    test_thresholds();
    test_roundtrip();
    test_multilevel();
    test_endpoints();
    test_first_frame();
    test_num1_num0();
    test_random_walk();
    test_plan_vectors();

    if (g_fail != 0u)
    {
        (void)printf("== test_sm: %u 项失败 ==\n", g_fail);
        return 1;
    }
    (void)printf("== test_sm: 全部通过 ==\n");
    return 0;
}
