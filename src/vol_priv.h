/**
 * @file    vol_priv.h
 * @brief   运行期通道上下文（纯内部，应用不可见，架构 §3.4 类型归属）
 *
 * 上下文由 vol.c 独占持有；滤波游标/运行和放在 Vol_FiltCtxType
 * （见 vol_filt.h），本结构只追加电压与状态两个输出量。
 */
#ifndef VOL_PRIV_H
#define VOL_PRIV_H

#include "vol_cfg.h"
#include "vol_filt.h"

typedef struct
{
    Vol_FiltCtxType filt;       /**< 滤波上下文（游标 + 运行和） */
    Vol_VoltageType v_mv;       /**< 最近一次滤波输出，mV */
    uint8_t         state;      /**< 状态机输出；Init 后为首帧前 0xFF */
} Vol_CtxType;

extern Vol_CtxType Vol_Ctx[VOL_CHANNEL_NUM];

#endif /* VOL_PRIV_H */
