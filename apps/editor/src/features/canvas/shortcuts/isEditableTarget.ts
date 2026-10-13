/**
 * 统一输入元素检查工具函数。
 * 用于判断键盘事件的 target 是否为可编辑元素（input、textarea、contenteditable 等），
 * 避免在输入状态下误触画布快捷键。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const closest = target.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
  return closest !== null;
}
