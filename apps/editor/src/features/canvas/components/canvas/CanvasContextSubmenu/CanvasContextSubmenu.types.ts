/**
 * 对象右键菜单子菜单类型定义。
 *
 * 子菜单展开态与触发项元素都是 Editor 单进程内的派生态，不跨进程传输，归 Editor 内部类型。
 * spec：docs/editor/画布对象右键菜单.md §5.2 / §5.3 / §5.5。
 */

import type { ContextMenuSubmenuTrigger } from '../../../types/clipboard';

/** 子菜单展开请求：触发项元素 + 触发项自身（承载子菜单内容与无障碍名）。 */
export type CanvasContextSubmenuRequest = {
  /** 触发项元素，子菜单相对它定位 */
  anchorEl: HTMLElement;
  /** 触发项，其 items 为子菜单内容、label 为无障碍名 */
  item: ContextMenuSubmenuTrigger;
  /**
   * 展开后是否把焦点交给子菜单内第一个可用控件。
   *
   * 键盘激活展开（`Enter` / `Space` / `ArrowRight`）与点击展开为 true，
   * 指针停留展开为 false（焦点留在触发项上，避免与悬停态争夺焦点）。
   */
  focusFirst: boolean;
};

export type CanvasContextSubmenuProps = {
  /** 展开请求；null 表示收起 */
  request: CanvasContextSubmenuRequest | null;
  /** 指针进入子菜单：取消关闭延迟（指针跨过触发项与面板间隙时不收起） */
  onPointerEnter: () => void;
  /** 指针离开子菜单：启动关闭延迟 */
  onPointerLeave: () => void;
  /** 请求收起（`Escape`、左方向键），焦点交还触发项 */
  onRequestClose: (restoreFocus: boolean) => void;
};
