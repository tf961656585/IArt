---
to: apps/editor/src/features/<%= feature %>/components/<%= name %>/<%= name %>.test.tsx
---
import { render } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import { <%= name %> } from "./<%= name %>"

describe("<%= name %>", () => {
  it("renders without crashing", () => {
    const { container } = render(<<%= name %> />)
    expect(container).toBeTruthy()
  })
})
