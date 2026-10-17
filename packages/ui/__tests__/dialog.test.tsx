import { render } from "@testing-library/react"
import { describe, expect, expectTypeOf, it } from "vitest"

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../src/dialog"

// Radix Dialog 默认通过 portal 渲染到 document.body，需要用 document.querySelector
// 查询 [data-slot] 节点。用受控 open 渲染，保证 Content 直接挂载。
// 节点清理由 @testing-library/react 的自动 cleanup（afterEach）接管，禁止手动清空
// document.body，否则与自动 cleanup 冲突引发 NotFoundError。
function renderOpenContent(content: React.ReactNode) {
  return render(
    <Dialog open onOpenChange={() => {}}>
      {content}
    </Dialog>
  )
}

// 测试用例只关注尺寸类，标题仅为满足 Radix 无障碍要求，统一用隐藏标题。
// 用条件 spread 避免显式传 undefined（exactOptionalPropertyTypes 下
// optional 字段传 undefined 字面量会报错）。
function standardContent(
  opts: {
    size: "compact" | "standard" | "wide" | undefined
    showCloseButton: boolean | undefined
  },
  body: React.ReactNode = null
) {
  const extra: { size?: "compact" | "standard" | "wide"; showCloseButton?: boolean } = {}
  if (opts.size !== undefined) {
    extra.size = opts.size
  }
  if (opts.showCloseButton !== undefined) {
    extra.showCloseButton = opts.showCloseButton
  }
  return (
    <DialogContent form="standard" {...extra}>
      <DialogTitle className="sr-only">测试标题</DialogTitle>
      {body}
    </DialogContent>
  )
}

function canvasContent(body: React.ReactNode = null) {
  return (
    <DialogContent form="canvas">
      <DialogTitle className="sr-only">测试标题</DialogTitle>
      {body}
    </DialogContent>
  )
}

function queryContent() {
  return document.querySelector('[data-slot="dialog-content"]') as HTMLElement
}

describe("DialogContent", () => {
  it("standard 形态渲染不崩溃且含 data-slot", () => {
    renderOpenContent(standardContent({ size: undefined, showCloseButton: undefined }, <span>hello</span>))
    expect(queryContent()).not.toBeNull()
  })

  it("守恒底线：基线含 max-h-[90vh] 与 overflow-hidden", () => {
    renderOpenContent(standardContent({ size: undefined, showCloseButton: undefined }))
    const content = queryContent()
    expect(content.className).toContain("max-h-[90vh]")
    expect(content.className).toContain("overflow-hidden")
  })

  it("布局载体为 flex flex-col（非 grid）", () => {
    renderOpenContent(standardContent({ size: undefined, showCloseButton: undefined }))
    const content = queryContent()
    expect(content.className).toContain("flex")
    expect(content.className).toContain("flex-col")
  })

  it("size=compact 输出 32rem 宽度上限", () => {
    renderOpenContent(standardContent({ size: "compact", showCloseButton: undefined }))
    expect(queryContent().className).toContain("sm:max-w-[32rem]")
  })

  it("size=standard 输出 42rem 宽度上限", () => {
    renderOpenContent(standardContent({ size: "standard", showCloseButton: undefined }))
    expect(queryContent().className).toContain("sm:max-w-[42rem]")
  })

  it("size=wide 输出 48rem 宽度上限", () => {
    renderOpenContent(standardContent({ size: "wide", showCloseButton: undefined }))
    expect(queryContent().className).toContain("sm:max-w-[48rem]")
  })

  it("未传 size 时默认 compact（32rem）", () => {
    renderOpenContent(standardContent({ size: undefined, showCloseButton: undefined }))
    expect(queryContent().className).toContain("sm:max-w-[32rem]")
  })

  it("canvas 形态输出 max-w-none 与视口比例宽度约束", () => {
    renderOpenContent(canvasContent())
    const content = queryContent()
    expect(content.className).toContain("max-w-none")
    expect(content.className).toContain("w-[min(96vw,1200px)]")
  })

  it("showCloseButton=false 时不渲染关闭按钮", () => {
    renderOpenContent(standardContent({ size: undefined, showCloseButton: false }))
    expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull()
  })

  it("showCloseButton 默认渲染关闭按钮", () => {
    renderOpenContent(standardContent({ size: undefined, showCloseButton: undefined }))
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull()
  })

  it("standard 形态未显式使用 DialogBody 时自动补内容滚动槽", () => {
    renderOpenContent(
      <DialogContent form="standard" size="standard">
        <DialogHeader>
          <DialogTitle>测试标题</DialogTitle>
        </DialogHeader>
        <div data-testid="legacy-body">旧业务内容</div>
        <DialogFooter>
          <button type="button">确定</button>
        </DialogFooter>
      </DialogContent>
    )

    const body = document.querySelector('[data-slot="dialog-body"]') as HTMLElement
    const header = document.querySelector('[data-slot="dialog-header"]') as HTMLElement
    const footer = document.querySelector('[data-slot="dialog-footer"]') as HTMLElement

    expect(body).not.toBeNull()
    expect(body.className).toContain("overflow-y-auto")
    expect(header.nextElementSibling).toBe(body)
    expect(body.nextElementSibling).toBe(footer)
    expect(body.querySelector('[data-testid="legacy-body"]')).not.toBeNull()
  })

  it("standard 形态显式使用 DialogBody 时不重复补槽", () => {
    renderOpenContent(
      <DialogContent form="standard" size="standard">
        <DialogTitle className="sr-only">测试标题</DialogTitle>
        <DialogBody>显式内容槽</DialogBody>
      </DialogContent>
    )

    expect(document.querySelectorAll('[data-slot="dialog-body"]')).toHaveLength(1)
  })
})

