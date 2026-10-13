/**
 * Escape 键判定 —— 「是不是一次该被处理的 Escape」的唯一事实源。
 *
 * spec: docs/editor/浮层堆栈管理.md（核心规则 7「IME 组合期不派发」、守卫边界）。
 *
 * 为什么单独成文件并从包入口导出：
 * - `guard:escape-stack` 阻断其余路径上的 Escape 字面量比较，本目录是唯一豁免的事实源；
 *   判定逻辑必须只有一份，否则「哪些 Escape 算 Escape」会出现第二个口径。
 * - 画布基底（核心规则 4 的栈外唯一合法消费面）也必须经本函数判定，不得自行写
 *   `event.key === 'Escape'` —— 那会被守卫按绕栈判定报红。
 */

/** 判定 Escape 所需的事件最小形状（`KeyboardEvent` 的结构子集，便于非 DOM 场景复用）。 */
export interface EscapeKeyEventLike {
  /** `KeyboardEvent.key`。 */
  key: string
  /** 输入法组合期标记（核心规则 7）：Esc 在此语境是取消候选词，不属于浮层开合语义。 */
  isComposing?: boolean
  /** 组合期兜底信号：部分浏览器组合期 `isComposing` 为 false 而 `keyCode` 为 229。 */
  keyCode?: number
}

/** 是否是一次应被处理的 Escape 按键（键名匹配且不在 IME 组合期）。 */
export function isEscapeEvent(event: EscapeKeyEventLike): boolean {
  if (event.key !== "Escape") return false
  if (event.isComposing === true) return false
  if (event.keyCode === 229) return false
  return true
}
