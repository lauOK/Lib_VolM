/**
 * @file    vol_types.h
 * @brief   Lib_VolM 基础类型定义（全部模块可见）
 *
 * 平台约束：仅依赖 <stdint.h>，C99，无浮点、无动态内存。
 * 电压统一为 uint16_t mV（见架构 D3）；电压恒非负，故用无符号类型。
 */
#ifndef VOL_TYPES_H
#define VOL_TYPES_H

#include <stdint.h>

/** 电压值，单位 mV（0 .. 65535） */
typedef uint16_t Vol_VoltageType;

/** ADC 原始码值（0 .. ADC_FS） */
typedef uint16_t Vol_AdcValueType;

/** 滤波缓冲样本，单位 mV（与电压同域，见架构 §5.1） */
typedef uint16_t Vol_FilterSampleType;

/**
 * 无效状态值。
 * 三种情形均输出该值：未初始化、滤波窗口未满、仅测量通道（RBIN）。
 */
#define VOL_STATE_INVALID   ((uint8_t)0xFFu)

/** 接口返回码（架构 §6.2） */
typedef enum
{
    VOL_OK = 0,         /**< 成功 */
    VOL_E_NOT_INIT,     /**< 未调用 Vol_Init */
    VOL_E_PARAM,        /**< 通道号越界 / 输出指针为 NULL */
    VOL_E_NOT_READY,    /**< 该通道滤波窗口未填满，电压/状态尚无效 */
    VOL_E_NO_STATE      /**< 该通道为仅测量通道（state_num == 0），不提供状态 */
} Vol_ReturnType;

#endif /* VOL_TYPES_H */
