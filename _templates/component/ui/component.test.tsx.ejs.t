---
to: apps/editor/src/components/ui/<%= name %>.test.tsx
---
import { render } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import { <%= h.changeCase.pascal(name) %> } from "./<%= name %>"

describe("<%= h.changeCase.pascal(name) %>", () => {
  it("renders without crashing", () => {
    const { container } = render(<<%= h.changeCase.pascal(name) %> />)
    expect(container).toBeTruthy()
  })
})
