'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useOverlayLayer, useRovingListNavigation } from '@iart/ui';

import type { NodeGraph, NodePosition, NodeSize } from '../../types';
import type { ContextMenuTarget } from '../../types/clipboard';
import { getCanvasDeleteShortcutLabel } from '../../shortcuts/deleteKeys';
import { AddToGroupPopover } from './AddToGroupPopover';
import { DeleteFailedNodesConfirmDialog } from './DeleteFailedNodesConfirmDialog';
import { DeleteGroupConfirmDialog } from './DeleteGroupConfirmDialog';
import { CanvasContextMenuList, CANVAS_CONTEXT_MENU_ITEM_SELECTOR } from './CanvasContextMenuList';
import { CanvasContextSubmenu } from './CanvasContextSubmenu';
import { useCanvasContextSubmenu } from './CanvasContextSubmenu/CanvasContextSubmenu.hooks';
import { CANVAS_CONTEXT_SUBMENU_SELECTOR } from './canvasContextMenuDom';
import { buildCanvasContextMenuItems } from './canvasContextMenuItems';
import { useCanvasContextMenuActions } from './useCanvasContextMenuActions';
import type { MenuViewportClampedLayout } from '../../utils/contextMenuViewportClamp';
import { clampMenuLayoutToViewport } from '../../utils/contextMenuViewportClamp';

export interface CanvasContextMenuProps {
  open: boolean;
  target: ContextMenuTarget | null;
  screenPosition: { x: number; y: number };
  onRequestBundleExport: (args: { snippet: NodeGraph; fileBaseName: string }) => void | undefined;
  onRequestBundleImportInsert: (args: { file: File; targetPosition: NodePosition | undefined }) => void | undefined;
  isBundleImportRunning: boolean | undefined;
  /** 节点实测尺寸映射（来自投影层 actualSizeByNodeId），供容器内整理使用真实尺寸防重叠 */
  measuredSizeByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
  /** 容器节点派生尺寸映射（来自投影层 groupDerivedProjection），供整理读取容器真实尺寸 */
  derivedSizeByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
  onClose: () => void;
}

/**
 * 主菜单实测后的布局：视口钳制后的定位 + 内部滚动的最大高度。
 * 钳制数学由 clampMenuLayoutToViewport 纯函数承载（一次收敛、幂等）。
 */
type MenuLayout = MenuViewportClampedLayout;

/** 主菜单 roving 导航的方向轴（vertical：ArrowUp/Down）。模块级常量保持处理器引用稳定。 */
const MENU_ROVING_ORIENTATION = { kind: 'vertical' } as const;

