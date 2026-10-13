"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { type CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// 主题由调用方通过 props 注入（theme 缺省时回退 "system"），
// 本包不依赖 next-themes。
const Toaster = ({ theme = "system", ...props }: ToasterProps) => {
  const resolvedTheme: NonNullable<ToasterProps["theme"]> =
    theme === "light" || theme === "dark" || theme === "system"
      ? theme
      : "system"
  const toasterStyle: CSSProperties & Record<`--${string}`, string> = {
    "--normal-bg": "var(--popover)",
    "--normal-text": "var(--popover-foreground)",
    "--normal-border": "var(--border)",
    "--border-radius": "var(--radius)",
    // sonner 每条 toast 的 z-index 来源（默认 999999999 脱离海拔模型）。
    // 对齐 z-popover：toast 与弹窗内下拉同为瞬时轻浮层，谁后打开谁在上无业务语义。
    "--z-index": "var(--z-index-popover, 900)",
  }

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={toasterStyle}
      {...props}
    />
  )
}

export { Toaster }
