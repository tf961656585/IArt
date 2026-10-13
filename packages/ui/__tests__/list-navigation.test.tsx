// 列表键盘导航基元测试（packages/ui/src/list-navigation.tsx）。
// 覆盖：形态 1 索引状态机（重置/clamp/循环）、keydown 分支（方向键/Home/End/Enter/Tab/
// Shift+Enter 让位/IME 让位/空候选放行/关闭放行）、悬停与键盘同一索引、滚动跟随（含 jsdom
// 无 scrollIntoView 时的安全跳过）；形态 2 roving 焦点移动（jsdom 真实 focus 断言）、
// 禁用项跳过、方向轴、Home/End、Enter/Space 放行。
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useRef } from "react"

import {
  useListNavigation,
  useRovingListNavigation,
  type ListNavKeyEventLike,
  type ListNavigationApi,
  type ListNavigationConfig,
  type RovingListNavigationApi,
  type RovingOrientation,
} from "../src/list-navigation"

/** 构造最小按键事件对象（结构兼容 ListNavKeyEventLike，preventDefault 可观测）。 */
function keyEvent(overrides: Partial<ListNavKeyEventLike> = {}): ListNavKeyEventLike {
  return { key: "ArrowDown", shiftKey: false, preventDefault: vi.fn(), ...overrides }
}

function renderListNav(initial: ListNavigationConfig) {
  return renderHook((props: ListNavigationConfig) => useListNavigation(props), {
    initialProps: initial,
  })
}

describe("useListNavigation 索引状态机", () => {
  it("初始索引为 0", () => {
    const { result } = renderListNav({ count: 3, open: true })
    expect(result.current.activeIndex).toBe(0)
  })

  it("moveActive 默认循环 wrap：末项 +1 回首项，首项 -1 到末项", () => {
    const { result } = renderListNav({ count: 3, open: true })
    act(() => result.current.moveActive(1))
    act(() => result.current.moveActive(1))
    expect(result.current.activeIndex).toBe(2)
    act(() => result.current.moveActive(1))
    expect(result.current.activeIndex).toBe(0)
    act(() => result.current.moveActive(-1))
    expect(result.current.activeIndex).toBe(2)
  })

  it("wrap: false 时 moveActive clamp 在 [0, count-1]", () => {
    const { result } = renderListNav({ count: 3, open: true, wrap: false })
    act(() => result.current.moveActive(1))
    act(() => result.current.moveActive(1))
    expect(result.current.activeIndex).toBe(2)
    act(() => result.current.moveActive(1))
    expect(result.current.activeIndex).toBe(2)
    act(() => result.current.moveActive(-5))
    expect(result.current.activeIndex).toBe(0)
    act(() => result.current.moveActive(-1))
    expect(result.current.activeIndex).toBe(0)
  })

  it("候选数收缩时 clamp；候选清空时归 0", () => {
    const { result, rerender } = renderListNav({ count: 3, open: true })
    act(() => result.current.moveActive(1))
    act(() => result.current.moveActive(1))
    expect(result.current.activeIndex).toBe(2)

    rerender({ count: 1, open: true })
    expect(result.current.activeIndex).toBe(0)

    rerender({ count: 0, open: true })
    expect(result.current.activeIndex).toBe(0)
  })

  it("resetKey 变化时索引归 0（open/query 变化重置入口）", () => {
    const { result, rerender } = renderListNav({
      count: 3,
      open: true,
      resetKey: "true:@",
    })
    act(() => result.current.moveActive(1))
    act(() => result.current.moveActive(1))
    expect(result.current.activeIndex).toBe(2)

    rerender({ count: 3, open: true, resetKey: "true:ad" })
    expect(result.current.activeIndex).toBe(0)
  })

  it("setActiveIndex 是唯一事实源：悬停写入后键盘相对移动基于同一索引", () => {
    const { result } = renderListNav({ count: 3, open: true })
    act(() => result.current.setActiveIndex(1))
    expect(result.current.activeIndex).toBe(1)
    act(() => result.current.moveActive(1))
    expect(result.current.activeIndex).toBe(2)
  })
})

