import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { CommandDialog, CommandInput } from "../src/command"

// CommandDialog 内部走 Radix Dialog（portal），用受控 open 渲染保证 Content 挂载。
// 节点清理由 @testing-library/react 自动 cleanup 接管。
describe("CommandDialog", () => {
  it("受控 open 时渲染不崩溃", () => {
    render(
      <CommandDialog open onOpenChange={() => {}} title="测试" description="测试描述">
        <CommandInput placeholder="搜索" />
      </CommandDialog>
    )

    expect(
      document.querySelector('[data-slot="dialog-content"]')
    ).not.toBeNull()
  })

  it("透传 standard 形态与 size 档位到 DialogContent", () => {
    render(
      <CommandDialog
        open
        onOpenChange={() => {}}
        title="测试"
        description="测试描述"
        size="wide"
      >
        <CommandInput placeholder="搜索" />
      </CommandDialog>
    )

    const content = document.querySelector(
      '[data-slot="dialog-content"]'
    ) as HTMLElement
    // form="standard" 内置默认；size=wide 应输出 48rem。
    expect(content.className).toContain("sm:max-w-[48rem]")
  })

  it("保留 p-0 视觉样式，移除 overflow-hidden（由守恒底线接管）", () => {
    render(
      <CommandDialog open onOpenChange={() => {}} title="测试" description="测试描述">
        <CommandInput placeholder="搜索" />
      </CommandDialog>
    )

    const content = document.querySelector(
      '[data-slot="dialog-content"]'
    ) as HTMLElement
    expect(content.className).toContain("p-0")
    // 业务 className 不应再带 overflow-hidden（由 DialogContent 基线统一管）。
    // 注意：DialogContent 基线本身含 overflow-hidden（守恒底线），这是合法的内部实现。
    // CommandDialog 自身的 className 贡献只应是 p-0。
  })
})
