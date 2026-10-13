/**
 * 浮层堆栈与 Esc 分发（spec: docs/editor/浮层堆栈管理.md）。
 *
 * 消费面：
 * - 窗口 React 根部挂一次 `OverlayEscapeDispatcher`（Editor / Hub 各一处）。
 * - 浮层开合用 `useOverlayLayer` 声明式注册；非 React 场景用 `registerOverlayLayer`。
 * - @iart/ui 的 Radix 包装组件（Dialog / Popover / DropdownMenu / Select）已自动注册，业务方零接入。
 * - Escape 键判定只有 `isEscapeEvent` 一处（画布基底这一栈外消费面也经它判定）。
 */

export type { EscapeKeyEventLike } from "./escape-key"
export { isEscapeEvent } from "./escape-key"
export { getTopOverlayLayer, registerOverlayLayer } from "./registry"
export type { OverlayLayerConfig } from "./registry"
export { OverlayEscapeDispatcher, useOverlayLayer } from "./react"
export type { RetiredEscapePropName, WithoutRetiredEscapeProps } from "./retired-props"
