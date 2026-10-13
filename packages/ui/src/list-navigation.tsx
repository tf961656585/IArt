"use client"

/**
 * 列表键盘导航基元（两形态），供多个「弹出列表选择」表面收编各自手写的键盘导航。
 *
 * 形态 1 `useListNavigation` —— combobox 型候选列表导航（焦点停留在外部输入框，高亮索引由
 * 本 hook 持有）。行为对齐 `usePromptTriggerSuggestion` 现状：open/query 变化时索引重置 0、
 * 候选数变化时 clamp、Enter/Tab 选中、Shift+Enter 让位换行、IME 组合期让位、候选为空不劫持；
 * 并补齐 Home/End 与可选的循环 wrap（默认开启循环；迁移 usePromptTriggerSuggestion 时传
 * `wrap: false` 保持其「无循环」现状）。
 *
 * 形态 2 `useRovingListNavigation` —— 菜单/分组控件 roving 导航（真实焦点在项间移动）。
 * 行为对齐 PromptDockFrameControl 的 useRovingKeyDown：方向键在项间移动、wrap 循环、
 * Home/End 跳首尾；并补齐「禁用项跳过」。兼容「容器内是普通 button 列表」的画布右键菜单
 * 结构（CanvasContextMenuList）。Enter/Space 激活由原生 button 语义承担，本 hook 不拦截。
 *
 * 职责边界：
 * - Esc 不归本模块：Esc 统一走浮层栈（overlay-stack 的 useOverlayLayer / isEscapeEvent），
 *   本模块不读不写 Escape。
 * - 悬停与键盘共用同一高亮索引（形态 1）：`activeIndex` 是唯一事实源。消费方在列表项上挂
 *   `onPointerMove={() => setActiveIndex(index)}` 即完成悬停同步，列表项高亮一律由
 *   `index === activeIndex` 派生（如 `data-active`）。不要在列表项上另维护第二本 hover
 *   高亮账——cmdk `Item` 会用内部选中态覆盖外部传入的 `data-selected`，双账必然漂移。
 * - 「是否已消费」契约：`handleKeyDown` 返回 `true` 表示该键已被本基元消费（已
 *   preventDefault），返回 `false` 表示完全让位（未 preventDefault、未改状态）。是否追加
 *   stopPropagation 由消费方按返回值自行决定——原生 capture 监听场景参考
 *   usePromptTriggerSuggestion：消费时 preventDefault + stopPropagation。
 * - `handleKeyDown` 闭包随配置变化重建：经原生 `addEventListener` 挂载时，必须把返回的
 *   处理器列入监听 effect 的依赖数组（与 usePromptTriggerSuggestion 的重订阅模式一致），
 *   否则会拿到过期索引/过期候选数。
 * - jsdom 安全：滚动跟随依赖 `scrollIntoView`，无布局环境（未实现/未 polyfill）时静默跳过，
 *   不抛错。
 */

import * as React from "react"

/**
 * 列表导航按键的最小结构形状（`KeyboardEvent` 的结构子集，便于非 DOM 场景复用，
 * 模式同 overlay-stack 的 `EscapeKeyEventLike`）。
 *
 * React 合成 `KeyboardEvent` 与原生 `KeyboardEvent` 都结构兼容：
 * 消费方可以把返回的 `handleKeyDown` 直接挂到 `onKeyDown` / `onKeyDownCapture`，
 * 也可以在原生 `addEventListener("keydown", handler, { capture: true })` 里直接调用。
 */
export interface ListNavKeyEventLike {
  /** `KeyboardEvent.key`。 */
  key: string
  /** 是否按住 Shift（形态 1 用它判定 Shift+Enter 让位换行）。 */
  shiftKey: boolean
  /** 输入法组合期标记：组合中的按键属于 IME，导航与选中一律让位。 */
  isComposing?: boolean
  /** 组合期兜底信号：部分环境组合期 `isComposing` 为 false 而 `keyCode` 为 229。 */
  keyCode?: number
  /** 消费按键时由本基元调用；消费方按返回值决定是否追加 stopPropagation。 */
  preventDefault(): void
}

/** 判定按键是否处于 IME 组合期（组合中回车/方向键属于输入法，不参与候选导航）。 */
function isImeComposing(event: ListNavKeyEventLike): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/** 形态 1 配置。 */
export interface ListNavigationConfig {
  /**
   * 当前候选数量（通常即过滤后候选数组长度）。取数函数不收——数量随过滤实时变化，
   * 直接传数值让 React 渲染流自然携带新值，避免闭包过期。0 表示空候选：所有按键让位。
   */
  count: number
  /** 弹层是否打开；关闭时 keydown 处理器对所有按键一律让位。 */
  open: boolean
  /**
   * 重置键：值变化（Object.is 比较）时高亮索引归 0。传原始值（open/query 的组合串，
   * 如 `` `${open}:${query}` ``），对象每渲染都是新引用会导致索引被不断清零。
   * 不传则只做候选数变化时的 clamp，不做主动重置。
   */
  resetKey?: string | number | boolean | null | undefined
  /**
   * 方向键到边界后是否绕回循环。默认 true（CanvasObjectFinder 语义）；
   * 迁移 usePromptTriggerSuggestion 现状（ArrowUp/Down 无循环）时传 false（clamp 到边界）。
   */
  wrap?: boolean | undefined
  /**
   * Enter / Tab 选中回调，入参为当前高亮索引。未提供时 Enter/Tab 不消费（完全让位）。
   * 约定：`count` 与候选数组长度一致（消费方按同一份候选派生两者），因此索引必然落在
   * 有效候选上；`onSelect` 内无需再做越界兜底。
   */
  onSelect?: ((index: number) => void) | undefined
}

