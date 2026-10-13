"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "./lib/utils"
import { useRadixOverlayLayer } from "./overlay-stack/radix-layer"
import type { WithoutRetiredEscapeProps } from "./overlay-stack/retired-props"

// 开合状态由包装层内部持控并自动入浮层栈（spec「组件自动注册」）：
// 传 `open` 时为受控，不传时为默认关闭、内部开合；两种情况都会注册为浮层，
// 因此 Esc 由 OverlayEscapeDispatcher 统一派发（栈顶先退出）。
// `closeOnEscape: false` 用于「模态禁 Esc」（如保存角色弹窗）：消费事件但不关闭。
// 项目内禁止新增非受控浮层（spec 核心规则 9）：新浮层必须受控，便于栈与业务方共同掌握开合。
type DialogProps = React.ComponentProps<typeof DialogPrimitive.Root> & {
  closeOnEscape?: boolean
}

function Dialog({ closeOnEscape, open, defaultOpen, onOpenChange, ...props }: DialogProps) {
  const layer = useRadixOverlayLayer({
    kind: "dialog",
    open,
    defaultOpen,
    onOpenChange,
    closeOnEscape,
  })
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      {...props}
      open={layer.open}
      onOpenChange={layer.onOpenChange}
    />
  )
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-modal bg-black/50",
        className
      )}
      {...props}
    />
  )
}

// 宽度语义档位：spec docs/editor/dialog-sizing-contract.md「宽度语义档位」节。
// compact = 32rem（与历史基线 sm:max-w-lg 一致），standard = 42rem，wide = 48rem。
// 仅 standard 形态使用；canvas 形态宽度由 DialogContent 内部分支直接给出。
const dialogSizeVariants = cva(null, {
  variants: {
    size: {
      compact: "sm:max-w-[32rem]",
      standard: "sm:max-w-[42rem]",
      wide: "sm:max-w-[48rem]",
    },
  },
})

// DialogBody 滚动变体：spec「结构槽位语义」节。
// scroll = standard 形态下唯一滚动容器；canvas = 撑满 + 不滚动，业务内容自管空间。
// base 含 min-h-0 / min-w-0，保证 flex 子元素能正确收缩，消除外部 min-w-0 依赖。
const dialogBodyVariants = cva(
  "flex-1 min-h-0 min-w-0",
  {
    variants: {
      variant: {
        scroll: "overflow-y-auto overscroll-contain",
        canvas: "overflow-hidden relative",
      },
    },
    defaultVariants: {
      variant: "scroll",
    },
  }
)

// DialogContent props 采用 discriminated union，判别字段 form。
// spec「DialogContent Props 契约」节。
// className/children 继承 Radix 原生 optional 语义（Radix 类型用 `?`，属第三方声明）；
// size/showCloseButton 用 `Partial` 工具类型实现可选。
// Escape 专有透传（onEscapeKeyDown 等）已退役（spec「退役清单」）：Esc 一律经浮层栈分发，
// 包装组件不再提供绕栈通道。退役名单由 overlay-stack/retired-props.ts 维护。
type RadixContentProps = WithoutRetiredEscapeProps<
  React.ComponentProps<typeof DialogPrimitive.Content>
>

export type StandardDialogContentProps = RadixContentProps & {
  form: "standard"
} & Partial<{
  size: "compact" | "standard" | "wide"
  showCloseButton: boolean
}>

export type CanvasDialogContentProps = RadixContentProps & {
  form: "canvas"
  // spec docs/editor/dialog-sizing-contract.md「canvas 形态高度结构化 prop（fill）」节。
  // fill = 高度锁定为守恒底线 90vh（媒体工具弹窗等需撑满可用高度的场景）；
  // 默认 false（高度由内容 emergent 撑开）。
  fill?: boolean
} & Partial<{
  showCloseButton: boolean
}>

export type DialogContentProps =
  | StandardDialogContentProps
  | CanvasDialogContentProps

function isDirectDialogChildType(
  child: React.ReactNode,
  type: React.ElementType
) {
  return React.isValidElement(child) && child.type === type
}

function normalizeStandardDialogChildren(children: React.ReactNode) {
  const childArray = React.Children.toArray(children)
  const hasExplicitBody = childArray.some((child) =>
    isDirectDialogChildType(child, DialogBody)
  )
  if (hasExplicitBody) return children

  const headerChildren: React.ReactNode[] = []
  const bodyChildren: React.ReactNode[] = []
  const footerChildren: React.ReactNode[] = []
  let reachedFooter = false

  for (const child of childArray) {
    if (isDirectDialogChildType(child, DialogFooter)) {
      reachedFooter = true
      footerChildren.push(child)
      continue
    }

    if (
      !reachedFooter &&
      bodyChildren.length === 0 &&
      isDirectDialogChildType(child, DialogHeader)
    ) {
      headerChildren.push(child)
      continue
    }

    if (reachedFooter) {
      footerChildren.push(child)
      continue
    }

    bodyChildren.push(child)
  }

  return (
    <>
      {headerChildren}
      {bodyChildren.length > 0 ? (
        <DialogBody key="dialog-content-auto-body" variant="scroll">
          {bodyChildren}
        </DialogBody>
      ) : null}
      {footerChildren}
    </>
  )
}

function DialogContent(props: DialogContentProps) {
  const { className, children, showCloseButton = true, ...rest } = props
  const normalizedChildren =
    props.form === "standard"
      ? normalizeStandardDialogChildren(children)
      : children

  // 守恒底线 + 布局载体（所有形态共用）：spec「守恒底线」「布局载体」节。
  // grid → flex flex-col；内置 max-h-[90vh]（不可关闭）；overflow-hidden 兜底，
  // 内容滚动交给 DialogBody。
  const baseClassName =
    "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-modal flex max-h-[90vh] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col gap-4 overflow-hidden rounded-lg border p-6 shadow-lg duration-200"

  // 宽度分支（spec「宽度语义档位」「弹窗形态」节）：
  // - standard 形态：size variant 输出 sm:max-w-*，覆盖基线移动端兜底的桌面端宽度。
  // - canvas 形态：输出 max-w-none + w-[min(96vw,1200px)]，覆盖基线移动端兜底，
  //   canvas 形态需撑满。这两个类属基础组件内部实现，dialog.tsx 被门禁豁免。
  const sizeClassName =
    props.form === "standard"
      ? dialogSizeVariants({ size: props.size ?? "compact" })
      : "max-w-none w-[min(96vw,1200px)]"

  // 高度目标分支（spec「canvas 形态高度结构化 prop（fill）」节）：
  // fill = true 时高度锁定为守恒底线 90vh，槽位按 flex 收缩分配；
  // 默认 emergent。属基础组件内部实现，dialog.tsx 被门禁豁免。
  const fillClassName =
    props.form === "canvas" && props.fill ? "h-[90vh]" : null

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(baseClassName, sizeClassName, fillClassName, className)}
        {...rest}
      >
        {normalizedChildren}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

// DialogBody：内容槽位组件，spec「结构槽位语义」「槽位组件契约」节。
// variant 自管滚动行为，不依赖父级 form。
// standard 形态下业务方用 variant="scroll"（或不传，默认 scroll）；
// canvas 形态下业务方用 variant="canvas"。
// 业务方不得在 DialogBody 上叠加 overflow 覆盖（spec className 边界）。
function DialogBody({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof dialogBodyVariants>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(dialogBodyVariants({ variant }), className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  dialogBodyVariants,
  dialogSizeVariants,
}
