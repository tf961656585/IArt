"use client"

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "./lib/utils"
import { useRadixOverlayLayer } from "./overlay-stack/radix-layer"
import type { WithoutRetiredEscapeProps } from "./overlay-stack/retired-props"

// 开合状态由包装层内部持控并自动入浮层栈（spec「组件自动注册」）：
// 弹窗内展开的下拉/浮层因「后开在上」成为栈顶，Esc 先关它、弹窗保持打开。
// Escape 专有透传（onEscapeKeyDown 等）已退役（spec「退役清单」）。
function Popover({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const layer = useRadixOverlayLayer({ kind: "popover", open, defaultOpen, onOpenChange })
  return (
    <PopoverPrimitive.Root
      data-slot="popover"
      {...props}
      open={layer.open}
      onOpenChange={layer.onOpenChange}
    />
  )
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: WithoutRetiredEscapeProps<React.ComponentProps<typeof PopoverPrimitive.Content>>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
