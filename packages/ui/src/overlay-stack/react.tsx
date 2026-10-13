"use client"

/**
 * 浮层栈的 React 接入面：声明式注册 hook 与每窗口唯一的 Esc 分发器。
 *
 * spec: docs/editor/浮层堆栈管理.md（「契约」「核心规则」）。
 */

import * as React from "react"

import { isEditableTarget } from "./editable-target"
import { isEscapeEvent } from "./escape-key"
import {
  getTopOverlayLayer,
  registerOverlayLayerEntry,
  type OverlayLayerConfig,
} from "./registry"

/** 消费：preventDefault + stopImmediatePropagation（spec「术语定义 → 消费」）。 */
function consumeEscape(event: KeyboardEvent): void {
  event.preventDefault()
  // stopImmediatePropagation 是断链的关键：Radix 在 document 捕获阶段也有监听，
  // 只 stopPropagation 挡不住同节点上的其他监听者。
  event.stopImmediatePropagation()
}

/** 派发算法（spec「契约 → 派发行为」）。 */
function dispatchOverlayEscape(event: KeyboardEvent): void {
  // 键名与 IME 组合期判定收敛在 escape-key.ts（唯一判定 owner，含核心规则 7）。
  if (!isEscapeEvent(event)) return

  // 前置消费不二次派发（核心规则 8）：给未注册的第三方监听让位。
  if (event.defaultPrevented) return

  const top = getTopOverlayLayer()
  // 栈空透传（核心规则 4）：不消费，落回画布基底语义。
  if (top === null) return

  // 两种「消费不关闭」（核心规则 5）：输入焦点让位 / 模态禁 Esc。
  if (top.ignoreWhenFocusInEditable && isEditableTarget(event.target)) {
    consumeEscape(event)
    return
  }
  if (!top.closeOnEscape) {
    consumeEscape(event)
    return
  }

  consumeEscape(event)
  top.onClose()
}

/**
 * 声明式注册：`active` 翻转驱动入栈/出栈，组件卸载自动注销。
 *
 * - `onClose` 存于槽位（ref），回调身份变化不重新注册 —— 否则每次渲染都会把层顶到栈顶，
 *   打开顺序被重排（spec「契约」）。
 * - `closeOnEscape` / `ignoreWhenFocusInEditable` 先归一化默认值再作为 effect 依赖：
 *   传 `undefined` 与传默认值是同一语义，不应触发重注册。
 */
export function useOverlayLayer(config: OverlayLayerConfig & { active: boolean }): void {
  const { active, id } = config
  const closeOnEscape = config.closeOnEscape ?? true
  const ignoreWhenFocusInEditable = config.ignoreWhenFocusInEditable ?? false

  const onCloseSlot = React.useRef(config.onClose)
  React.useEffect(() => {
    onCloseSlot.current = config.onClose
  })

  React.useEffect(() => {
    if (!active) return
    return registerOverlayLayerEntry({
      id,
      closeOnEscape,
      ignoreWhenFocusInEditable,
      onCloseSlot,
    })
  }, [active, id, closeOnEscape, ignoreWhenFocusInEditable])
}

/** 本窗口当前持有分发器的标记；`null` 表示无分发器。 */
let dispatcherOwner: object | null = null
let duplicateDispatcherWarned = false

function warnDuplicateDispatcher(): void {
  if (duplicateDispatcherWarned) return
  duplicateDispatcherWarned = true
  const isProduction =
    typeof process !== "undefined" && process.env.NODE_ENV === "production"
  if (isProduction) return
  console.warn(
    "[overlay-stack] OverlayEscapeDispatcher 重复挂载：已忽略后挂载者，Esc 仍由先挂载的分发器派发。" +
      "每个窗口只应在 React 根部挂载一次（spec 核心规则 1「单点分发」）。",
  )
}

/**
 * Esc 分发器：挂在窗口 React 根部一次，不渲染任何 DOM。
 *
 * 监听在**挂载时**就位（不随栈空栈满装卸），原因有二：
 * 1. 栈空时它读栈返回不消费，画布基底语义拿到的仍是干净事件（核心规则 4）；
 * 2. Radix 的 Esc 监听同样是 document 捕获阶段，同节点监听按注册顺序触发。
 *    分发器在窗口根部、应用启动时挂载，而 Radix 浮层打开时才注册自己的监听，
 *    因此分发器天然排在前面，能抢先用 stopImmediatePropagation 截断事件。
 *    若改成「栈非空才挂监听」，浮层打开时会晚于自身 Radix 监听注册，截断失效。
 *
 * 重复挂载：开发态告警并忽略后挂载者（核心规则 1）。后挂者不会在拥有者卸载后接管
 * （其 effect 只在挂载时执行一次）—— 这是开发态误用的告警位，不是运行期协商机制。
 */
export function OverlayEscapeDispatcher(): React.ReactElement {
  // 身份标记只创建一次；StrictMode 的双挂载（effect 卸载后重执行）不会误判为重复挂载。
  const ownerRef = React.useRef<object | null>(null)
  if (ownerRef.current === null) {
    ownerRef.current = {}
  }

  React.useEffect(() => {
    const owner = ownerRef.current
    if (owner === null) return
    if (dispatcherOwner !== null && dispatcherOwner !== owner) {
      warnDuplicateDispatcher()
      return
    }
    dispatcherOwner = owner

    const handleKeyDown = (event: KeyboardEvent): void => {
      dispatchOverlayEscape(event)
    }
    document.addEventListener("keydown", handleKeyDown, true)
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true)
      if (dispatcherOwner === owner) {
        dispatcherOwner = null
      }
    }
  }, [])

  return <></>
}
