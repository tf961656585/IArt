"use client"

import * as React from "react"

import { Button } from "./button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

type TooltipButtonProps = Omit<
  React.ComponentPropsWithoutRef<typeof Button>,
  "asChild"
> & {
  tooltip: React.ReactNode
} & Partial<{
  tooltipContentProps: Omit<
    React.ComponentPropsWithoutRef<typeof TooltipContent>,
    "children"
  > | undefined
  triggerWrapperClassName: string | undefined
  triggerWrapperStyle: React.CSSProperties | undefined
}>

const TooltipButton = React.forwardRef<HTMLButtonElement, TooltipButtonProps>(
  (
    {
      children,
      tooltip,
      tooltipContentProps = undefined,
      triggerWrapperClassName = undefined,
      triggerWrapperStyle = undefined,
      ...buttonProps
    },
    ref,
  ) => {
    const button = (
      <Button ref={ref} {...buttonProps}>
        {children}
      </Button>
    )
    const triggerChild =
      triggerWrapperClassName || triggerWrapperStyle ? (
        <span className={triggerWrapperClassName} style={triggerWrapperStyle}>
          {button}
        </span>
      ) : (
        button
      )

    return (
      <Tooltip>
        <TooltipTrigger asChild>{triggerChild}</TooltipTrigger>
        <TooltipContent {...tooltipContentProps}>{tooltip}</TooltipContent>
      </Tooltip>
    )
  },
)

TooltipButton.displayName = "TooltipButton"

export { TooltipButton }
