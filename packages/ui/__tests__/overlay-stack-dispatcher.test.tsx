// 浮层栈 Esc 分发器行为测试（spec docs/editor/浮层堆栈管理.md「验收」：OVL-001/002/004/006/007）。
// @spec: OVL-001, OVL-002, OVL-004, OVL-006, OVL-007
//
// 测试纪律：分发器必须先于浮层挂载 —— 它与 Radix 的 Esc 监听同在 document 捕获阶段，
// 同节点监听按注册顺序触发，只有先注册才能用 stopImmediatePropagation 截断。
// 生产环境由「分发器挂在窗口 React 根部、应用启动时先挂载」保证，测试用先 render 对齐。
import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../src/dialog"
import { isEscapeEvent } from "../src/overlay-stack/escape-key"
import { getTopOverlayLayer, OverlayEscapeDispatcher, useOverlayLayer } from "../src/overlay-stack"

function mountDispatcher() {
  return render(<OverlayEscapeDispatcher />)
}

function pressEscape(target: Element | Document | Window = document.body) {
  fireEvent.keyDown(target, { key: "Escape", code: "Escape" })
}

/** 记录派发链下游是否仍能看到事件（用于断言「消费不穿透」与「栈空透传」）。 */
function observeKeydownDownstream() {
  const received: KeyboardEvent[] = []
  const listener = (event: KeyboardEvent) => {
    received.push(event)
  }
  window.addEventListener("keydown", listener)
  return {
    received,
    stop: () => window.removeEventListener("keydown", listener),
  }
}

/**
 * 右侧工作区替身：常驻挂载（关闭时只翻 active），与 RightWorkspace 的真实形态一致，
 * 并沿用其层配置（ignoreWhenFocusInEditable: true）。
 */
function SidebarDouble({
  onClose,
  children,
}: {
  onClose: () => void
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  useOverlayLayer({
    active: open,
    id: "test-sidebar",
    onClose: () => {
      onClose()
      setOpen(false)
    },
    ignoreWhenFocusInEditable: true,
  })
  if (!open) return null
  return <div data-testid="sidebar">{children}</div>
}

/** 媒体大图预览替身：真实 @iart/ui Dialog（Radix），受控开合。 */
function MediaPreviewDialog({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
          setOpen(false)
        }
      }}
    >
      <DialogContent form="canvas">
        <DialogTitle>媒体大图</DialogTitle>
        <DialogDescription className="sr-only">预览</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

function queryDialogContent(): Element | null {
  return document.querySelector('[data-slot="dialog-content"]')
}

beforeEach(() => {
  // 隔离守卫：上一个用例的层必须已被卸载清空（栈空 ⟺ 栈顶为空），否则说明有泄漏的幽灵层。
  expect(getTopOverlayLayer()).toBeNull()
})

describe("isEscapeEvent（Escape 判定的唯一 owner）", () => {
  it("键名匹配且不在组合期 → true", () => {
    expect(isEscapeEvent({ key: "Escape" })).toBe(true)
  })

  it("其他键名 → false（不误判同前缀键）", () => {
    expect(isEscapeEvent({ key: "Enter" })).toBe(false)
    expect(isEscapeEvent({ key: "Esc" })).toBe(false)
    expect(isEscapeEvent({ key: "escape" })).toBe(false)
  })

  it("IME 组合期让位：isComposing 或 keyCode 229 → false", () => {
    expect(isEscapeEvent({ key: "Escape", isComposing: true })).toBe(false)
    expect(isEscapeEvent({ key: "Escape", keyCode: 229 })).toBe(false)
  })
})

