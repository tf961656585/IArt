---
to: apps/editor/src/features/<%= feature %>/components/<%= name %>/<%= name %>.tsx
---
"use client"

import { cn } from "@/lib/utils"
import type { <%= name %>Props } from "./<%= name %>.types"

// If this component has state logic (useState/useEffect/computations),
// create <%= name %>.hooks.ts and import the hook here.

export function <%= name %>({ className, ...props }: <%= name %>Props) {
  return <div className={cn("", className)} {...props} />
}
