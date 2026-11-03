/**
 * @file    vol_calc.h
 * @brief   ADC 码值 → 真实电压（mV）换算，定点实现，无浮点
 *
 * 内部模块，仅供 vol.c 调用；应用不直接使用。
 */
#ifndef VOL_CALC_H
#define VOL_CALC_H

#include "vol_cfg.h"

/**
 * @brief  把一个 ADC 采样码值换算为该通道的真实电压。
 *
 * 换算链（架构 §4.1）：引脚电压 → 还原分压 → 增益标定 → 偏置标定 → 限幅 → 取整。
 * 前三步已由 VOL_CH_SCALE_Q16 在编译期合成为 Q16 定点系数，运行时只有
 * 1 次 64 位乘、1 次右移、1 次加法、1 次限幅、1 次除 1000。
 *
 * @param  cfg  通道配置（非 NULL，由调用方保证）
 * @param  adc  ADC 码值；大于 ADC_FS 时按实际码值换算，最终由限幅兜住
 * @return 电压，单位 mV，已限幅到 [0, cfg->voltage_max_mv]
 */
Vol_VoltageType Vol_Calc_Convert(const Vol_ChannelCfgType *cfg, Vol_AdcValueType adc);

#endif /* VOL_CALC_H */
