/**
 * @file    vol_filt.h
 * @brief   mV 域滑动均值滤波（环形缓冲 + 运行和，O(1)/样本）
 *
 * 内部模块，仅供 vol.c 调用；应用不直接使用。
 *
 * 工作域：滤波在限幅后的 mV 域进行（架构 §5.1），缓冲样本与电压同为
 * uint16 mV。均值 = sum / count，整数除法向下取整；窗口填满后 count
 * 恒等于 window，除法退化为 sum / window。
 *
 * 溢出边界：window ≤ VOL_FILTER_WINDOW_MAX(1024)、单样本 ≤ 65535 mV，
 * sum 最大 65535 × 1024 ≈ 6.71e7，远小于 2^32，uint32 运行和无回绕风险。
 */
#ifndef VOL_FILT_H
#define VOL_FILT_H

#include "vol_cfg.h"

/**
 * 滤波运行期上下文（每通道一个，由上层持有并保证生命周期）。
 * 缓冲本体在配置表中（cfg->filt_buf），上下文只持游标与运行和。
 */
typedef struct
{
    uint32_t sum;   /**< 窗口内有效样本之和（mV） */
    uint16_t idx;   /**< 下一个写入位置（0 .. window-1） */
    uint16_t count; /**< 已入窗样本数，饱和于 window */
} Vol_FiltCtxType;

/**
 * @brief  复位滤波上下文到"空窗"状态。
 *
 * 清游标、运行和，并将缓冲整块清零。清零不可省略：重复 Init（不掉电
 * 重新初始化）后缓冲含上次会话残留值，首次 Input 的"减旧样本"会下溢。
 * 仅在 Vol_Init 期调用，window ≤ 1024，开销可接受。
 *
 * @param  ctx  滤波上下文（非 NULL）
 * @param  cfg  通道配置（非 NULL）
 */
void Vol_Filt_Reset(Vol_FiltCtxType *ctx, const Vol_ChannelCfgType *cfg);

/**
 * @brief  送入一个已换算的 mV 样本，返回当前均值。
 *
 * 环形写入 + 运行和增量更新，单次调用为常数开销：
 * 1 次减（被覆盖旧值）、1 次加（新值）、1 次除（均值）。
 *
 * @param  ctx        滤波上下文（非 NULL）
 * @param  cfg        通道配置（非 NULL）
 * @param  sample_mv  已换算并限幅的电压样本，mV
 * @return 当前滤波输出：窗口未满时为 sum/count（部分均值），填满后为 sum/window
 */
Vol_VoltageType Vol_Filt_Input(Vol_FiltCtxType *ctx,
                               const Vol_ChannelCfgType *cfg,
                               Vol_VoltageType sample_mv);

/**
 * @brief  窗口是否已填满（输出是否有效）。
 * @retval 非 0：已填满，滤波输出有效
 * @retval 0    ：未填满
 */
uint8_t Vol_Filt_IsReady(const Vol_FiltCtxType *ctx, const Vol_ChannelCfgType *cfg);

/**
 * @brief  读取当前滤波输出（不改变状态）。
 * @return 当前均值，mV；语义与 Vol_Filt_Input 的返回值一致
 */
Vol_VoltageType Vol_Filt_Output(const Vol_FiltCtxType *ctx,
                                const Vol_ChannelCfgType *cfg);

#endif /* VOL_FILT_H */