describe("useListNavigation keydown 处理器", () => {
  it("ArrowDown/ArrowUp：消费（preventDefault）且索引按 wrap 移动", () => {
    const { result } = renderListNav({ count: 3, open: true })
    let consumed = false
    act(() => {
      consumed = result.current.handleKeyDown(keyEvent({ key: "ArrowDown" }))
    })
    expect(consumed).toBe(true)
    expect(result.current.activeIndex).toBe(1)

    act(() => {
      consumed = result.current.handleKeyDown(keyEvent({ key: "ArrowUp", shiftKey: false }))
    })
    expect(consumed).toBe(true)
    expect(result.current.activeIndex).toBe(0)
  })

  it("Home/End：消费并跳到首/末", () => {
    const { result } = renderListNav({ count: 3, open: true })
    act(() => result.current.moveActive(1))
    let consumed = false
    act(() => {
      consumed = result.current.handleKeyDown(keyEvent({ key: "End" }))
    })
    expect(consumed).toBe(true)
    expect(result.current.activeIndex).toBe(2)

    act(() => {
      consumed = result.current.handleKeyDown(keyEvent({ key: "Home" }))
    })
    expect(consumed).toBe(true)
    expect(result.current.activeIndex).toBe(0)
  })

  it("Enter/Tab：消费并回调 onSelect(当前索引)", () => {
    const onSelect = vi.fn()
    const { result } = renderListNav({ count: 3, open: true, onSelect })
    act(() => result.current.moveActive(1))

    let consumed = false
    act(() => {
      consumed = result.current.handleKeyDown(keyEvent({ key: "Enter" }))
    })
    expect(consumed).toBe(true)
    expect(onSelect).toHaveBeenCalledWith(1)

    act(() => {
      consumed = result.current.handleKeyDown(keyEvent({ key: "Tab" }))
    })
    expect(consumed).toBe(true)
    expect(onSelect).toHaveBeenLastCalledWith(1)
  })

  it("Shift+Enter 让位：不消费、不 preventDefault、不选中", () => {
    const onSelect = vi.fn()
    const { result } = renderListNav({ count: 3, open: true, onSelect })
    const event = keyEvent({ key: "Enter", shiftKey: true })
    let consumed = true
    act(() => {
      consumed = result.current.handleKeyDown(event)
    })
    expect(consumed).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("IME 组合期让位：isComposing 与 keyCode 229 都不劫持", () => {
    const onSelect = vi.fn()
    const { result } = renderListNav({ count: 3, open: true, onSelect })
    const composing = keyEvent({ key: "Enter", isComposing: true })
    const keyCode229 = keyEvent({ key: "ArrowDown", keyCode: 229 })
    let consumed = true
    act(() => {
      consumed = result.current.handleKeyDown(composing)
    })
    expect(consumed).toBe(false)
    act(() => {
      consumed = result.current.handleKeyDown(keyCode229)
    })
    expect(consumed).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
    expect(result.current.activeIndex).toBe(0)
  })

  it("候选为空时不劫持任何键", () => {
    const onSelect = vi.fn()
    const { result } = renderListNav({ count: 0, open: true, onSelect })
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Tab"]) {
      const event = keyEvent({ key })
      let consumed = true
      act(() => {
        consumed = result.current.handleKeyDown(event)
      })
      expect(consumed).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("open 为 false 时对所有键让位", () => {
    const onSelect = vi.fn()
    const { result } = renderListNav({ count: 3, open: false, onSelect })
    const event = keyEvent({ key: "ArrowDown" })
    let consumed = true
    act(() => {
      consumed = result.current.handleKeyDown(event)
    })
    expect(consumed).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it("未提供 onSelect 时 Enter/Tab 不消费", () => {
    const { result } = renderListNav({ count: 3, open: true })
    let consumed = true
    act(() => {
      consumed = result.current.handleKeyDown(keyEvent({ key: "Enter" }))
    })
    expect(consumed).toBe(false)
    act(() => {
      consumed = result.current.handleKeyDown(keyEvent({ key: "Tab" }))
    })
    expect(consumed).toBe(false)
  })
})

type Form1HarnessProps = {
  apiRef: { current: ListNavigationApi | null }
  count: number
  open?: boolean
  wrap?: boolean
  resetKey?: string
  onSelect?: (index: number) => void
  onWrapperKeyDown?: () => void
}

/** 最小接线宿主：input 挂 keydown（消费即 stopPropagation），列表项挂 ref + onPointerMove。 */
function Form1Harness(props: Form1HarnessProps) {
  const nav = useListNavigation({
    count: props.count,
    open: props.open ?? true,
    wrap: props.wrap,
    resetKey: props.resetKey,
    onSelect: props.onSelect,
  })
  props.apiRef.current = nav
  return (
    /* 测试夹具事件宿主：a11y 语义由真实消费方承载，夹具不模仿 */
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions */
    <div data-testid="wrapper" onKeyDown={props.onWrapperKeyDown}>
      <input
        data-testid="input"
        onKeyDown={(event) => {
          if (nav.handleKeyDown(event)) event.stopPropagation()
        }}
      />
      <div data-testid="list">
        {Array.from({ length: props.count }, (_, index) => (
          <div
            key={index}
            data-testid={`item-${index}`}
            data-active={index === nav.activeIndex ? "true" : undefined}
            ref={(element) => nav.setItemRef(index, element)}
            onPointerMove={() => nav.setActiveIndex(index)}
          />
        ))}
      </div>
    </div>
  )
}

describe("useListNavigation 组件接线", () => {
  it("消费时阻断冒泡、让位时放行（stopPropagation 契约）", () => {
    const onSelect = vi.fn()
    const onWrapperKeyDown = vi.fn()
    const apiRef: { current: ListNavigationApi | null } = { current: null }
    render(
      <Form1Harness
        apiRef={apiRef}
        count={3}
        onSelect={onSelect}
        onWrapperKeyDown={onWrapperKeyDown}
      />,
    )
    const input = screen.getByTestId("input")

    // 消费键：wrapper 不应再收到。
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(onWrapperKeyDown).not.toHaveBeenCalled()

    // 让位键（未匹配键 / Shift+Enter）：放行到 wrapper。
    fireEvent.keyDown(input, { key: "a" })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(onWrapperKeyDown).toHaveBeenCalledTimes(2)
    expect(apiRef.current?.activeIndex).toBe(1)
  })

  it("悬停与键盘共用同一高亮索引（onPointerMove → setActiveIndex → data-active）", () => {
    const apiRef: { current: ListNavigationApi | null } = { current: null }
    render(<Form1Harness apiRef={apiRef} count={3} />)

    fireEvent.pointerMove(screen.getByTestId("item-2"))
    expect(screen.getByTestId("item-2").getAttribute("data-active")).toBe("true")
    expect(screen.getByTestId("item-0").getAttribute("data-active")).toBeNull()

    // 键盘相对移动基于悬停写入的同一索引。
    fireEvent.keyDown(screen.getByTestId("input"), { key: "ArrowUp" })
    expect(screen.getByTestId("item-1").getAttribute("data-active")).toBe("true")
  })

  it("activeIndex 变化时对注册项调用 scrollIntoView({ block: 'nearest' })", () => {
    const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView")
    const apiRef: { current: ListNavigationApi | null } = { current: null }
    render(<Form1Harness apiRef={apiRef} count={3} />)
    scrollIntoViewSpy.mockClear()

    act(() => apiRef.current?.moveActive(1))
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "nearest" })
    expect(scrollIntoViewSpy.mock.contexts[0]).toBe(screen.getByTestId("item-1"))
  })

  it("无 scrollIntoView 的 jsdom 环境静默跳过，不抛错且索引照常移动", () => {
    const original = Element.prototype.scrollIntoView
    Reflect.deleteProperty(Element.prototype, "scrollIntoView")
    try {
      const apiRef: { current: ListNavigationApi | null } = { current: null }
      render(<Form1Harness apiRef={apiRef} count={3} />)
      act(() => apiRef.current?.moveActive(1))
      expect(apiRef.current?.activeIndex).toBe(1)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

type RovingHarnessProps = {
  apiRef: { current: RovingListNavigationApi | null }
  count?: number
  disabledIndexes?: number[]
  ariaDisabledIndexes?: number[]
  orientation?: RovingOrientation
  wrap?: boolean
  itemSelector?: string
}

/** 最小 roving 宿主：容器 div 内平铺普通 button 列表（对齐画布右键菜单结构）。 */
function RovingHarness(props: RovingHarnessProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nav = useRovingListNavigation({
    containerRef,
    itemSelector: props.itemSelector,
    orientation: props.orientation,
    wrap: props.wrap,
  })
  props.apiRef.current = nav
  const count = props.count ?? 4
  const disabled = new Set(props.disabledIndexes ?? [])
  const ariaDisabled = new Set(props.ariaDisabledIndexes ?? [])
    return (
      /* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- 测试夹具事件宿主 */
      <div
        ref={containerRef}
        data-testid="container"
        onKeyDown={(event) => {
          nav.handleKeyDown(event)
        }}
      >
      {Array.from({ length: count }, (_, index) => (
        <button
          key={index}
          type="button"
          data-testid={`btn-${index}`}
          data-roving-item="true"
          disabled={disabled.has(index)}
          aria-disabled={ariaDisabled.has(index) ? "true" : undefined}
        >
          {index}
        </button>
      ))}
    </div>
  )
}

function renderRoving(props?: Omit<RovingHarnessProps, "apiRef">) {
  const apiRef: { current: RovingListNavigationApi | null } = { current: null }
  render(<RovingHarness apiRef={apiRef} {...props} />)
  const button = (index: number) => screen.getByTestId<HTMLButtonElement>(`btn-${index}`)
  const container = screen.getByTestId<HTMLDivElement>("container")
  return { apiRef, button, container }
}

describe("useRovingListNavigation", () => {
  // @spec: CM-010
  it("ArrowDown/ArrowUp 在项间移动真实焦点并 preventDefault", () => {
    const { button, container } = renderRoving()
    button(0).focus()
    expect(document.activeElement).toBe(button(0))

    expect(fireEvent.keyDown(container, { key: "ArrowDown" })).toBe(false)
    expect(document.activeElement).toBe(button(1))

    expect(fireEvent.keyDown(container, { key: "ArrowUp" })).toBe(false)
    expect(document.activeElement).toBe(button(0))
  })

  it("wrap 循环：末项 ArrowDown 回首项，首项 ArrowUp 到末项", () => {
    const { button, container } = renderRoving()
    button(3).focus()
    fireEvent.keyDown(container, { key: "ArrowDown" })
    expect(document.activeElement).toBe(button(0))

    fireEvent.keyDown(container, { key: "ArrowUp" })
    expect(document.activeElement).toBe(button(3))
  })

  it("wrap: false 时 clamp 在首尾", () => {
    const { button, container } = renderRoving({ wrap: false })
    button(3).focus()
    expect(fireEvent.keyDown(container, { key: "ArrowDown" })).toBe(false)
    expect(document.activeElement).toBe(button(3))
    fireEvent.keyDown(container, { key: "ArrowUp" })
    expect(document.activeElement).toBe(button(2))
  })

  it("禁用项跳过（原生 disabled 属性）", () => {
    const { button, container } = renderRoving({ count: 4, disabledIndexes: [1] })
    button(0).focus()
    fireEvent.keyDown(container, { key: "ArrowDown" })
    expect(document.activeElement).toBe(button(2))

    fireEvent.keyDown(container, { key: "ArrowUp" })
    expect(document.activeElement).toBe(button(0))
  })

  it("aria-disabled='true' 的自定义控件项同样跳过", () => {
    const { button, container } = renderRoving({ count: 4, ariaDisabledIndexes: [2] })
    button(1).focus()
    fireEvent.keyDown(container, { key: "ArrowDown" })
    expect(document.activeElement).toBe(button(3))
  })

  it("Home/End 跳到（跳过禁用后的）首/末项", () => {
    const { button, container } = renderRoving({
      count: 4,
      disabledIndexes: [0, 3],
    })
    button(1).focus()
    fireEvent.keyDown(container, { key: "End" })
    expect(document.activeElement).toBe(button(2))
    fireEvent.keyDown(container, { key: "Home" })
    expect(document.activeElement).toBe(button(1))
  })

  it("焦点不在任何项上：正向键落首项，反向键落末项", () => {
    const { container } = renderRoving()
    const buttons = [0, 1, 2, 3].map((index) => screen.getByTestId(`btn-${index}`))
    expect(buttons.some((element) => element === document.activeElement)).toBe(false)
    fireEvent.keyDown(container, { key: "ArrowDown" })
    expect(document.activeElement).toBe(screen.getByTestId("btn-0"))

    fireEvent.keyDown(container, { key: "ArrowUp" })
    expect(document.activeElement).toBe(screen.getByTestId("btn-3"))
  })

  it("Enter/Space 不拦截（激活交给原生 button 语义），未匹配键放行", () => {
    const { button } = renderRoving()
    button(1).focus()
    expect(fireEvent.keyDown(button(1), { key: "Enter" })).toBe(true)
    expect(fireEvent.keyDown(button(1), { key: " " })).toBe(true)
    expect(document.activeElement).toBe(button(1))
  })

  it("orientation vertical 下 ArrowLeft/Right 不消费、焦点不动", () => {
    const { button, container } = renderRoving()
    button(1).focus()
    expect(fireEvent.keyDown(container, { key: "ArrowRight" })).toBe(true)
    expect(fireEvent.keyDown(container, { key: "ArrowLeft" })).toBe(true)
    expect(document.activeElement).toBe(button(1))
  })

  it("orientation horizontal：Left/Right 移动，Up/Down 不消费", () => {
    const { button, container } = renderRoving({ orientation: { kind: "horizontal" } })
    button(1).focus()
    expect(fireEvent.keyDown(container, { key: "ArrowRight" })).toBe(false)
    expect(document.activeElement).toBe(button(2))
    expect(fireEvent.keyDown(container, { key: "ArrowDown" })).toBe(true)
    expect(document.activeElement).toBe(button(2))
  })

  it("orientation grid（columns: 2）：Left/Right ±1，Up/Down ±columns 且循环", () => {
    const { button, container } = renderRoving({
      count: 6,
      orientation: { kind: "grid", columns: 2 },
    })
    button(0).focus()
    fireEvent.keyDown(container, { key: "ArrowRight" })
    expect(document.activeElement).toBe(button(1))
    fireEvent.keyDown(container, { key: "ArrowDown" })
    expect(document.activeElement).toBe(button(3))
    fireEvent.keyDown(container, { key: "ArrowLeft" })
    expect(document.activeElement).toBe(button(2))
    // grid 步长跨行：2 + 2 = 4。
    fireEvent.keyDown(container, { key: "ArrowDown" })
    expect(document.activeElement).toBe(button(4))
    // 越界绕回：4 + 2 = 6 % 6 = 0。
    fireEvent.keyDown(container, { key: "ArrowDown" })
    expect(document.activeElement).toBe(button(0))
  })

  it("focusItemAt 编程式聚焦；越界静默 no-op", () => {
    const { apiRef, button } = renderRoving()
    apiRef.current?.focusItemAt(2)
    expect(document.activeElement).toBe(button(2))

    expect(() => apiRef.current?.focusItemAt(99)).not.toThrow()
    expect(document.activeElement).toBe(button(2))
  })

  it("IME 组合期让位：keyCode 229 不移动焦点", () => {
    const { apiRef, button } = renderRoving()
    button(1).focus()
    let consumed = true
    act(() => {
      consumed = apiRef.current?.handleKeyDown(keyEvent({ key: "ArrowDown", keyCode: 229 })) ?? false
    })
    expect(consumed).toBe(false)
    expect(document.activeElement).toBe(button(1))
  })

  it("容器内无可聚焦项时方向键放行不抛错", () => {
    const apiRef: { current: RovingListNavigationApi | null } = { current: null }
    render(<RovingHarness apiRef={apiRef} count={0} />)
    const container = screen.getByTestId<HTMLDivElement>("container")
    expect(fireEvent.keyDown(container, { key: "ArrowDown" })).toBe(true)
    expect(fireEvent.keyDown(container, { key: "Home" })).toBe(true)
  })

  it("itemSelector 可圈定导航范围（默认 button 之外的自定义标记）", () => {
    const apiRef: { current: RovingListNavigationApi | null } = { current: null }
    function CustomHarness() {
      const containerRef = useRef<HTMLDivElement | null>(null)
      const nav = useRovingListNavigation({
        containerRef,
        itemSelector: "[data-roving-target='true']",
      })
      apiRef.current = nav
      return (
        /* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- 测试夹具事件宿主 */
        <div
          ref={containerRef}
          data-testid="custom-container"
          onKeyDown={(event) => {
            nav.handleKeyDown(event)
          }}
        >
          <span data-roving-target="true" data-testid="cell-0" tabIndex={-1}>
            a
          </span>
          <span data-testid="cell-1" tabIndex={-1}>
            b
          </span>
          <span data-roving-target="true" data-testid="cell-2" tabIndex={-1}>
            c
          </span>
        </div>
      )
    }
    render(<CustomHarness />)
    const cell = (index: number) => screen.getByTestId<HTMLElement>(`cell-${index}`)
    cell(0).focus()
    fireEvent.keyDown(screen.getByTestId("custom-container"), { key: "ArrowDown" })
    // cell-1 不在选择器命中范围内，导航从 cell-0 直接到 cell-2。
    expect(document.activeElement).toBe(cell(2))
  })
})
