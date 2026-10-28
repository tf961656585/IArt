import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "./lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 motion-safe:active:scale-[0.96] [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring dark:focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        "ghost-destructive":
          "text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/20",
        outline:
          "border border-input bg-background shadow-xs hover:bg-foreground/5 dark:bg-input/30 dark:border-input",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-foreground/5",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        "2xs": "h-7 px-2 text-xs",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

type ButtonDefaultedProps = Partial<{
  asChild: boolean | undefined
}>

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> &
    ButtonDefaultedProps & {
      loading?: boolean | undefined
    }
>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button"

    // 2xs 档 spinner 用 size-3（12px），其余档跟随基底 svg 默认 size-4；
    // 显式写 size-* 而非 h-*/w-*，避免被基底 [&_svg:not([class*='size-'])]:size-4
    // 以更高特异性覆盖回 16px。
    const spinnerSize = size === "2xs" ? "size-3" : "size-4"

    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
      >
        {loading && !asChild ? (
          <Loader2 aria-hidden="true" className={cn("animate-spin", spinnerSize)} />
        ) : null}
        {children}
      </Comp>
    )
  }
)

Button.displayName = "Button"

export { Button, buttonVariants }
