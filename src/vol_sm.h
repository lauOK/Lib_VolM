/**
 * @file    vol_sm.h
 * @brief   电压状态机：上下行独立迟滞的区间判定（纯函数）
 *
 * 内部模块，仅供 vol.c 调用；应用不直接使用。
 *
 * 语义（架构 §5.2/§5.4）：
 *  - 状态表按电压升序，区间 [lower, upper) 无缝衔接，覆盖 [0, 量程]；
 *  - 上行门限 = 当前状态 upper + hyst_up；下行门限 = 当前状态 lower - hyst_down；
 *  - 允许越级跳变：目标区间与当前状态之间可以相隔多级，一步到达；
 *  - 首帧（cur >= num，即 Init 后的 0xFF）不做迟滞，直接落位到电压所在区间。
 */
#ifndef VOL_SM_H
#define VOL_SM_H

#include "vol_cfg.h"

/**
 * @brief  计算电压状态迁移的下一状态。
 *
 * 纯函数：只依赖入参与配置表，无全局状态、无副作用。
 *
 * @param  cfg   状态配置表（非 NULL；num == 0 时不解引用）
 * @param  num   状态个数；0 表示仅测量通道（返回 0 兜底，正常路径由
 *               Vol_Task 先行跳过，不会走到这里）
 * @param  cur   当前状态；Init 后首帧为 0xFF（>= num），走"直接落位"
 * @param  v_mv  滤波后的电压，mV（已限幅到通道量程内）
 * @return 下一状态，0 .. num-1
 */
uint8_t Vol_Sm_Next(const Vol_StateCfgType *cfg, uint8_t num,
                    uint8_t cur, Vol_VoltageType v_mv);

#endif /* VOL_SM_H */
