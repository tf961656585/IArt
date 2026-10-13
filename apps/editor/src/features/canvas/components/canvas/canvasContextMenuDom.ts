/**
 * 画布右键菜单的 DOM 契约选择器。
 *
 * 主菜单与子菜单是两个独立面板：子菜单 portal 到 body，DOM 上不在主菜单内，但它仍是
 * CanvasContextMenu 的 React 子树，React 事件沿 React 树传播——子菜单内的鼠标按下会
 * 经过画布根的 onMouseDownCapture。因此「菜单面」必须作为一个整体登记：菜单内的按下
 * 不得被判成「点击菜单外」而关闭菜单，也不得被当作空白处框选的起点。
 *
 * 新增菜单层（或改属性名）时必须同步维护本模块；漏登记会让该层内的点击在 mousedown
 * 阶段就关掉菜单，被点控件永远收不到 click（2026-09-10 网格行移入子菜单后
 * 「整理为网格」失效即因此，见 useCanvasInteractionController 的 mousedown capture 守卫）。
 */

/** 主菜单面板属性选择器 */
export const CANVAS_CONTEXT_MENU_SELECTOR = '[data-canvas-context-menu]';

/** 子菜单面板属性选择器 */
export const CANVAS_CONTEXT_SUBMENU_SELECTOR = '[data-canvas-context-submenu]';

/** 菜单面（主菜单 + 子菜单）选择器集合：判断"这次按下是否发生在菜单内"的唯一依据 */
export const CANVAS_CONTEXT_MENU_SURFACE_SELECTOR = `${CANVAS_CONTEXT_MENU_SELECTOR},${CANVAS_CONTEXT_SUBMENU_SELECTOR}`;
