/**
 * @file    vol_sm.c
 * @brief   电压状态机实现（架构 §5.4）
 */
#include "vol_sm.h"

uint8_t Vol_Sm_Next(const Vol_StateCfgType *cfg, uint8_t num,
                    uint8_t cur, Vol_VoltageType v_mv)
{
    uint8_t target = cur;
    uint8_t i;
    int32_t v     = (int32_t)v_mv;
    int32_t up_th;
    int32_t dn_th;

    if (num == 0u)
    {
        return 0u;          /* 仅测量通道兜底：防 cfg[0] 越界与 num-1 下溢 */
    }

    for (i = 0u; i < num; i++)                  /* 定位标称区间，O(N)，N ≤ 8 */
    {
        if ((v >= (int32_t)cfg[i].lower_mv) && (v < (int32_t)cfg[i].upper_mv))
        {
            target = i;
            break;
        }
    }
    if (i == num)                               /* 越界取端点（区间外饱和） */
    {
        target = (v < (int32_t)cfg[0].lower_mv) ? 0u : (uint8_t)(num - 1u);
    }

    if (cur >= num)
    {
        return target;      /* 首次定位（cur = 0xFF）：不走迟滞，防 cfg[cur] 越界读 */
    }

    up_th = (int32_t)cfg[cur].upper_mv + (int32_t)cfg[cur].hyst_up_mv;
    dn_th = (int32_t)cfg[cur].lower_mv - (int32_t)cfg[cur].hyst_down_mv;

    if ((target > cur) && (v >= up_th))
    {
        return target;                          /* 上行，可跨多级 */
    }
    if ((target < cur) && (v <= dn_th))
    {
        return target;                          /* 下行，可跨多级 */
    }
    return cur;                                 /* 迟滞不动作带内，保持 */
}
