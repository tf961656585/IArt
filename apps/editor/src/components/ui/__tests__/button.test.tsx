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

  it("loading 时渲染旋转指示器、置 aria-busy 并自动禁用，结束态还原", () => {
    // @spec: BTN-005
    const { getByRole, rerender } = render(<Button loading>保存</Button>)
    const button = getByRole("button")

    expect(button).toHaveAttribute("aria-busy", "true")
    expect(button).toBeDisabled()
    const spinner = button.querySelector("svg")
    expect(spinner).not.toBeNull()
    expect(spinner).toHaveClass("animate-spin")
    // 默认档指示器 16px（与基底 svg size-4 档一致）
    expect(spinner).toHaveClass("size-4")

    rerender(<Button>保存</Button>)
    expect(button).not.toHaveAttribute("aria-busy")
    expect(button).not.toBeDisabled()
    expect(button.querySelector("svg")).toBeNull()
  })

  it("loading 在 2xs 档使用 12px 指示器（与该档文字匹配）", () => {
    // @spec: BTN-005
    const { getByRole } = render(
      <Button loading size="2xs">
        保存
      </Button>
    )
    expect(getByRole("button").querySelector("svg")).toHaveClass("size-3")
  })

  it("按压动效类存在于基底且以 motion-safe 门控（减弱动态效果偏好下不应用缩放）", () => {
    // @spec: BTN-006
    const { getByRole } = render(<Button>按压</Button>)

    // motion-safe: 前缀即降级机制——prefers-reduced-motion: reduce 时不应用该规则，
    // 无需单独的 motion-reduce 反向类。
    expect(getByRole("button").className).toContain("motion-safe:active:scale-[0.96]")
  })

  it("variant/size 枚举回归：primary、ghost-destructive、2xs 渲染对应档位类", () => {
    const { getAllByRole } = render(
      <>
        <Button variant="primary">主</Button>
        <Button variant="ghost-destructive">危</Button>
        <Button size="2xs">密</Button>
      </>
    )
    const [primary, ghostDestructive, size2xs] = getAllByRole("button")

    expect(primary).toHaveClass("bg-primary", "text-primary-foreground")
    expect(ghostDestructive).toHaveClass(
      "text-destructive",
      "hover:bg-destructive/10",
      "dark:hover:bg-destructive/20"
    )
    expect(size2xs).toHaveClass("h-7", "px-2", "text-xs")

    // xs 档已裁撤：variant/size 联合类型不再含 "xs"，误用直接编译报错（TS 层拦截，
    // 不做运行时用例——写出该字面量本身即无法通过类型检查）。
  })
})

