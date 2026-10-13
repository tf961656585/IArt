// @iart/ui Radix 包装组件的自动注册行为测试
// （spec docs/editor/浮层堆栈管理.md「组件自动注册」+ 验收 OVL-008）。
// @spec: OVL-008
//
// 覆盖两类事实：
// 1. 包装组件打开即入栈、关闭即出栈，栈序 = 打开顺序（后开在上）；
// 2. 弹窗内展开的下拉成为栈顶，Esc 只关下拉（OVL-008）——业务方无需任何接入代码。
import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../src/context-menu"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../src/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/dropdown-menu"
import { getTopOverlayLayer, OverlayEscapeDispatcher } from "../src/overlay-stack"
import { Popover, PopoverContent, PopoverTrigger } from "../src/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../src/select"

// jsdom 未实现 Pointer Capture API，而 Radix Select 的 trigger 在 pointerdown 里无条件调用
// target.hasPointerCapture(event.pointerId)（@radix-ui/react-select 的 onPointerDown），
// 缺失会抛 "target.hasPointerCapture is not a function"。此处补最小实现，仅本测试文件生效。
if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    value: () => false,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    value: () => {},
    configurable: true,
    writable: true,
  })
  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    value: () => {},
    configurable: true,
    writable: true,
  })
}

function mountDispatcher() {
  return render(<OverlayEscapeDispatcher />)
}

function pressEscape(target: Element | Document | Window = document.body) {
  fireEvent.keyDown(target, { key: "Escape", code: "Escape" })
}

function topLayerId(): string | null {
  return getTopOverlayLayer()?.id ?? null
}

/** 弹窗 + 其内非受控 Select（对齐 TextInputAiEditDialog 等存量用法）。 */
function DialogWithUncontrolledSelect({ onDialogClose }: { onDialogClose: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onDialogClose()
          setOpen(false)
        }
      }}
    >
      <DialogContent form="standard">
        <DialogTitle>AI 修改</DialogTitle>
        <Select>
          <SelectTrigger size="default" aria-label="选择模型">
            <SelectValue placeholder="选择模型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="model-a">model-a</SelectItem>
            <SelectItem value="model-b">model-b</SelectItem>
          </SelectContent>
        </Select>
      </DialogContent>
    </Dialog>
  )
}

beforeEach(() => {
  // 栈空 ⟺ 栈顶为空：上一个用例的层必须已被卸载清空。
  expect(topLayerId()).toBeNull()
})

