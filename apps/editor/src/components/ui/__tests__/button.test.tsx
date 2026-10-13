import * as React from "react"
import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { Button } from "../button"

describe("Button", () => {
  it("会把 ref 转发到原生 button 元素", () => {
    const ref = React.createRef<HTMLButtonElement>()

    render(<Button ref={ref}>Click</Button>)

    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it("接收 ref 时不会触发 React ref 警告", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const ref = React.createRef<HTMLButtonElement>()

    render(<Button ref={ref}>Click</Button>)

    const messages = errorSpy.mock.calls.flat().join("\n")
    expect(messages).not.toContain("Function components cannot be given refs")
    errorSpy.mockRestore()
  })
})