describe("DialogBody", () => {
  function queryBody() {
    return document.querySelector('[data-slot="dialog-body"]') as HTMLElement
  }

  it("渲染含 data-slot=dialog-body", () => {
    renderOpenContent(
      standardContent({ size: undefined, showCloseButton: undefined }, <DialogBody>内容槽</DialogBody>)
    )
    expect(queryBody()).not.toBeNull()
  })

  it("variant=scroll 输出 overflow-y-auto（standard 形态配套）", () => {
    renderOpenContent(
      standardContent(
        { size: undefined, showCloseButton: undefined },
        <DialogBody variant="scroll">滚动</DialogBody>
      )
    )
    const body = queryBody()
    expect(body.className).toContain("overflow-y-auto")
    expect(body.className).toContain("overscroll-contain")
    // 聚焦环裁剪余量（spec「结构槽位语义」节）：负外边距外扩裁剪盒 + 等量内距归位内容。
    expect(body.className).toContain("-mx-1")
    expect(body.className).toContain("px-1")
  })

  it("variant=canvas 输出 overflow-hidden + relative（canvas 形态配套）", () => {
    renderOpenContent(
      standardContent(
        { size: undefined, showCloseButton: undefined },
        <DialogBody variant="canvas">画布内容</DialogBody>
      )
    )
    const body = queryBody()
    expect(body.className).toContain("overflow-hidden")
    expect(body.className).toContain("relative")
    // canvas 变体不承载标准形态的裁剪余量补偿。
    expect(body.className).not.toContain("-mx-1")
  })

  it("未传 variant 时默认 scroll", () => {
    renderOpenContent(
      standardContent(
        { size: undefined, showCloseButton: undefined },
        <DialogBody>默认滚动</DialogBody>
      )
    )
    expect(queryBody().className).toContain("overflow-y-auto")
  })

  it("base 含 min-h-0 与 min-w-0（消除外部依赖）", () => {
    renderOpenContent(
      standardContent(
        { size: undefined, showCloseButton: undefined },
        <DialogBody>base</DialogBody>
      )
    )
    const body = queryBody()
    expect(body.className).toContain("min-h-0")
    expect(body.className).toContain("min-w-0")
  })
})

// 类型层断言：canvas 形态下 size 字段不可达（discriminated union 保证）。
// 使用 vitest 内置 expectTypeOf，不依赖 @ts-expect-error（AGENTS.md 禁止）。
describe("DialogContent 类型契约", () => {
  it("canvas 形态的 props 不含 size 字段", () => {
    type CanvasProps = Extract<
      React.ComponentProps<typeof DialogContent>,
      { form: "canvas" }
    >
    expectTypeOf<CanvasProps>().not.toHaveProperty("size")
  })

  it("standard 形态的 props 含 size 字段", () => {
    type StandardProps = Extract<
      React.ComponentProps<typeof DialogContent>,
      { form: "standard" }
    >
    expectTypeOf<StandardProps>().toHaveProperty("size")
  })
})
