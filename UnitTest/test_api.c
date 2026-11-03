/**
 * @file    test_api.c
 * @brief   P4 对外接口集成用例（架构 §6 / §7，计划 P4 验收）
 *
 * 覆盖：未初始化守卫、异常路径（E_PARAM/E_NOT_READY/E_NO_STATE + 安全值）、
 *       端到端数据流（Set→Task→Get）、状态迁移、量程独立、超 FS 输入、
 *       重初始化确定性、窗口刚满首个 Task 前的瞬态语义。
 */
#include <stdio.h>
#include "vol.h"
#include "vol_priv.h"

static unsigned g_fail = 0u;

#define CHECK_NEAR(v, target, tol) \
    do { \
        if ((v) < (target) - (tol) || (v) > (target) + (tol)) { \
            (void)printf("  [FAIL] %s:%d  %u 与 %u 相差超过 %u mV\n", \
                         __FILE__, __LINE__, (unsigned)(v), \
                         (unsigned)(target), (unsigned)(tol)); \
            g_fail++; \
        } \
    } while (0)

#define CHECK(cond)                                                     \
    do {                                                                \
        if (!(cond)) {                                                  \
            (void)printf("  [FAIL] %s:%d  %s\n", __FILE__, __LINE__, #cond); \
            g_fail++;                                                   \
        }                                                               \
    } while (0)

/* mv -> raw 反算（抵消偏置），用于端到端激励；换算误差 ≤1 mV，
 * 状态用例的激励点都离门限 ≥300 mV，不受影响 */
static unsigned mv_to_raw(uint8_t ch, unsigned mv)
{
    const Vol_ChannelCfgType *c = &Vol_ChannelCfgTable[ch];
    uint64_t uv = (uint64_t)mv * 1000u + (uint64_t)(uint32_t)(-(c->offset_uv));
    return (unsigned)((uv << 16) / c->scale_q16);
}

static void feed(uint8_t ch, unsigned raw, unsigned times)
{
    unsigned k;
    for (k = 0u; k < times; k++)
    {
        Vol_ReturnType r = Vol_SetAdcValue(ch, (Vol_AdcValueType)raw);
        if (r != VOL_OK)
        {
            (void)printf("  [FAIL] feed ch=%u r=%d\n", ch, (int)r);
            g_fail++;
            return;
        }
    }
}

static void test_not_init(void)
{
    Vol_VoltageType v = 0xABCDu;
    uint8_t s = 0xAAu;

    (void)printf("-- 1. 未初始化：4 接口全拒绝 --\n");
    CHECK(Vol_SetAdcValue(0u, 100u) == VOL_E_NOT_INIT);
    CHECK(Vol_GetVoltage(0u, &v) == VOL_E_NOT_INIT);
    CHECK(Vol_GetState(0u, &s) == VOL_E_NOT_INIT);
    Vol_Task();                                  /* void：只验证不崩溃 */
    CHECK(v == 0xABCDu);                         /* E_NOT_INIT：输出不写 */
    CHECK(s == 0xAAu);
    (void)printf("  未初始化时全返回 E_NOT_INIT，输出参数未被触碰  OK\n");
}

static void test_exception_paths(void)
{
    Vol_VoltageType v = 0xABCDu;
    uint8_t s = 0xAAu;

    (void)printf("-- 2. 异常路径（初始化后、未喂数）--\n");
    Vol_Init();

    /* E_PARAM：通道越界，输出不写 */
    CHECK(Vol_GetVoltage(VOL_CHANNEL_NUM, &v) == VOL_E_PARAM);
    CHECK(v == 0xABCDu);
    CHECK(Vol_GetState(VOL_CHANNEL_NUM, &s) == VOL_E_PARAM);
    CHECK(s == 0xAAu);
    CHECK(Vol_SetAdcValue(VOL_CHANNEL_NUM, 100u) == VOL_E_PARAM);
    CHECK(Vol_SetAdcValue(0xFFu, 100u) == VOL_E_PARAM);

    /* E_PARAM：NULL 指针 */
    CHECK(Vol_GetVoltage(0u, (Vol_VoltageType *)0) == VOL_E_PARAM);
    CHECK(Vol_GetState(0u, (uint8_t *)0) == VOL_E_PARAM);

    /* E_NOT_READY：窗口未满，输出写安全值 0 / 0xFF */
    CHECK(Vol_GetVoltage(0u, &v) == VOL_E_NOT_READY);
    CHECK(v == 0u);
    CHECK(Vol_GetState(0u, &s) == VOL_E_NOT_READY);
    CHECK(s == VOL_STATE_INVALID);

    /* E_NO_STATE：仅测量通道，先于 NOT_READY 判定，也写 0xFF */
    CHECK(Vol_GetState(1u, &s) == VOL_E_NO_STATE);
    CHECK(s == VOL_STATE_INVALID);

    (void)printf("  守卫顺序与安全值符合架构 §6.5  OK\n");
}

static void test_end_to_end(void)
{
    Vol_VoltageType v = 0u;
    uint8_t s = 0xFFu;

    (void)printf("-- 3. 端到端：Set -> Task -> Get --\n");
    Vol_Init();

    feed(0u, mv_to_raw(0u, 12000u), 8u);         /* 填满 window=8 */

    /* 窗口刚满、Task 未跑：GetVoltage 已就绪，GetState 为文档化瞬态 OK+0xFF */
    CHECK(Vol_GetVoltage(0u, &v) == VOL_OK);
    CHECK_NEAR(v, 12000u, 12u);   /* 反算 raw 有 ≤4 mV 系数量化误差 */
    CHECK(Vol_GetState(0u, &s) == VOL_OK);
    CHECK(s == VOL_STATE_INVALID);
    Vol_Task();
    CHECK(Vol_GetState(0u, &s) == VOL_OK);
    CHECK(s == 2u);                              /* 12000 ∈ [9000,16000) */
    (void)printf("  12000 mV -> V=12000±12, 首个 Task 后 S2  OK\n");

    /* 状态迁移：S2 -> S3 -> S2 -> S1 -> S0 -> S2（越级） */
    feed(0u, mv_to_raw(0u, 17000u), 8u);
    Vol_Task();
    CHECK(Vol_GetState(0u, &s) == VOL_OK && s == 3u);

    feed(0u, mv_to_raw(0u, 15000u), 8u);
    Vol_Task();
    CHECK(Vol_GetState(0u, &s) == VOL_OK && s == 2u);

    feed(0u, mv_to_raw(0u, 6800u), 8u);
    Vol_Task();
    CHECK(Vol_GetState(0u, &s) == VOL_OK && s == 1u);

    feed(0u, mv_to_raw(0u, 5000u), 8u);
    Vol_Task();
    CHECK(Vol_GetState(0u, &s) == VOL_OK && s == 0u);

    feed(0u, mv_to_raw(0u, 12000u), 8u);
    Vol_Task();
    CHECK(Vol_GetState(0u, &s) == VOL_OK && s == 2u);   /* S0 上行门限 6000，越级到 S2 */
    (void)printf("  S2->S3->S2->S1->S0->S2 全链迁移  OK\n");

    /* 窗口未满期间：Set 正常 OK，Get 拒绝 */
    Vol_Init();
    feed(0u, mv_to_raw(0u, 12000u), 3u);
    CHECK(Vol_GetVoltage(0u, &v) == VOL_E_NOT_READY);
    CHECK(v == 0u);
    Vol_Task();
    CHECK(Vol_GetState(0u, &s) == VOL_E_NOT_READY);
    (void)printf("  窗口未满：Set=OK / Get=E_NOT_READY+安全值  OK\n");
}

static void test_rbin_and_range(void)
{
    Vol_VoltageType v0 = 0u, v1 = 0u;
    uint8_t s = 0xFFu;

    (void)printf("-- 4. 仅测量通道与通道级量程 --\n");
    Vol_Init();

    /* 同一码值喂两通道：CH0 限幅 20000，CH1 输出 ~43542，互不影响 */
    feed(0u, 4095u, 8u);
    feed(1u, 4095u, 16u);
    CHECK(Vol_GetVoltage(0u, &v0) == VOL_OK && v0 == 20000u);
    CHECK(Vol_GetVoltage(1u, &v1) == VOL_OK && v1 >= 43540u && v1 <= 43544u);

    /* CH1 全流程：Task 跳过、GetState 恒 E_NO_STATE */
    Vol_Task();
    CHECK(Vol_GetState(1u, &s) == VOL_E_NO_STATE);
    CHECK(s == VOL_STATE_INVALID);

    /* CH0 状态不受 CH1 影响 */
    CHECK(Vol_GetState(0u, &s) == VOL_OK && s == 3u);
    (void)printf("  CH0=20000(限幅)/S3，CH1=43542(未截断)/E_NO_STATE  OK\n");

    /* 超 FS 码值：OK，由限幅兜住 */
    CHECK(Vol_SetAdcValue(0u, 65535u) == VOL_OK);
    CHECK(Vol_SetAdcValue(1u, 65535u) == VOL_OK);
    (void)printf("  超 FS 输入不报错，限幅兜底  OK\n");
}

static void test_reinit(void)
{
    Vol_VoltageType v = 0u;
    uint8_t s = 0xFFu;

    (void)printf("-- 5. 重初始化确定性 --\n");
    Vol_Init();
    feed(0u, mv_to_raw(0u, 12000u), 16u);
    feed(1u, mv_to_raw(1u, 21777u), 20u);
    Vol_Task();
    CHECK(Vol_GetVoltage(0u, &v) == VOL_OK);
    CHECK_NEAR(v, 12000u, 12u);

    /* 重新 Init：窗口清空、电压/状态复位，Get 全部回到未就绪 */
    Vol_Init();
    CHECK(Vol_GetVoltage(0u, &v) == VOL_E_NOT_READY && v == 0u);
    CHECK(Vol_GetState(0u, &s) == VOL_E_NOT_READY && s == VOL_STATE_INVALID);
    CHECK(Vol_GetVoltage(1u, &v) == VOL_E_NOT_READY);

    /* 同一序列重喂：结果与首次一致（无残留污染） */
    feed(0u, mv_to_raw(0u, 12000u), 16u);
    feed(1u, mv_to_raw(1u, 21777u), 20u);
    Vol_Task();
    CHECK(Vol_GetVoltage(0u, &v) == VOL_OK);
    CHECK_NEAR(v, 12000u, 12u);
    CHECK(Vol_GetState(0u, &s) == VOL_OK && s == 2u);
    CHECK(Vol_GetVoltage(1u, &v) == VOL_OK);
    CHECK_NEAR(v, 21777u, 12u);
    (void)printf("  重新 Init 后完全复位，重喂结果一致  OK\n");
}

int main(void)
{
    (void)printf("== test_api ==\n");
    test_not_init();
    test_exception_paths();
    test_end_to_end();
    test_rbin_and_range();
    test_reinit();

    if (g_fail != 0u)
    {
        (void)printf("== test_api: %u 项失败 ==\n", g_fail);
        return 1;
    }
    (void)printf("== test_api: 全部通过 ==\n");
    return 0;
}