describe("Radix 包装组件自动注册", () => {
  it("Dialog 打开即入栈、关闭即出栈", () => {
    const handleOpenChange = vi.fn()
    const { rerender } = render(
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent form="standard">
          <DialogTitle>弹窗</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(topLayerId()).toMatch(/^dialog:/)

    rerender(
      <Dialog open={false} onOpenChange={handleOpenChange}>
        <DialogContent form="standard">
          <DialogTitle>弹窗</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(topLayerId()).toBeNull()
  })

  it("Dialog 非受控用法：触发器打开即入栈，Esc 关闭后出栈", async () => {
    const user = userEvent.setup()
    mountDispatcher()
    render(
      <Dialog>
        <DialogTrigger>打开弹窗</DialogTrigger>
        <DialogContent form="standard">
          <DialogTitle>弹窗</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(topLayerId()).toBeNull()

    await user.click(screen.getByRole("button", { name: "打开弹窗" }))
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
    expect(topLayerId()).toMatch(/^dialog:/)

    pressEscape()

    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull()
    expect(topLayerId()).toBeNull()
  })

  it("Popover 非受控用法同样入栈（包装层内部持控开合）", async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger>打开浮层</PopoverTrigger>
        <PopoverContent>浮层内容</PopoverContent>
      </Popover>,
    )
    expect(topLayerId()).toBeNull()

    await user.click(screen.getByRole("button", { name: "打开浮层" }))

    expect(await screen.findByText("浮层内容")).toBeInTheDocument()
    expect(topLayerId()).toMatch(/^popover:/)
  })

  it("Select 非受控用法同样入栈（包装层内部持控开合）", async () => {
    const user = userEvent.setup()
    render(
      <Select>
        <SelectTrigger size="default" aria-label="选择档位">
          <SelectValue placeholder="选择档位" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">a</SelectItem>
        </SelectContent>
      </Select>,
    )
    expect(topLayerId()).toBeNull()

    await user.click(screen.getByRole("combobox", { name: "选择档位" }))

    expect(document.querySelector('[data-slot="select-content"]')).not.toBeNull()
    expect(topLayerId()).toMatch(/^select:/)
  })

  it("弹窗 + 下拉：栈序为打开顺序，下拉在栈顶；下拉退出后弹窗层仍在栈顶", async () => {
    const user = userEvent.setup()
    mountDispatcher()
    render(<DialogWithUncontrolledSelect onDialogClose={() => {}} />)
    expect(topLayerId()).toMatch(/^dialog:/)

    await user.click(screen.getByRole("combobox", { name: "选择模型" }))

    // 栈序 = 打开顺序：下拉后开，在栈顶；弹窗层仍在它下面（下拉退出后由它接回栈顶）。
    expect(topLayerId()).toMatch(/^select:/)

    pressEscape()

    expect(topLayerId()).toMatch(/^dialog:/)
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
  })
})

describe("OVL-008 弹窗内下拉只关下拉", () => {
  it("OVL-008 非受控 Select 展开时 Esc 只关下拉，弹窗保持打开；再按 Esc 才关弹窗", async () => {
    const user = userEvent.setup()
    const closeDialog = vi.fn()
    mountDispatcher()
    render(<DialogWithUncontrolledSelect onDialogClose={closeDialog} />)

    await user.click(screen.getByRole("combobox", { name: "选择模型" }))
    expect(document.querySelector('[data-slot="select-content"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull()

    pressEscape()

    expect(document.querySelector('[data-slot="select-content"]')).toBeNull()
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
    expect(closeDialog).not.toHaveBeenCalled()
    expect(topLayerId()).toMatch(/^dialog:/)

    pressEscape()

    expect(closeDialog).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull()
  })

  it("OVL-008 受控 DropdownMenu 展开时 Esc 只关菜单，弹窗保持打开", async () => {
    const user = userEvent.setup()
    const closeDialog = vi.fn()
    mountDispatcher()
    render(
      <Dialog open onOpenChange={(next) => { if (!next) closeDialog() }}>
        <DialogContent form="standard">
          <DialogTitle>弹窗</DialogTitle>
          <DropdownMenu>
            <DropdownMenuTrigger>更多操作</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>删除</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </DialogContent>
      </Dialog>,
    )

    await user.click(screen.getByRole("button", { name: "更多操作" }))
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull()
    expect(topLayerId()).toMatch(/^dropdown-menu:/)

    pressEscape()

    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull()
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
    expect(closeDialog).not.toHaveBeenCalled()
    expect(topLayerId()).toMatch(/^dialog:/)
  })
})

describe("未自动注册的包装组件（事实依据）", () => {
  it("ContextMenu 没有受控 open，打开时也不入栈", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>右键区域</ContextMenuTrigger>
        <ContextMenuContent>
          <div>菜单项</div>
        </ContextMenuContent>
      </ContextMenu>,
    )

    fireEvent.contextMenu(screen.getByText("右键区域"))

    // Radix 的 ContextMenu Root 自持开合状态（props 类型里根本没有 open），包装层既感知不到
    // 打开、也无法关闭它，因此不参与自动注册（见 packages/ui/src/context-menu.tsx 注释）：
    // 菜单确实打开了，但浮层栈里没有它（栈顶为空），Esc 由 Radix 自身处理。
    expect(document.querySelector('[data-slot="context-menu-content"]')).not.toBeNull()
    expect(topLayerId()).toBeNull()
    expectTypeOf<React.ComponentProps<typeof ContextMenu>>().not.toHaveProperty("open")
  })

  it("退役：DialogContent 公共 props 不再提供 Escape 专有透传", () => {
    expectTypeOf<React.ComponentProps<typeof DialogContent>>().not.toHaveProperty(
      "onEscapeKeyDown",
    )
  })
})
