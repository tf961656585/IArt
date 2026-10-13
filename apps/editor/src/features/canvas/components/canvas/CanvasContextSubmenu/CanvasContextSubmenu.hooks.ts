'use client';

/**
 * 对象右键菜单子菜单的状态与生命周期。
 *
 * 语义：触发项本身不承载动作，展开子菜单是其唯一行为；同时最多展开一个子菜单，
 * 展开/收起由「指针停留达延迟」「激活」与「离开达延迟」三条路径驱动
 *（spec：docs/editor/画布对象右键菜单.md §5.2 / §5.3）。
 *
 * 展开态由宿主（CanvasContextMenu）持有：子菜单必须与主菜单一并关闭，
 * 因此关闭权不能下放到子菜单自身。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ContextMenuSubmenuTrigger } from '../../../types/clipboard';
import type { CanvasContextSubmenuRequest } from './CanvasContextSubmenu.types';

/** 指针停留在触发项上达该时长后展开子菜单（spec §5.3）。 */
export const SUBMENU_OPEN_DELAY_MS = 100;
/** 指针离开触发项与子菜单达该时长后收起子菜单（spec §5.3）。 */
export const SUBMENU_CLOSE_DELAY_MS = 150;

type UseCanvasContextSubmenuArgs = {
  /** 菜单是否打开：菜单关闭时清空展开态与定时器 */
  open: boolean;
};

export const useCanvasContextSubmenu = ({ open }: UseCanvasContextSubmenuArgs) => {
  const [request, setRequest] = useState<CanvasContextSubmenuRequest | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  // 回调经 ref 读取最新展开态，使各回调引用稳定（宿主 effect 不随每次渲染重跑）
  const requestRef = useRef<CanvasContextSubmenuRequest | null>(null);
  requestRef.current = request;

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  /** 收起子菜单；`restoreFocus` 为真时把焦点交还触发项（spec §5.5）。 */
  const close = useCallback(
    (restoreFocus: boolean) => {
      clearTimers();
      const anchorEl = requestRef.current !== null ? requestRef.current.anchorEl : null;
      setRequest(null);
      if (restoreFocus && anchorEl !== null && anchorEl.isConnected) {
        anchorEl.focus();
      }
    },
    [clearTimers],
  );

  /** 指针进入触发项：取消关闭延迟，达打开延迟后展开（已在同项上展开时不重开）。 */
  const scheduleOpen = useCallback(
    (anchorEl: HTMLElement, item: ContextMenuSubmenuTrigger) => {
      if (!open || item.disabled === true) return;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (requestRef.current !== null && requestRef.current.anchorEl === anchorEl) return;
      // 移到同一菜单的其他项：当前子菜单立即收起（同时最多展开一个）
      if (requestRef.current !== null) setRequest(null);
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null;
        setRequest({ anchorEl, item, focusFirst: false });
      }, SUBMENU_OPEN_DELAY_MS);
    },
    [open],
  );

  /** 指针进入子菜单面板：取消关闭延迟（跨过触发项与面板间隙时不收起）。 */
  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  /** 指针离开触发项或子菜单：达关闭延迟后收起。 */
  const scheduleClose = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (requestRef.current === null) return;
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setRequest(null);
    }, SUBMENU_CLOSE_DELAY_MS);
  }, [cancelScheduledClose]);

  /**
   * 立即展开：键盘激活或点击触发项，焦点交给子菜单内第一个可用控件。
   *
   * 返回是否展开成功（禁用项不展开），供调用方决定是否消费该次激活。
   */
  const openImmediately = useCallback(
    (anchorEl: HTMLElement, item: ContextMenuSubmenuTrigger): boolean => {
      if (item.disabled === true) return false;
      clearTimers();
      setRequest({ anchorEl, item, focusFirst: true });
      return true;
    },
    [clearTimers],
  );

  return useMemo(
    () => ({
      request,
      clearTimers,
      close,
      scheduleOpen,
      scheduleClose,
      cancelScheduledClose,
      openImmediately,
    }),
    [request, clearTimers, close, scheduleOpen, scheduleClose, cancelScheduledClose, openImmediately],
  );
};

export { useCanvasContextSubmenu as default };
