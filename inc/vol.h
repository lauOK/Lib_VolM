/**
 * @file    vol.h
 * @brief   Lib_VolM 对外接口（严格 5 个，架构 §6）
 *
 * 典型集成：
 *     上电          → Vol_Init()
 *     ADC 完成中断  → Vol_SetAdcValue(ch, raw)      每采样点调用一次
 *     主循环/OS Task→ Vol_Task()                    5~10 ms 周期调用
 *     应用逻辑      → Vol_GetVoltage() / Vol_GetState()   按需查询
 */
#ifndef VOL_H
#define VOL_H

#include "vol_types.h"
#include "vol_cfg.h"

/**
 * @brief   库版本，与 doc/VolM_Architecture.md 的文档修订号保持一致。
 *
 * 这是库的**能力版本**：接口、宏含义、状态机语义有变化才升。
 * 它与另外两个版本号是彼此独立的：
 *
 *     VOL_VERSION       V1.4         库能力（本宏）
 *     volm-cfg/N        volm-cfg/1   配置文件字段格式
 *     vol-cfg-tool      v0.2.0       配置工具发布号
 *
 * vol-cfg-tool 生成 vol_cfg.h / vol_cfg.c 时会把本版本写进文件头的 @note 行，
 * 现场反馈"这份配置是哪版库的"时直接看文件即可。工具侧的 LIB_VERSION 由
 * tests/version.test.ts 读本宏校验，两边不一致会让测试变红。
 *
 * 升版步骤：改这里 → 同步 doc/VolM_Architecture.md 修订记录 → 改工具 LIB_VERSION。
 */
#define VOL_VERSION_MAJOR   1
#define VOL_VERSION_MINOR   4
#define VOL_VERSION_STRING  "1.4"

/**
 * @brief  初始化：复位全部通道的滤波缓冲、计数、电压与状态。
 * @note   必须在其他接口之前调用；重复调用是幂等的。
 *         本函数返回前，其他接口一律返回 VOL_E_NOT_INIT。
 */
void Vol_Init(void);

/**
 * @brief  周期任务：逐通道执行电压状态机判定。
 * @note   仅测量通道（state_num == 0）被直接跳过。未初始化时直接返回。
 */
void Vol_Task(void);

/**
 * @brief  写入某通道的 ADC 采样码值（换算 + 入窗 + 更新电压）。
 * @param  ch   通道号，0 .. VOL_CHANNEL_NUM-1
 * @param  adc  ADC 原始码值；大于 ADC_FS 时按满量程换算后由限幅兜住
 * @return VOL_OK / VOL_E_NOT_INIT / VOL_E_PARAM
 */
Vol_ReturnType Vol_SetAdcValue(uint8_t ch, Vol_AdcValueType adc);

/**
 * @brief  读取某通道当前电压。
 * @param  ch     通道号
 * @param  v_mv   输出：电压，单位 mV；出错时写 0
 * @return VOL_OK / VOL_E_NOT_INIT / VOL_E_PARAM / VOL_E_NOT_READY（窗口未满）
 */
Vol_ReturnType Vol_GetVoltage(uint8_t ch, Vol_VoltageType *v_mv);

/**
 * @brief  读取某通道当前电压状态。
 * @param  ch     通道号
 * @param  state  输出：0 .. state_num-1；无效时为 VOL_STATE_INVALID(0xFF)
 * @return VOL_OK / VOL_E_NOT_INIT / VOL_E_PARAM / VOL_E_NO_STATE / VOL_E_NOT_READY
 */
Vol_ReturnType Vol_GetState(uint8_t ch, uint8_t *state);

#endif /* VOL_H */
