---
to: apps/editor/src/features/<%= feature %>/components/<%= name %>/<%= name %>.types.ts
---
import type { HTMLAttributes } from "react"

export interface <%= name %>Props extends HTMLAttributes<HTMLDivElement> {
  // TODO: Define component props
}
