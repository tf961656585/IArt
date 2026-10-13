/**
 * 浮层栈注册表 —— Esc 分发的唯一事实源。
 *
 * spec: docs/editor/浮层堆栈管理.md（「契约」「核心规则」「退役清单」）。
 *
 * 设计要点：
 * - 纯模块级状态（不可变数组），不引入任何状态库，也不提供订阅/版本号——
 *   Esc 派发是命令式读栈（`getTopOverlayLayer`），没有任何「随栈变化重渲染」的消费者；
 *   半成品的订阅 API 只会让人以为栈是响应式事实源。
 *   栈按 BrowserWindow 的 JS 上下文天然隔离：Hub 与 Editor 各自持有一份本模块实例。
 * - 只暴露声明式注册（`registerOverlayLayer`）与栈顶查询（`getTopOverlayLayer`），
 *   不提供命令式 push/pop（spec 核心规则 2：命令式生命周期是泄漏与幽灵层的来源）。
 * - 层条目里的 `onClose` 存放于可变槽位（`onCloseSlot`）：React 侧每次渲染只更新槽位，
 *   回调身份变化不触发重排栈（spec「契约」对 `useOverlayLayer` 的要求）。
 */

/** 层配置项。`id` 窗口内唯一，用于调试与守卫日志定位（spec「契约」）。 */
export interface OverlayLayerConfig {
  id: string
  /** Esc 命中栈顶时的关闭动作。 */
  onClose: () => void
  /** 默认 true。false = 模态禁 Esc：消费事件但不关闭（spec 核心规则 5）。 */
  closeOnEscape?: boolean
  /** 默认 false。true = 焦点在可编辑元素内时消费但不关闭（spec 核心规则 5）。 */
  ignoreWhenFocusInEditable?: boolean
}

/**
 * 归一化后的层条目：默认值已落定，`onClose` 走可变槽位。
 * @internal 包内结构，不作为公共契约导出。
 */
export interface OverlayLayerEntry {
  readonly id: string
  readonly closeOnEscape: boolean
  readonly ignoreWhenFocusInEditable: boolean
  readonly onCloseSlot: { current: () => void }
}

/** 栈：自底向上 = 打开顺序，末位为栈顶。整体替换保证引用稳定。 */
let stack: readonly OverlayLayerEntry[] = []

/**
 * 入栈或重注册一条层条目。
 *
 * 同 id 重复注册：先注销旧条目再入栈，新条目落在栈顶（spec「契约」）。
 * 返回注销函数；同一注销函数重复调用无副作用（幂等）。
 * @internal 供本包 React 侧与命令式入口共用。
 */
export function registerOverlayLayerEntry(entry: OverlayLayerEntry): () => void {
  stack = [...stack.filter((item) => item.id !== entry.id), entry]

  let live = true
  return () => {
    if (!live) return
    live = false
    const next = stack.filter((item) => item !== entry)
    if (next.length === stack.length) return
    stack = next
  }
}

/** 命令式注册（非 React 场景与测试使用）；返回注销函数。 */
export function registerOverlayLayer(config: OverlayLayerConfig): () => void {
  return registerOverlayLayerEntry({
    id: config.id,
    closeOnEscape: config.closeOnEscape ?? true,
    ignoreWhenFocusInEditable: config.ignoreWhenFocusInEditable ?? false,
    onCloseSlot: { current: config.onClose },
  })
}

/**
 * 栈顶层配置；栈空返回 null。
 *
 * 返回的 `onClose` 每次调用都读槽位当前值，因此层组件重渲染换掉回调后，
 * 分发器拿到的仍是同一层的「最新回调」。
 */
export function getTopOverlayLayer(): OverlayLayerConfig | null {
  const top = stack[stack.length - 1]
  if (top === undefined) return null
  return {
    id: top.id,
    closeOnEscape: top.closeOnEscape,
    ignoreWhenFocusInEditable: top.ignoreWhenFocusInEditable,
    onClose: () => {
      top.onCloseSlot.current()
    },
  }
}
