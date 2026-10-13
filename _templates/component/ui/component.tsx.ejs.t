---
to: apps/editor/src/components/ui/<%= name %>.tsx
---
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const <%= h.changeCase.camel(name) %>Variants = cva(
  "inline-flex items-center justify-center",
  {
    variants: {
      variant: {
        default: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

interface <%= h.changeCase.pascal(name) %>Props
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof <%= h.changeCase.camel(name) %>Variants> {}

const <%= h.changeCase.pascal(name) %> = React.forwardRef<
  HTMLDivElement,
  <%= h.changeCase.pascal(name) %>Props
>(({ className, variant, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(<%= h.changeCase.camel(name) %>Variants({ variant, className }))}
      {...props}
    />
  )
})

<%= h.changeCase.pascal(name) %>.displayName = "<%= h.changeCase.pascal(name) %>"

export { <%= h.changeCase.pascal(name) %>, <%= h.changeCase.camel(name) %>Variants }
