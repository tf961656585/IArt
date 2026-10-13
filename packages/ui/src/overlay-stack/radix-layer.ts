"use client"

/**
 * Radix 包装组件的统一接入点：把 Root 的开合状态摘到包装层内部持控，并按开合状态自动注册浮层。
 *
 * spec: docs/editor/浮层堆栈管理.md「组件自动注册」——业务方零接入成本。
 * @internal 供本包 Radix 包装组件使用，不对外导出。
 */

import * as React from "react"

import { useOverlayLayer } from "./react"

/** Radix Root 的开合 props（包装层从 Root 上摘下、自己持控）。 */
export interface RadixOverlayOpenProps {
  open?: boolean | undefined
  defaultOpen?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
}

export interface RadixOverlayLayerOptions extends RadixOverlayOpenProps {
  /** 层 id 前缀，便于调试与守卫日志定位（dialog / popover / select / dropdown-menu）。 */
  kind: string
  /** 透传给层配置，默认 true（spec「组件自动注册」表格）。 */
  closeOnEscape?: boolean | undefined
  ignoreWhenFocusInEditable?: boolean | undefined
}

export interface RadixOverlayLayerState {
  /** 传给 Radix Root 的开合值（包装层内部持控，恒为布尔）。 */
  open: boolean
  /** 传给 Radix Root 的开合变更回调。 */
  onOpenChange: (open: boolean) => void
}

/**
 * 为什么包装层接管开合（而不是只认业务方传的受控 `open`）：
 *
 * - spec「组件自动注册」要求业务方零接入成本，而 Editor/Hub 存量的 Select / Popover /
 *   DropdownMenu 多数是非受控用法（只传 value，或不传开合 props）。若只认受控 `open`，
 *   这些浮层不入栈：当它们叠在一个已注册的 Dialog 之上按 Esc，分发器把栈顶判成 Dialog，
 *   一次 Esc 关掉整个弹窗（先例：TextInputAiEditDialog / ImageOutpaintDialogContent /
 *   ProviderFormDialog 内的非受控 Select），比迁移前的「只关下拉」更糟。
 * - 包装层内部持控后 Root 恒收到布尔 `open`：非受控用法由包装层承接开合并照常入栈，
 *   关闭动作（分发器 → onClose → handleOpenChange(false)）也因此能真正生效 ——
 *   Radix 的非受控开合状态在组件内部，外部无法关闭。
 * - 业务方语义不变：传 `open` 仍是受控；不传仍是「初始 defaultOpen、内部开合」，
 *   `onOpenChange` 通知照常触发。
 *
 * ContextMenu 不适用：Radix 的 ContextMenu Root 丢弃 `open` prop、由内部 state 持控开合
 * （见 packages/ui/__tests__/overlay-stack-radix-wrappers.test.tsx 的事实依据用例），
 * 无法由包装层关闭，故不自动注册；画布右键菜单是自研实现，由业务面显式 useOverlayLayer 注册。
 */
export function useRadixOverlayLayer(
  options: RadixOverlayLayerOptions,
): RadixOverlayLayerState {
  const {
    kind,
    open,
    defaultOpen,
    onOpenChange,
    closeOnEscape,
    ignoreWhenFocusInEditable,
  } = options
  const layerId = React.useId()
  const isControlled = open !== undefined
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const effectiveOpen = open === undefined ? uncontrolledOpen : open

  const handleOpenChange = React.useCallback(
    (next: boolean): void => {
      if (!isControlled) {
        setUncontrolledOpen(next)
      }
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange],
  )

  useOverlayLayer({
    id: `${kind}:${layerId}`,
    active: effectiveOpen,
    onClose: () => {
      handleOpenChange(false)
    },
    closeOnEscape: closeOnEscape ?? true,
    ignoreWhenFocusInEditable: ignoreWhenFocusInEditable ?? false,
  })

  return { open: effectiveOpen, onOpenChange: handleOpenChange }
}