describe("OverlayEscapeDispatcher 叠层派发", () => {
  it("OVL-001 叠层只关栈顶：侧栏 + 大图预览，一次 Esc 只关大图", () => {
    const closeSidebar = vi.fn()
    const closeDialog = vi.fn()
    mountDispatcher()
    render(<SidebarDouble onClose={closeSidebar} />)
    render(<MediaPreviewDialog onClose={closeDialog} />)

    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    expect(queryDialogContent()).not.toBeNull()

    pressEscape()

    expect(closeDialog).toHaveBeenCalledTimes(1)
    expect(queryDialogContent()).toBeNull()
    expect(closeSidebar).not.toHaveBeenCalled()
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    expect(getTopOverlayLayer()?.id).toBe("test-sidebar")
  })

  it("OVL-002 逐层退出：再按一次只关侧栏，栈空后 Esc 透传下游监听", () => {
    const closeSidebar = vi.fn()
    const closeDialog = vi.fn()
    mountDispatcher()
    render(<SidebarDouble onClose={closeSidebar} />)
    render(<MediaPreviewDialog onClose={closeDialog} />)
    const downstream = observeKeydownDownstream()

    pressEscape()
    expect(closeDialog).toHaveBeenCalledTimes(1)
    expect(closeSidebar).not.toHaveBeenCalled()

    pressEscape()
    expect(closeSidebar).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("sidebar")).toBeNull()
    expect(getTopOverlayLayer()).toBeNull()
    // 前两次都被栈消费：下游监听一次都没看到。
    expect(downstream.received).toHaveLength(0)

    pressEscape()
    expect(downstream.received).toHaveLength(1)
    expect(downstream.received[0]?.defaultPrevented).toBe(false)
    downstream.stop()
  })
})

describe("OverlayEscapeDispatcher 消费语义", () => {
  it("OVL-004 模态禁 Esc：closeOnEscape=false 时不关闭、不穿透、下层不受影响", () => {
    const closeSidebar = vi.fn()
    mountDispatcher()
    render(<SidebarDouble onClose={closeSidebar} />)
    render(
      <Dialog open closeOnEscape={false} onOpenChange={() => {}}>
        <DialogContent form="standard">
          <DialogTitle>保存角色</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const downstream = observeKeydownDownstream()

    pressEscape()

    expect(queryDialogContent()).not.toBeNull()
    expect(closeSidebar).not.toHaveBeenCalled()
    expect(downstream.received).toHaveLength(0)
    downstream.stop()
  })

  it("OVL-006 输入焦点让位：焦点在可编辑元素内时不关侧栏，事件仍被消费", () => {
    const closeSidebar = vi.fn()
    mountDispatcher()
    render(
      <SidebarDouble onClose={closeSidebar}>
        <input aria-label="会话输入" />
      </SidebarDouble>,
    )
    const downstream = observeKeydownDownstream()

    const input = screen.getByLabelText("会话输入")
    input.focus()
    expect(document.activeElement).toBe(input)

    pressEscape(input)

    expect(closeSidebar).not.toHaveBeenCalled()
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    expect(downstream.received).toHaveLength(0)
    downstream.stop()
  })

  it("OVL-006 对照：焦点不在可编辑元素内时侧栏照常关闭", () => {
    const closeSidebar = vi.fn()
    mountDispatcher()
    render(<SidebarDouble onClose={closeSidebar} />)

    pressEscape(document.body)

    expect(closeSidebar).toHaveBeenCalledTimes(1)
  })

  it("OVL-007 IME 组合期不派发：isComposing 时无浮层关闭，也不消费事件", () => {
    const closeSidebar = vi.fn()
    mountDispatcher()
    render(<SidebarDouble onClose={closeSidebar} />)
    const downstream = observeKeydownDownstream()

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape", isComposing: true })

    expect(closeSidebar).not.toHaveBeenCalled()
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    // 组合期事件不被分发器消费（交给输入法/编辑器），故下游仍能看到。
    expect(downstream.received).toHaveLength(1)
    downstream.stop()
  })

  it("OVL-007 组合期兜底：keyCode 229 同样不派发", () => {
    const closeSidebar = vi.fn()
    mountDispatcher()
    render(<SidebarDouble onClose={closeSidebar} />)

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape", keyCode: 229 })

    expect(closeSidebar).not.toHaveBeenCalled()
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
  })

  it("非 Escape 键不派发：其他键不受影响", () => {
    const closeSidebar = vi.fn()
    mountDispatcher()
    render(<SidebarDouble onClose={closeSidebar} />)
    const downstream = observeKeydownDownstream()

    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" })

    expect(closeSidebar).not.toHaveBeenCalled()
    expect(downstream.received).toHaveLength(1)
    downstream.stop()
  })
})
