/**
 * @file    HelpPanel.tsx
 * @brief   页面顶部的使用帮助（在"模块参数"之上）。默认折叠——它是查手册用的，不该占首屏。
 *
 * 放最上面是为了"第一次打开就能看见有这么个东西"，但收起后只占一行，
 * 不挤压下面的配置表单。
 * 内容只写"点开下载之后要做什么"，不重复界面本身能看到的字段含义。
 * 每条都对着真实符号名（Vol_SetAdcValue / VOL_CRITICAL_ENTER / c7_CH0_2），
 * 免得读者还要回去翻 ReadMe 对号。
 */
export function HelpPanel() {
  return (
    <section className="card">
      <details className="details help">
        <summary>
          使用帮助
          <span className="muted">
            文件放哪 · 临界区宏 · ADC 怎么喂数 · 编译报错怎么对回本工具
          </span>
        </summary>

        <div className="help-body">
          <h3>1. 三份文件的分工</h3>
          <table className="help-table">
            <thead>
              <tr>
                <th>文件</th>
                <th>性质</th>
                <th>放哪</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>vol_cfg.yaml</code>
                </td>
                <td>
                  <b>配置唯一真源</b>，与代码一起入库
                </td>
                <td>工程里任意位置（建议与两份 C 文件同目录，便于对照）</td>
              </tr>
              <tr>
                <td>
                  <code>vol_cfg.h</code>
                </td>
                <td>生成物，勿手改</td>
                <td>
                  Lib_VolM 的 <code>inc/</code>
                </td>
              </tr>
              <tr>
                <td>
                  <code>vol_cfg.c</code>
                </td>
                <td>生成物，勿手改</td>
                <td>
                  Lib_VolM 的 <code>src/</code>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="help-note">
            改配置=导入 yaml → 改 → 重新下载两份覆盖。手改 C 文件会在下次生成时被整份覆盖，
            而 yaml 里没有的东西（比如你临时改的迟滞）也就丢了。
          </p>

          <h3>2. 接进工程</h3>
          <ul>
            <li>
              源文件加 5 个：<code>vol.c</code>、<code>vol_calc.c</code>、<code>vol_filt.c</code>、
              <code>vol_sm.c</code>、<code>vol_cfg.c</code>（<code>vol_cfg.c</code> 就是生成的那份）。
            </li>
            <li>
              头文件路径加 <code>inc/</code> 与 <code>src/</code>（<code>src/</code> 里是内部头，库自己用）。
            </li>
            <li>
              初始化一次 <code>Vol_Init()</code>，之后按下面的节奏喂数据；<code>vol_cfg.c</code>{' '}
              里全是编译期常量，没有初始化函数要调。
            </li>
          </ul>

          <h3>3. 临界区宏怎么填</h3>
          <p>
            默认是空宏，适用于 <code>Vol_SetAdcValue</code> 与 <code>Vol_Task</code>{' '}
            <b>在同一上下文</b>调用（全在主循环里）。只要采样在 ADC 中断、任务在主循环，就必须给实现：
          </p>
          <pre className="help-code">{`/* 在工程配置里覆盖（不要改生成文件） */
#define VOL_CRITICAL_ENTER()   __disable_irq()
#define VOL_CRITICAL_EXIT()    __enable_irq()`}</pre>
          <ul>
            <li>成对出现，库内部保证成对；只覆盖宏，不要在外面再套一层中断开关。</li>
            <li>
              临界区里只做递增/拷贝，不阻塞、不调用别的驱动；若用 RTOS，换成{' '}
              <code>taskENTER_CRITICAL()</code> / <code>taskEXIT_CRITICAL()</code>。
            </li>
            <li>
              若采样中断优先级高于调用 <code>Vol_Task</code> 的任务，且两者都访问同一个{' '}
              <code>filt_buf</code>，这里就是唯一的保护点，不能省。
            </li>
          </ul>

          <h3>4. ADC 怎么喂数据</h3>
          <pre className="help-code">{`/* ADC 转换完成中断（每个采样点一次） */
Vol_SetAdcValue(ch, raw_code);      /* 传原始码值，不要自己换算成 mV */

/* 主循环 / OS 任务，周期 = 上面的"采样周期" */
Vol_Task();

/* 取结果 */
Vol_VoltageType mv;
Vol_GetVoltage(ch, &mv);            /* 滤波后的电压，mV */
uint8_t st;
Vol_GetState(ch, &st);              /* 当前状态号；仅测量通道返回 VOL_E_NO_STATE */`}</pre>
          <ul>
            <li>
              <b>码值不要预换算</b>：分压比、参考电压、增益偏置残差都已经折进{' '}
              <code>scale_q16</code>，二次换算会重复补偿。
            </li>
            <li>
              <code>Vol_Task</code> 的调用周期应与本页"采样周期"一致——<code>by_time</code>{' '}
              模式的窗口点数就是按它折算的，改周期要回来改配置。
            </li>
            <li>仅测量通道（状态数 0，如 RBIN）只出电压，<code>Vol_GetState</code> 会返回错误码。</li>
          </ul>

          <h3>5. 编译报错怎么对回本工具</h3>
          <p>
            库的断言 tag 与工具里的规则号一一对应，报错信息里直接带 tag。例如 IAR/gcc 报{' '}
            <code>c7_CH0_2</code>：
          </p>
          <pre className="help-code">{`vol_cfg.c(120): error: negative array size … c7_CH0_2
                                   ↑ 规则 C7：第 0 通道、索引 2 的那条迟滞越界`}</pre>
          <table className="help-table">
            <thead>
              <tr>
                <th>tag</th>
                <th>工具规则</th>
                <th>含义</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>c1_*</code>
                </td>
                <td>C1</td>
                <td>状态数超过容量上限</td>
              </tr>
              <tr>
                <td>
                  <code>c3_/c4_/c5_/c6_</code>
                </td>
                <td>C3~C6</td>
                <td>区间覆盖与衔接（工具按模型构造，正常不会单独违反）</td>
              </tr>
              <tr>
                <td>
                  <code>c7_*</code>
                </td>
                <td>C7</td>
                <td>迟滞越界：进不去或保持不住</td>
              </tr>
              <tr>
                <td>
                  <code>c8_/c9_/c10_/c11_</code>
                </td>
                <td>C8~C11</td>
                <td>滤波窗口 / 除零与截断 / 首末外侧迟滞 / 配置量闭区间</td>
              </tr>
            </tbody>
          </table>
          <p className="help-note">
            工具里"错误"列表点一条就会跳到对应输入框——所以更推荐在这里改到 0 错误再下载，
            而不是拿编译器的报错回来找。
          </p>

          <h3>6. 版本与兼容</h3>
          <ul>
            <li>
              <code>vol_cfg.yaml</code> 里的 <code>schema</code> 是<b>格式号</b>，决定兼容性；
              <code>generator</code> 段只是"谁生成的"记录，可省略。
            </li>
            <li>
              <b>向下兼容、不向上兼容</b>：新工具能读旧 yaml（自动升级），旧工具读到新格式会直接报错拒绝，
              不会猜着读出一份错的配置。
            </li>
            <li>
              生成的 C 文件头带工具版本与生成日期（精确到天），便于追溯是哪一版生成的。
            </li>
          </ul>
        </div>
      </details>
    </section>
  );
}
