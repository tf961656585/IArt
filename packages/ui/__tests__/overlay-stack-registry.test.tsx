// 浮层栈注册表单元测试（spec docs/editor/浮层堆栈管理.md「契约」）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { isEditableTarget } from "../src/overlay-stack/editable-target"
import {
  getTopOverlayLayer,
  registerOverlayLayer,
  registerOverlayLayerEntry,
} from "../src/overlay-stack/registry"

function topId(): string | null {
  return getTopOverlayLayer()?.id ?? null
}

/** 本用例注册的层，用后统一注销（栈没有「清空」命令式 API，测试自己负责收尾）。 */
const disposers: Array<() => void> = []

function track(unregister: () => void): () => void {
  disposers.push(unregister)
  return unregister
}

beforeEach(() => {
  // 隔离守卫：上一个用例必须把自己的层注销干净（栈空 ⟺ 栈顶为空）。
  expect(getTopOverlayLayer()).toBeNull()
})

afterEach(() => {
  while (disposers.length > 0) {
    disposers.pop()?.()
  }
  expect(getTopOverlayLayer()).toBeNull()
})

describe("registerOverlayLayer / getTopOverlayLayer", () => {
  it("空栈：getTopOverlayLayer 返回 null", () => {
    expect(getTopOverlayLayer()).toBeNull()
  })

  it("LIFO：后注册者在上，注销栈顶后回退到下一层", () => {
    const unregisterFirst = track(registerOverlayLayer({ id: "first", onClose: () => {} }))
    const unregisterSecond = track(registerOverlayLayer({ id: "second", onClose: () => {} }))
    expect(topId()).toBe("second")

    unregisterSecond()
    expect(topId()).toBe("first")

    unregisterFirst()
    expect(getTopOverlayLayer()).toBeNull()
  })

  it("同 id 重复注册：先注销旧条目，新条目落在栈顶", () => {
    const unregisterA = track(registerOverlayLayer({ id: "a", onClose: () => {} }))
    const unregisterB = track(registerOverlayLayer({ id: "b", onClose: () => {} }))
    expect(topId()).toBe("b")

    const closeAgain = vi.fn()
    const unregisterA2 = track(registerOverlayLayer({ id: "a", onClose: closeAgain }))
    // 旧条目已被替换（不是叠加）：栈顶变成新的 a 条目，回调也是新的。
    expect(topId()).toBe("a")
    getTopOverlayLayer()?.onClose()
    expect(closeAgain).toHaveBeenCalledTimes(1)

    // 旧条目的注销函数此时不应误删新条目。
    unregisterA()
    expect(topId()).toBe("a")

    unregisterA2()
    unregisterB()
    // 两个 id 各只剩一条：注销后栈必空（旧 a 条目若残留会留在这里）。
    expect(getTopOverlayLayer()).toBeNull()
  })

  it("注销函数幂等：重复调用不报错也不影响其他层", () => {
    const unregisterA = track(registerOverlayLayer({ id: "a", onClose: () => {} }))
    track(registerOverlayLayer({ id: "b", onClose: () => {} }))

    unregisterA()
    unregisterA()

    expect(topId()).toBe("b")
  })

  it("默认值：closeOnEscape=true、ignoreWhenFocusInEditable=false", () => {
    track(registerOverlayLayer({ id: "defaults", onClose: () => {} }))
    const top = getTopOverlayLayer()
    expect(top?.closeOnEscape).toBe(true)
    expect(top?.ignoreWhenFocusInEditable).toBe(false)
  })

  it("显式配置按传入值透出", () => {
    track(registerOverlayLayer({
      id: "modal",
      onClose: () => {},
      closeOnEscape: false,
      ignoreWhenFocusInEditable: true,
    }))
    const top = getTopOverlayLayer()
    expect(top?.closeOnEscape).toBe(false)
    expect(top?.ignoreWhenFocusInEditable).toBe(true)
  })

  it("onClose 走可变槽位：槽位更新后栈顶读到最新回调，且不重排栈", () => {
    const first = vi.fn()
    const second = vi.fn()
    const slot = { current: first }
    track(
      registerOverlayLayerEntry({
        id: "react-layer",
        closeOnEscape: true,
        ignoreWhenFocusInEditable: false,
        onCloseSlot: slot,
      }),
    )

    slot.current = second

    expect(topId()).toBe("react-layer")
    getTopOverlayLayer()?.onClose()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe("isEditableTarget", () => {
  it("input / textarea 算可编辑（不看只读与禁用态）", () => {
    const input = document.createElement("input")
    const readonlyInput = document.createElement("input")
    readonlyInput.readOnly = true
    const textarea = document.createElement("textarea")
    document.body.append(input, readonlyInput, textarea)

    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(readonlyInput)).toBe(true)
    expect(isEditableTarget(textarea)).toBe(true)
  })

  it("contentEditable 元素及其后代算可编辑", () => {
    const host = document.createElement("div")
    host.setAttribute("contenteditable", "true")
    const child = document.createElement("span")
    host.append(child)
    document.body.append(host)

    expect(isEditableTarget(host)).toBe(true)
    expect(isEditableTarget(child)).toBe(true)
  })

  it("contenteditable=false 不算可编辑；inherit 沿祖先链继续判定", () => {
    const host = document.createElement("div")
    host.setAttribute("contenteditable", "true")
    const disabled = document.createElement("div")
    disabled.setAttribute("contenteditable", "false")
    const inherited = document.createElement("div")
    inherited.setAttribute("contenteditable", "inherit")
    host.append(disabled, inherited)
    document.body.append(host)

    expect(isEditableTarget(disabled)).toBe(false)
    expect(isEditableTarget(inherited)).toBe(true)
  })

  it("普通元素与空 target 不算可编辑", () => {
    const plain = document.createElement("div")
    document.body.append(plain)

    expect(isEditableTarget(plain)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(document)).toBe(false)
  })
})