export function CanvasContextMenu({
  open,
  target,
  screenPosition,
  onRequestBundleExport,
  onRequestBundleImportInsert,
  isBundleImportRunning,
  measuredSizeByNodeId,
  derivedSizeByNodeId,
  onClose,
}: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isMacPlatform = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const userAgentData = navigator as Navigator & {
      userAgentData: {
        platform: string | undefined;
      } | undefined;
    };
    const platform = (userAgentData.userAgentData !== null && userAgentData.userAgentData !== undefined ? userAgentData.userAgentData.platform : undefined) ?? navigator.platform ?? '';
    return /mac|iphone|ipad|ipod/i.test(platform);
  }, []);
  const deleteShortcutLabel = useMemo(
    () => getCanvasDeleteShortcutLabel(isMacPlatform),
    [isMacPlatform],
  );
  const actions = useCanvasContextMenuActions({
    target,
    onRequestBundleExport,
    onRequestBundleImportInsert,
    isBundleImportRunning,
    measuredSizeByNodeId,
    derivedSizeByNodeId,
    onClose,
  });
  const {
    request: submenuRequest,
    close: closeSubmenu,
    scheduleOpen: scheduleSubmenuOpen,
    scheduleClose: scheduleSubmenuClose,
    cancelScheduledClose: cancelScheduledSubmenuClose,
    openImmediately: openSubmenuImmediately,
  } = useCanvasContextSubmenu({ open });
  const menuItems = useMemo(
    () =>
      buildCanvasContextMenuItems({
        target,
        isBundleImportRunning,
        deleteShortcutLabel,
        actions,
        screenPosition,
        closeSubmenu: () => closeSubmenu(false),
      }),
    [actions, deleteShortcutLabel, isBundleImportRunning, target, screenPosition, closeSubmenu],
  );

  // 菜单打开时经浮层栈注册（spec docs/editor/浮层堆栈管理.md「业务面接入清单」）：
  // 替代原先自挂的 document Esc 监听；`active` 与实际可见性同口径（open + 有目标 + 有项），
  // 菜单不渲染时不占栈位、不拦画布基底的 Esc。
  useOverlayLayer({
    active: open && target !== null && menuItems.length > 0,
    id: 'canvas-context-menu',
    onClose,
  });

  // 键盘导航（spec §5.5 / CM-010）：方向键在菜单行间移动真实焦点。itemSelector 圈定在
  // menuitem 行级——色板行的色点、网格行的格点是行内嵌套按钮，默认 "button" 选择器会让
  // 方向键陷入行内控件；行内控件自身由 Tab 可达（spec §5.5 内联控制行语义）。
  const { handleKeyDown: handleRovingKeyDown, focusItemAt: focusFirstRovingItem } =
    useRovingListNavigation({
      containerRef: menuRef,
      itemSelector: CANVAS_CONTEXT_MENU_ITEM_SELECTOR,
      orientation: MENU_ROVING_ORIENTATION,
    });

  // 菜单行方向键处理：消费即截断（基元已 preventDefault，这里补 stopPropagation），
  // 避免方向键漏到画布基底（React Flow 的节点方向键移动）；行内控件已消费的按键
  //（defaultPrevented）让行内语义优先，roving 不接手；Enter/Space 不拦截，
  // 激活交给原生 button 语义；Esc 不在此处理，统一走浮层栈。
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event.defaultPrevented && handleRovingKeyDown(event)) {
      event.stopPropagation();
    }
  };

  // 焦点交还（spec §5.5「Escape 关闭菜单并把焦点交还触发对象」「点击菜单外……焦点交还」）：
  // 打开时记录当时焦点元素（右键路径下通常是画布根或此前聚焦的对象；键盘触发路径下即
  // 触发对象本身），菜单经任一路径关闭时交还。浮层栈只裁定 Esc 的关闭权、不承载焦点
  // 归还，因此交还在本组件收口；浮层栈派发的 Esc 已 stopImmediatePropagation，不会
  // 触发画布基底的 Esc 焦点处理，交还不与之竞争。
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const restoreTarget = previous instanceof HTMLElement ? previous : null;
    return () => {
      if (restoreTarget !== null && restoreTarget.isConnected) {
        restoreTarget.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      const eventTarget = event.target;
      if (menuRef.current && !menuRef.current.contains(eventTarget as Node)) {
        // 子菜单挂在 body 顶层，点它不应关闭菜单（spec §5.3）
        const inSubmenu =
          eventTarget instanceof Element &&
          eventTarget.closest(CANVAS_CONTEXT_SUBMENU_SELECTOR) !== null;
        if (!inSubmenu) onClose();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open, onClose]);

  // 子菜单必须与主菜单一并关闭（spec §5.3）：菜单关闭即清理展开态
  useEffect(() => {
    if (!open) closeSubmenu(false);
  }, [open, closeSubmenu]);

  // 重复右键会换掉 target 而不经过关闭（spec §9「关闭旧菜单，按新命中打开新菜单」）：
  // 子菜单内容按旧 target 构建，必须随 target 一起作废，否则会按上一个组的成员数渲染网格
  useEffect(() => {
    closeSubmenu(false);
  }, [target, closeSubmenu]);

  // 主菜单定位视口钳制 + 最大高度：先按自然尺寸实测，再在绘制前经纯函数一次性算出
  // 最终布局（8px 边距，右/下溢出按需左/上翻转；最大高度=视口高−16px 供内部滚动）。
  // 合并菜单（容器段 + 画布段）行数更多，超高时收进滚动容器而不是溢出视口；
  // 子菜单是独立 body 顶层浮层（portal），不受主菜单滚动容器裁剪——锚点的
  // getBoundingClientRect 是视口相对坐标，在滚动容器内取值依然正确（spec §5.3）。
  const [menuLayout, setMenuLayout] = useState<MenuLayout | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setMenuLayout(null);
      return;
    }
    const panel = menuRef.current;
    if (panel === null) return;
    // 尺寸必须取布局尺寸（offsetWidth/offsetHeight），不得用 getBoundingClientRect：
    // 面板带 zoom-in 入场动画，transform 后矩形在动画期间逐帧漂移，而钳制路径的
    // top/left 依赖实测尺寸——逐帧漂移会让「测量→setState→重渲染→再测」永不收敛
    //（React #185 Maximum update depth exceeded，2026-09-25 真机 P0 实证）。
    // 布局尺寸不受 transform 影响，测量稳定后纯函数输出恒定，第二次运行为精确 no-op。
    const layout = clampMenuLayoutToViewport({
      originX: screenPosition.x,
      originY: screenPosition.y,
      width: panel.offsetWidth,
      height: panel.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    // 逐字段判等（位置与尺寸全部覆盖），值未变化时保留旧引用触发 bail-out：
    // actions 每次渲染重建使 menuItems 引用漂移，effect 随之每次渲染重跑；
    // 不判等会让 setState 以新对象无限触发重渲染。
    setMenuLayout((previous) =>
      previous !== null &&
      previous.left === layout.left &&
      previous.top === layout.top &&
      previous.maxHeight === layout.maxHeight
        ? previous
        : layout,
    );
  }, [open, menuItems, screenPosition.x, screenPosition.y]);

  // 打开即入键盘流（spec §5.5「菜单打开后焦点进入第一个可用（非禁用）项」）：实测布局
  // 完成（面板可见，visibility 由 menuLayout 驱动）后聚焦首个可用菜单行；重复右键换
  // target 视同打开新菜单，同样重新入流。focusItemAt 自带禁用项跳过；导航序列为空
  //（如仅有内联控制行）时静默 no-op。
  useEffect(() => {
    if (!open || menuLayout === null) return;
    focusFirstRovingItem(0);
  }, [open, target, menuLayout, focusFirstRovingItem]);

  // 菜单关闭后仍需独立显示的弹层：加入组 popover / 删除组确认框 / 删除失败节点确认框
  const overlays = (
    <>
      <AddToGroupPopover
        request={actions.addToGroupRequest}
        onSelectTargetGroup={actions.handleSelectTargetGroup}
        onCancel={actions.handleCancelAddToGroup}
      />
      <DeleteGroupConfirmDialog
        request={actions.deleteGroupConfirmRequest}
        onConfirm={actions.handleConfirmDeleteGroupWithMembers}
        onCancel={actions.handleCancelDeleteGroupWithMembers}
      />
      <DeleteFailedNodesConfirmDialog
        request={actions.deleteFailedNodesConfirmRequest}
        onConfirm={actions.handleConfirmDeleteFailedNodes}
        onCancel={actions.handleCancelDeleteFailedNodes}
      />
    </>
  );

  if (!open || !target || menuItems.length === 0) {
    // 菜单关闭后仍可能需要显示「加入组」popover / 「删除组及全部成员」/「删除失败节点」确认框
    // （对应 action 先关菜单再开弹层）
    if (
      actions.addToGroupRequest === null &&
      actions.deleteGroupConfirmRequest === null &&
      actions.deleteFailedNodesConfirmRequest === null
    ) {
      return null;
    }
    return overlays;
  }

  return (
    // 右键菜单是瞬时交互弹层，归 popover 海拔：贴近 PromptDock / 弹窗时必须完整可见
    <div className="fixed inset-0 z-popover pointer-events-none">
      <div
        ref={menuRef}
        data-canvas-context-menu
        role="menu"
        // tabIndex=-1：role=menu 面板需可聚焦（jsx-a11y）；不进 Tab 序，导航焦点由
        // roving 落在 menuitem 行上，与子菜单面板同口径。
        tabIndex={-1}
        onKeyDown={handleMenuKeyDown}
        className="absolute pointer-events-auto min-w-[180px] overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
        style={{
          left: menuLayout !== null ? menuLayout.left : screenPosition.x,
          top: menuLayout !== null ? menuLayout.top : screenPosition.y,
          maxHeight: menuLayout !== null ? menuLayout.maxHeight : undefined,
          // 实测钳制前不显示，避免未钳制位置闪现一帧（useLayoutEffect 绘制前生效）
          visibility: menuLayout !== null ? 'visible' : 'hidden',
        }}
      >
        <CanvasContextMenuList
          items={menuItems}
          submenu={{
            activeItemId: submenuRequest !== null ? submenuRequest.item.id : null,
            onTriggerEnter: scheduleSubmenuOpen,
            onTriggerLeave: scheduleSubmenuClose,
            onTriggerActivate: openSubmenuImmediately,
          }}
        />
      </div>
      {/* 子菜单：独立顶层面板，随主菜单一并关闭（spec §5.3） */}
      <CanvasContextSubmenu
        request={submenuRequest}
        onPointerEnter={cancelScheduledSubmenuClose}
        onPointerLeave={scheduleSubmenuClose}
        onRequestClose={(restoreFocus) => closeSubmenu(restoreFocus)}
      />
      {/* 加入组 popover / 删除组确认框：与右键菜单并列渲染，菜单关闭后仍可独立显示 */}
      {overlays}
    </div>
  );
}

export default CanvasContextMenu;
