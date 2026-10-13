'use client';

/**
 * 对象右键菜单子菜单面板。
 *
 * 与主菜单同容器令牌渲染，挂在 body 顶层（不受主菜单滚动容器裁剪）；
 * 定位为触发项右侧展开，右溢出翻到左侧，垂直溢出钳制到视口内
 *（spec：docs/editor/画布对象右键菜单.md §5.2 / §5.3）。
 *
 * 子菜单内容由触发项的 `items` 决定；`ArrowLeft` 收起由本面板的键盘处理承接，
 * 而 `Escape` 逐级关闭由浮层栈裁定——子菜单展开时独立注册为一层（后开在上），
 * 栈序天然给出「先收子菜单、再关菜单」（spec docs/editor/浮层堆栈管理.md 核心规则 3、
 * docs/editor/画布对象右键菜单.md §5.5）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayLayer, useRovingListNavigation } from '@iart/ui';
import type { CanvasContextSubmenuProps } from './CanvasContextSubmenu.types';
import {
  CANVAS_CONTEXT_MENU_ITEM_SELECTOR,
  CanvasContextMenuList,
} from '../CanvasContextMenuList';

/** 触发项与子菜单之间的间距（spec §5.3 定位规则）。 */
const SUBMENU_GAP_PX = 4;
/** 子菜单与视口边缘的安全边距（spec §5.3）。 */
const VIEWPORT_MARGIN_PX = 8;
/** 子菜单 roving 导航的方向轴（vertical：ArrowUp/Down）。模块级常量保持处理器引用稳定。 */
const SUBMENU_ROVING_ORIENTATION = { kind: 'vertical' } as const;

export function CanvasContextSubmenu({
  request,
  onPointerEnter,
  onPointerLeave,
  onRequestClose,
}: CanvasContextSubmenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // 子菜单独立成层（spec「业务面接入清单」右键菜单一行）：展开即入栈、停在主菜单之上。
  // Esc 命中栈顶先收子菜单并把焦点交还触发项（spec §5.5），菜单保持打开；
  // 菜单自身关闭时 request 被宿主清空，本层随之出栈。
  useOverlayLayer({
    active: request !== null,
    id: 'canvas-context-submenu',
    onClose: () => onRequestClose(true),
  });

  const reposition = useCallback(() => {
    if (request === null || panelRef.current === null) return;
    const triggerRect = request.anchorEl.getBoundingClientRect();
    const panelRect = panelRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = triggerRect.right + SUBMENU_GAP_PX;
    if (left + panelRect.width > viewportWidth - VIEWPORT_MARGIN_PX) {
      left = triggerRect.left - panelRect.width - SUBMENU_GAP_PX;
    }
    left = Math.min(
      Math.max(left, VIEWPORT_MARGIN_PX),
      Math.max(VIEWPORT_MARGIN_PX, viewportWidth - panelRect.width - VIEWPORT_MARGIN_PX),
    );

    let top = triggerRect.top;
    if (top + panelRect.height > viewportHeight - VIEWPORT_MARGIN_PX) {
      top = viewportHeight - VIEWPORT_MARGIN_PX - panelRect.height;
    }
    top = Math.max(top, VIEWPORT_MARGIN_PX);

    setPosition({ left: Math.round(left), top: Math.round(top) });
  }, [request]);

  // 实测尺寸后才定位：先渲染在视口外，避免定位抖动（与主菜单同口径）
  useLayoutEffect(() => {
    if (request === null) {
      setPosition(null);
      return;
    }
    reposition();
  }, [request, reposition]);

  // 键盘激活展开时，焦点交给子菜单内第一个可用控件（spec §5.5）
  useEffect(() => {
    if (request === null || !request.focusFirst) return;
    const first = panelRef.current?.querySelector<HTMLElement>(
      'button:not([disabled])',
    );
    first?.focus();
  }, [request]);

  useEffect(() => {
    if (request === null) return;
    const handleViewportChange = () => onRequestClose(false);
    window.addEventListener('resize', handleViewportChange);
    return () => window.removeEventListener('resize', handleViewportChange);
  }, [request, onRequestClose]);

  // 子菜单内 ↑↓ 在可用菜单行间移动真实焦点（spec §5.5）。itemSelector 与主菜单同口径：
  // 圈定在 menuitem 行级，网格行/色板行的行内控件不进 roving 序列，由 Tab 可达；
  // 行内控件已消费的方向键（网格行左右键）天然优先——它们 preventDefault 在先，且
  // roving（vertical）不消费左右键。
  const { handleKeyDown: handleRovingKeyDown } = useRovingListNavigation({
    containerRef: panelRef,
    itemSelector: CANVAS_CONTEXT_MENU_ITEM_SELECTOR,
    orientation: SUBMENU_ROVING_ORIENTATION,
  });

  // `ArrowLeft` 收起子菜单并把焦点交还触发项；↑↓ 交给 roving（消费即截断）。行内控件
  // 若已消费该按键（defaultPrevented，如网格行的左右键在同一预览上移动焦点），让行内
  // 语义优先，roving 不接手（spec §5.5 内联控制行方向语义优先）
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!event.defaultPrevented && handleRovingKeyDown(event)) {
        event.stopPropagation();
        return;
      }
      if (event.key !== 'ArrowLeft' || event.defaultPrevented) return;
      event.preventDefault();
      onRequestClose(true);
    },
    [handleRovingKeyDown, onRequestClose],
  );

  if (request === null) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={request.item.label}
      data-canvas-context-submenu
      tabIndex={-1}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onKeyDown={handleKeyDown}
      className="fixed z-popover w-fit min-w-[180px] max-w-[280px] rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
      style={{
        left: position !== null ? position.left : 0,
        top: position !== null ? position.top : 0,
        visibility: position !== null ? 'visible' : 'hidden',
      }}
    >
      <CanvasContextMenuList items={request.item.items} />
    </div>,
    document.body,
  );
}

export default CanvasContextSubmenu;
