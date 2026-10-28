import { create } from 'zustand';

import type { MediaChromeToolId } from './chromeModel';

/**
 * 媒体加工弹窗的打开请求（模块级最小 store）。
 *
 * 加工入口有两处表面（媒体节点选中态工具栏、画布右键菜单），两处都只表达
 * 「对哪个节点用哪个工具」，弹窗本身由 `MediaToolDialogHost` 独占渲染：
 * 入口不持有弹窗状态、不各自接执行器，避免同一工具两个入口两份实现
 * （spec：docs/editor/媒体工具加工.md「禁止同一工具不同入口行为分叉」）。
 */

export type MediaToolDialogRequest = {
  /** 加工主体所在画布节点 id */
  nodeId: string;
  /** 弹窗承载的工具 id（直接变换工具不打开弹窗） */
  toolId: MediaChromeToolId;
};

type MediaToolDialogState = {
  /** 当前打开请求；null 表示没有弹窗 */
  open: MediaToolDialogRequest | null;
};

export const useMediaToolDialogStore = create<MediaToolDialogState>(() => ({
  open: null,
}));

/** 打开某节点上的某工具弹窗（重复调用即替换请求，同一时刻只有一个弹窗）。 */
export const openMediaToolDialog = (
  nodeId: string,
  toolId: MediaChromeToolId,
): void => {
  if (nodeId.trim() === '') return;
  useMediaToolDialogStore.setState({ open: { nodeId, toolId } });
};

/** 关闭弹窗；已关闭时是 no-op（避免宿主清理 effect 触发多余重渲染）。 */
export const closeMediaToolDialog = (): void => {
  if (useMediaToolDialogStore.getState().open === null) return;
  useMediaToolDialogStore.setState({ open: null });
};
