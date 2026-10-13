/**
 * 可编辑元素判定 —— `ignoreWhenFocusInEditable` 的 target 判定（spec 核心规则 5）。
 *
 * spec 只写到「事件 target 落在可编辑元素（input/textarea/contentEditable）内」，
 * 属性级语义由本模块自定，口径如下：
 *
 * - input / textarea：只看标签名，不看 `readOnly` / `disabled`。
 *   keydown 的 target 只能是已获得焦点的元素，禁用元素不可聚焦、不可能是 target，
 *   所以 disabled 分支不可达；只读输入框可以聚焦，且迁移前 RightWorkspace 的
 *   tagName 白名单同样让位（保持现状语义，见 spec「业务面接入清单」右栏一行）。
 *   因此 `type=checkbox` 这类非文本输入框同样算可编辑，这与迁移前行为一致。
 * - contentEditable：沿自身与祖先链找最近的显式 `contenteditable` 声明。
 *   `""` / `true` / `plaintext-only` → 可编辑；`false` → 不可编辑（终止上溯）；
 *   `inherit` → 继续上溯。不走 `HTMLElement.isContentEditable`：jsdom 未实现该属性，
 *   属性链判定在浏览器与测试环境给出同一结果。
 * - 非元素 target（document、window 等）→ 不可编辑。
 */

function toElement(target: EventTarget | null): Element | null {
  if (target === null) return null
  if (typeof Element !== "undefined" && target instanceof Element) return target
  return null
}

function isInsideContentEditable(element: Element): boolean {
  let current: Element | null = element
  while (current !== null) {
    const declared = current.getAttribute("contenteditable")
    if (declared !== null) {
      const normalized = declared.toLowerCase()
      if (normalized === "false") return false
      if (normalized !== "inherit") return true
    }
    current = current.parentElement
  }
  return false
}

/** 事件 target 是否落在可编辑元素内。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = toElement(target)
  if (element === null) return false
  const tagName = element.tagName.toLowerCase()
  if (tagName === "input" || tagName === "textarea") return true
  return isInsideContentEditable(element)
}
