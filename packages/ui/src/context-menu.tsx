"use client"

import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import { ChevronRightIcon } from "lucide-react"

import { cn } from "./lib/utils"
import type { WithoutRetiredEscapeProps } from "./overlay-stack/retired-props"

type PrimaryButtonEvent = React.MouseEvent | React.PointerEvent
type ContextMenuItemDefaultedProps = Partial<{
  inset: boolean | undefined
  variant: "default" | "destructive" | undefined
}>
type ContextMenuInsetDefaultedProps = Partial<{
  inset: boolean | undefined
}>

const isPrimaryButton = (event: PrimaryButtonEvent) => event.button === 0

const swallowNonPrimaryButton = (event: PrimaryButtonEvent) => {
  if (isPrimaryButton(event)) return
  event.preventDefault()
  event.stopPropagation()
}

// ContextMenu Root 不自动注册浮层：Radix（2.2.16）的 ContextMenu Root 丢弃传入的 `open`，
// 开合状态由其内部 state 持有，包装层既无法感知也无法关闭，注册只会制造「消费了却关不掉」的死层。
// 其 Esc 行为保持 Radix 原生（右键菜单由 Radix 自己关闭）；画布右键菜单是自研实现，
// 由业务面显式 useOverlayLayer 注册入栈。
function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  onPointerDown,
  onPointerUp,
  onClick,
  onPointerDownCapture,
  onPointerUpCapture,
  ...props
}: WithoutRetiredEscapeProps<React.ComponentProps<typeof ContextMenuPrimitive.Content>>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover max-h-(--radix-context-menu-content-available-height) min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-md",
          className
        )}
        onPointerDownCapture={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          if (typeof onPointerDownCapture === "function") onPointerDownCapture(event)
        }}
        onPointerUpCapture={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          if (typeof onPointerUpCapture === "function") onPointerUpCapture(event)
        }}
        onPointerDown={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          event.stopPropagation()
          if (typeof onPointerDown === "function") onPointerDown(event)
        }}
        onPointerUp={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          event.stopPropagation()
          if (typeof onPointerUp === "function") onPointerUp(event)
        }}
        onClick={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          event.stopPropagation()
          if (typeof onClick === "function") onClick(event)
        }}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  onPointerDown,
  onPointerUp,
  onClick,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & ContextMenuItemDefaultedProps) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-foreground/5 focus:text-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      onPointerDown={(event) => {
        if (!isPrimaryButton(event)) {
          swallowNonPrimaryButton(event)
          return
        }
        if (typeof onPointerDown === "function") onPointerDown(event)
      }}
      onPointerUp={(event) => {
        if (!isPrimaryButton(event)) {
          swallowNonPrimaryButton(event)
          return
        }
        if (typeof onPointerUp === "function") onPointerUp(event)
      }}
      onClick={(event) => {
        if (!isPrimaryButton(event)) {
          swallowNonPrimaryButton(event)
          return
        }
        if (typeof onClick === "function") onClick(event)
      }}
      {...props}
    />
  )
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  onPointerDown,
  onPointerUp,
  onClick,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & ContextMenuInsetDefaultedProps) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-foreground/5 focus:text-foreground data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      onPointerDown={(event) => {
        if (!isPrimaryButton(event)) {
          swallowNonPrimaryButton(event)
          return
        }
        if (typeof onPointerDown === "function") onPointerDown(event)
      }}
      onPointerUp={(event) => {
        if (!isPrimaryButton(event)) {
          swallowNonPrimaryButton(event)
          return
        }
        if (typeof onPointerUp === "function") onPointerUp(event)
      }}
      onClick={(event) => {
        if (!isPrimaryButton(event)) {
          swallowNonPrimaryButton(event)
          return
        }
        if (typeof onClick === "function") onClick(event)
      }}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  onPointerDown,
  onPointerUp,
  onClick,
  onPointerDownCapture,
  onPointerUpCapture,
  ...props
}: WithoutRetiredEscapeProps<React.ComponentProps<typeof ContextMenuPrimitive.SubContent>>) {
  return (
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg",
          className
        )}
        onPointerDownCapture={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          if (typeof onPointerDownCapture === "function") onPointerDownCapture(event)
        }}
        onPointerUpCapture={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          if (typeof onPointerUpCapture === "function") onPointerUpCapture(event)
        }}
        onPointerDown={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          event.stopPropagation()
          if (typeof onPointerDown === "function") onPointerDown(event)
        }}
        onPointerUp={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          event.stopPropagation()
          if (typeof onPointerUp === "function") onPointerUp(event)
        }}
        onClick={(event) => {
          if (!isPrimaryButton(event)) {
            swallowNonPrimaryButton(event)
            return
          }
          event.stopPropagation()
          if (typeof onClick === "function") onClick(event)
        }}
        {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
}
