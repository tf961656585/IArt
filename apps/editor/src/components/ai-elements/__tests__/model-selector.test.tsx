import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorList,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector"

// ModelSelectorContent 内部走 Radix Dialog（portal），用受控 open 渲染保证 Content 挂载。
// 节点清理由 @testing-library/react 自动 cleanup 接管。
describe("ModelSelectorContent", () => {
  it("standard 形态渲染不崩溃", () => {
    render(
      <ModelSelector open onOpenChange={() => {}}>
        <ModelSelectorTrigger />
        <ModelSelectorContent form="standard" title="模型选择">
          <ModelSelectorList>
            <ModelSelectorInput placeholder="搜索模型" />
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>
    )

    expect(
      document.querySelector('[data-slot="dialog-content"]')
    ).not.toBeNull()
  })

  it("透传 size 档位到 DialogContent", () => {
    render(
      <ModelSelector open onOpenChange={() => {}}>
        <ModelSelectorTrigger />
        <ModelSelectorContent form="standard" size="wide" title="模型选择">
          <ModelSelectorList>
            <ModelSelectorInput placeholder="搜索模型" />
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>
    )

    const content = document.querySelector(
      '[data-slot="dialog-content"]'
    ) as HTMLElement
    expect(content.className).toContain("sm:max-w-[48rem]")
  })

  it("保留 p-0 视觉样式", () => {
    render(
      <ModelSelector open onOpenChange={() => {}}>
        <ModelSelectorTrigger />
        <ModelSelectorContent form="standard" title="模型选择">
          <ModelSelectorList>
            <ModelSelectorInput placeholder="搜索模型" />
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>
    )

    const content = document.querySelector(
      '[data-slot="dialog-content"]'
    ) as HTMLElement
    expect(content.className).toContain("p-0")
  })
})