/** 形态 1 返回的 API。 */
export interface ListNavigationApi {
  /** 当前高亮索引（悬停与键盘共用的唯一事实源）。 */
  activeIndex: number
  /** 直接写高亮索引（悬停同步入口：列表项 `onPointerMove={() => setActiveIndex(index)}`）。 */
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>
  /**
   * 相对移动高亮索引：`wrap: true` 时循环绕回，`wrap: false` 时 clamp 到 [0, count-1]；
   * count 为 0 时不动作。
   */
  moveActive: (delta: number) => void
  /**
   * 逐项注册元素（滚动跟随用）：列表项上挂 `ref={(element) => setItemRef(index, element)}`。
   * index 用渲染时的下标；项被过滤移除时 React 会以 null 回调注销。
   */
  setItemRef: (index: number, element: HTMLElement | null) => void
  /**
   * 内置 keydown 处理器：ArrowUp/Down（按 wrap 循环或 clamp）、Home/End、Enter/Tab（选中，
   * Shift+Enter 让位换行）、IME 组合期让位、候选为空让位、open 为 false 时全部让位。
   * 返回是否已消费（消费时已 preventDefault）；stopPropagation 策略由消费方决定。
   */
  handleKeyDown: (event: ListNavKeyEventLike) => boolean
}

/**
 * 形态 1：候选列表导航 hook（combobox 型，焦点在外部输入框）。
 *
 * 迁移 usePromptTriggerSuggestion 的接法：`count` 传 `filteredCandidates.length`、
 * `open` 传弹层 open、`resetKey` 传 `` `${open}:${activeQuery}` ``、`onSelect` 里按
 * `activeIndex` 取候选执行既有 `pick`；列表容器仍由消费方持有，本 hook 只要求逐项
 * `setItemRef` 与逐项 `onPointerMove`。
 */
export function useListNavigation(config: ListNavigationConfig): ListNavigationApi {
  const { count, open, resetKey, wrap = true, onSelect } = config

  const [activeIndex, setActiveIndex] = React.useState(0)
  const itemRefs = React.useRef<Map<number, HTMLElement>>(new Map())

  // 重置键变化（open/query 变化）：索引归 0。行为对齐 usePromptTriggerSuggestion 的
  // 「打开/筛选变化时默认选中第一项」。
  React.useEffect(() => {
    setActiveIndex(0)
  }, [resetKey])

  // 候选数变化：索引 clamp 到 [0, count-1]（count 为 0 时归 0），不越界。
  React.useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, count - 1)))
  }, [count])

  const moveActive = React.useCallback(
    (delta: number) => {
      setActiveIndex((prev) => {
        if (count <= 0) return prev
        if (wrap) {
          return (((prev + delta) % count) + count) % count
        }
        return Math.max(0, Math.min(count - 1, prev + delta))
      })
    },
    [count, wrap],
  )

  const setItemRef = React.useCallback((index: number, element: HTMLElement | null) => {
    if (element === null) {
      itemRefs.current.delete(index)
    } else {
      itemRefs.current.set(index, element)
    }
  }, [])

  // 滚动跟随：高亮变化时把对应项滚进可视区。jsdom 无布局（scrollIntoView 未实现）时跳过。
  React.useEffect(() => {
    if (!open) return
    const element = itemRefs.current.get(activeIndex)
    if (element === undefined) return
    if (typeof element.scrollIntoView !== "function") return
    element.scrollIntoView({ block: "nearest" })
  }, [open, activeIndex, count])

  const handleKeyDown = React.useCallback(
    (event: ListNavKeyEventLike): boolean => {
      if (!open) return false
      if (isImeComposing(event)) return false
      if (count === 0) return false
      if (event.key === "ArrowDown") {
        event.preventDefault()
        moveActive(1)
        return true
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        moveActive(-1)
        return true
      }
      if (event.key === "Home") {
        event.preventDefault()
        setActiveIndex(0)
        return true
      }
      if (event.key === "End") {
        event.preventDefault()
        setActiveIndex(count - 1)
        return true
      }
      if (event.key === "Enter" || event.key === "Tab") {
        // Shift+Enter 是换行意图，优先于选候选：不消费，放行给宿主编辑面的换行逻辑。
        if (event.key === "Enter" && event.shiftKey) return false
        if (onSelect === undefined) return false
        event.preventDefault()
        onSelect(activeIndex)
        return true
      }
      return false
    },
    [activeIndex, count, moveActive, onSelect, open],
  )

  return { activeIndex, setActiveIndex, moveActive, setItemRef, handleKeyDown }
}

