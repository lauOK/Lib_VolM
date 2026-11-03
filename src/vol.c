/**
 * @file    vol.c
 * @brief   对外接口层 / 通道调度层（架构 §6 / §7）
 *
 * 上下文约定：
 *  - Vol_SetAdcValue 设计为可在 ADC 采样中断中调用（高频、各通道独立速率）；
 *  - Vol_Task 在主循环 / OS 任务中周期调用（状态判定频率由 Task 周期决定）；
 *  - 两者共享环形缓冲与运行和，跨上下文时段用 VOL_CRITICAL_ENTER/EXIT 保护
 *    （默认空宏，见 vol_cfg.h）。保护范围：Set 侧"写缓冲 + 更新 sum/count/v_mv"
 *    整段，Task 侧"读 v_mv + 写 state"整段——只锁单字段会读到中间态。
 *  - Get 类接口只做一次对齐的 uint16/uint8 读取，32 位目标上天然原子，不加锁。
 *
 * 初始化时序：initialized 标志最后置位。首次 Init 前到来的采样一律被
 * E_NOT_INIT 拒绝，不会触碰半初始化上下文，故 Vol_Init 无需关中断。
 * 注意：运行中重初始化（不掉电）时，应用必须先停采样源再调 Vol_Init，
 * 否则存在与采样路径的竞争（架构 §10 应用侧约束）。
 */
#include <stddef.h>

#include "vol.h"
#include "vol_calc.h"
#include "vol_filt.h"
#include "vol_sm.h"
#include "vol_priv.h"

/** 模块初始化标志；置位必须是 Vol_Init 的最后一步 */
static uint8_t vol_initialized = 0u;

Vol_CtxType Vol_Ctx[VOL_CHANNEL_NUM];

void Vol_Init(void)
{
    uint8_t ch;

    for (ch = 0u; ch < (uint8_t)VOL_CHANNEL_NUM; ch++)
    {
        Vol_Filt_Reset(&Vol_Ctx[ch].filt, &Vol_ChannelCfgTable[ch]);
        Vol_Ctx[ch].v_mv   = 0u;
        Vol_Ctx[ch].state  = VOL_STATE_INVALID;
    }

    vol_initialized = 1u;       /* 最后置位（架构 §7） */
}

void Vol_Task(void)
{
    uint8_t ch;

    if (vol_initialized == 0u)
    {
        return;                 /* void 接口，未初始化直接返回（架构 §6.5） */
    }

    for (ch = 0u; ch < (uint8_t)VOL_CHANNEL_NUM; ch++)
    {
        const Vol_ChannelCfgType *cfg = &Vol_ChannelCfgTable[ch];
        Vol_CtxType             *ctx = &Vol_Ctx[ch];

        if (cfg->state_num == 0u)
        {
            continue;           /* 仅测量通道：不触碰状态表（C12 兜底） */
        }
        if (Vol_Filt_IsReady(&ctx->filt, cfg) == 0u)
        {
            continue;           /* 窗口未满，状态维持 0xFF（D4） */
        }

        VOL_CRITICAL_ENTER();
        ctx->state = Vol_Sm_Next(cfg->state_cfg, cfg->state_num,
                                 ctx->state, ctx->v_mv);
        VOL_CRITICAL_EXIT();
    }
}

Vol_ReturnType Vol_SetAdcValue(uint8_t ch, Vol_AdcValueType adc)
{
    Vol_VoltageType mv;

    if (vol_initialized == 0u)
    {
        return VOL_E_NOT_INIT;
    }
    if (ch >= (uint8_t)VOL_CHANNEL_NUM)
    {
        return VOL_E_PARAM;
    }

    /* 换算是纯函数，只读配置表，无需临界区 */
    mv = Vol_Calc_Convert(&Vol_ChannelCfgTable[ch], adc);

    VOL_CRITICAL_ENTER();
    Vol_Ctx[ch].v_mv = Vol_Filt_Input(&Vol_Ctx[ch].filt,
                                      &Vol_ChannelCfgTable[ch], mv);
    VOL_CRITICAL_EXIT();

    return VOL_OK;
}

Vol_ReturnType Vol_GetVoltage(uint8_t ch, Vol_VoltageType *v_mv)
{
    if (vol_initialized == 0u)
    {
        return VOL_E_NOT_INIT;
    }
    if (v_mv == NULL)           /* 先判指针，再判通道号（架构 §6.5） */
    {
        return VOL_E_PARAM;
    }
    if (ch >= (uint8_t)VOL_CHANNEL_NUM)
    {
        return VOL_E_PARAM;
    }
    if (Vol_Filt_IsReady(&Vol_Ctx[ch].filt, &Vol_ChannelCfgTable[ch]) == 0u)
    {
        *v_mv = 0u;             /* 安全值（架构 §6.5 / D9） */
        return VOL_E_NOT_READY;
    }

    *v_mv = Vol_Ctx[ch].v_mv;
    return VOL_OK;
}

Vol_ReturnType Vol_GetState(uint8_t ch, uint8_t *state)
{
    if (vol_initialized == 0u)
    {
        return VOL_E_NOT_INIT;
    }
    if (state == NULL)
    {
        return VOL_E_PARAM;
    }
    if (ch >= (uint8_t)VOL_CHANNEL_NUM)
    {
        return VOL_E_PARAM;
    }
    if (Vol_ChannelCfgTable[ch].state_num == 0u)
    {
        *state = VOL_STATE_INVALID;
        return VOL_E_NO_STATE;  /* 先判无状态，再判未就绪（架构 §6.5） */
    }
    if (Vol_Filt_IsReady(&Vol_Ctx[ch].filt, &Vol_ChannelCfgTable[ch]) == 0u)
    {
        *state = VOL_STATE_INVALID;
        return VOL_E_NOT_READY;
    }

    /* 已知瞬态：窗口刚满、首个 Vol_Task 尚未运行时，此处返回 VOL_OK 且
     * *state == 0xFF（VOL_STATE_INVALID 自描述"尚无有效状态"），
     * 一个 Task 周期后消失。应用判状态时按 "!= VOL_STATE_INVALID" 处理。 */
    *state = Vol_Ctx[ch].state;
    return VOL_OK;
}
