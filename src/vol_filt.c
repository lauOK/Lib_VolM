/**
 * @file    vol_filt.c
 * @brief   mV 域滑动均值滤波实现
 */
#include "vol_filt.h"

void Vol_Filt_Reset(Vol_FiltCtxType *ctx, const Vol_ChannelCfgType *cfg)
{
    uint16_t i;

    /* 缓冲必须清零：重复 Init（不掉电重初始化）后缓冲含上次会话的残留值，
     * 若不清零，首次 Input 的 sum -= buf[0] 会在 sum==0 时下溢回绕。
     * 仅 Init 期执行，window ≤ 1024，开销可接受。 */
    for (i = 0u; i < cfg->window; i++)
    {
        cfg->filt_buf[i] = 0u;
    }

    ctx->sum   = 0u;
    ctx->idx   = 0u;
    ctx->count = 0u;
}

Vol_VoltageType Vol_Filt_Input(Vol_FiltCtxType *ctx,
                               const Vol_ChannelCfgType *cfg,
                               Vol_VoltageType sample_mv)
{
    uint16_t *buf = cfg->filt_buf;

    /* 减去将被覆盖的旧样本（空窗位置内容为 0 语义：未 Reset 过的缓冲
     * 可能含残留值，但 count < window 时旧值必为 0 或尚未计入 sum，
     * 这里直接按"位置原值"扣减即可，两次 Init/Reset 之间由上层保证串行） */
    ctx->sum -= (uint32_t)buf[ctx->idx];
    buf[ctx->idx] = sample_mv;
    ctx->sum     += (uint32_t)sample_mv;

    ctx->idx++;
    if (ctx->idx >= cfg->window)
    {
        ctx->idx = 0u;
    }

    if (ctx->count < cfg->window)
    {
        ctx->count++;
    }

    return Vol_Filt_Output(ctx, cfg);
}

uint8_t Vol_Filt_IsReady(const Vol_FiltCtxType *ctx, const Vol_ChannelCfgType *cfg)
{
    return (ctx->count >= cfg->window) ? (uint8_t)1u : (uint8_t)0u;
}

Vol_VoltageType Vol_Filt_Output(const Vol_FiltCtxType *ctx,
                                const Vol_ChannelCfgType *cfg)
{
    (void)cfg; /* 除数用 count：填满后恒等于 window，无需读配置 */
    /* 窗口未满时输出部分均值，填满后为标准滑动均值。
     * sum ≤ 65535×1024 < 2^32，无溢出。 */
    return (Vol_VoltageType)(ctx->sum / (uint32_t)ctx->count);
}