/** 形态 2 的方向轴配置（discriminated union：grid 档必须给列数，缺列数编译期即报错）。 */
export type RovingOrientation =
  | { kind: "vertical" }
  | { kind: "horizontal" }
  | { kind: "grid"; columns: number }

/** 形态 2 配置。 */
export interface RovingListNavigationConfig {
  /**
   * 容器元素 ref：keydown 查询与 focusItemAt 都从它取项集合。消费方把它挂到列表容器上
   * （画布右键菜单即「普通 button 列表」的容器 div）。
   */
  containerRef: React.RefObject<HTMLElement | null>
  /**
   * 项匹配选择器，默认 `"button"`（兼容普通 button 列表容器）。容器内若存在嵌套按钮
   * （如色板行内的色点），用更精确的选择器（如 `[data-roving-item]`）圈定导航范围。
   */
  itemSelector?: string | undefined
  /** 方向轴，默认 vertical（Up/Down）；horizontal 用 Left/Right；grid 用 Left/Right ±1 且 Up/Down ±columns。 */
  orientation?: RovingOrientation | undefined
  /** 到边界后是否绕回循环，默认 true（roving 惯例）。false 时 clamp 在首尾。 */
  wrap?: boolean | undefined
}

/** 形态 2 返回的 API。 */
export interface RovingListNavigationApi {
  /**
   * 内置 keydown 处理器（挂容器 `onKeyDown` 或原生 capture 监听）：方向键在可聚焦项间移动
   * 真实焦点、wrap 循环、Home/End 跳首尾、禁用项跳过；焦点不在任何项上时，正向键落到首项、
   * 反向键落到末项。返回是否已消费（消费时已 preventDefault）；Enter/Space 不拦截，
   * 激活交给原生 button 语义。
   */
  handleKeyDown: (event: ListNavKeyEventLike) => boolean
  /** 编程式聚焦第 index 个（跳过禁用后的）项；越界为静默 no-op。常用于菜单打开时聚焦首项。 */
  focusItemAt: (index: number) => void
}

/**
 * 形态 2：菜单/分组控件 roving 导航（焦点在项间移动）。
 *
 * 禁用判定取「DOM 真相」：命中选择器的项带 `disabled` 属性（原生 button disabled）或
 * `aria-disabled="true"`（自定义控件）即跳过，不进入导航序列。不管理 roving tabindex——
 * 容器内是原生 button 列表时 Tab 顺序由浏览器语义承担（对齐 CanvasContextMenuList 结构）。
 */
export function useRovingListNavigation(
  config: RovingListNavigationConfig,
): RovingListNavigationApi {
  const { containerRef, itemSelector = "button", orientation = { kind: "vertical" }, wrap = true } =
    config

  const getItems = React.useCallback((): HTMLElement[] => {
    const container = containerRef.current
    if (container === null) return []
    const matched = Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
    return matched.filter(
      (item) =>
        !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true",
    )
  }, [containerRef, itemSelector])

  const focusItemAt = React.useCallback(
    (index: number) => {
      getItems()[index]?.focus()
    },
    [getItems],
  )

  const handleKeyDown = React.useCallback(
    (event: ListNavKeyEventLike): boolean => {
      if (isImeComposing(event)) return false

      if (event.key === "Home" || event.key === "End") {
        const items = getItems()
        if (items.length === 0) return false
        event.preventDefault()
        const target = event.key === "Home" ? items[0] : items[items.length - 1]
        target?.focus()
        return true
      }

      let delta: number | null = null
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        if (orientation.kind === "vertical") return false
        delta = event.key === "ArrowRight" ? 1 : -1
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (orientation.kind === "horizontal") return false
        delta = (event.key === "ArrowDown" ? 1 : -1) * (orientation.kind === "grid" ? orientation.columns : 1)
      } else {
        // Enter/Space 等其余按键：不消费，激活交给原生 button 语义。
        return false
      }

      const items = getItems()
      if (items.length === 0) return false
      const currentIndex = items.findIndex((item) => item === document.activeElement)
      let nextIndex: number
      if (currentIndex < 0) {
        // 焦点不在任何项上（刚打开 / 落在容器上）：正向到首项，反向到末项。
        nextIndex = delta > 0 ? 0 : items.length - 1
      } else if (wrap) {
        nextIndex = (((currentIndex + delta) % items.length) + items.length) % items.length
      } else {
        nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + delta))
      }
      event.preventDefault()
      items[nextIndex]?.focus()
      return true
    },
    [getItems, orientation, wrap],
  )

  return { handleKeyDown, focusItemAt }
}