/**
 * 画布定位请求事件桥（模块侧 → React 树内的统一定位抽象）。
 *
 * 背景：统一定位抽象是 React hook（useLocateToNode，依赖 ReactFlow Provider 上下文），
 * 非 React 模块（如任务投影服务的 toast 动作回调）无法直接调用。本桥用 window
 * CustomEvent 把「定位到某节点」的意图递给画布内的监听 hook（useCanvasLocateRequest），
 * 由它转调统一定位抽象——不绕过定位抽象、不直接操作 viewport，也不自建浮层体系。
 */

export const CANVAS_LOCATE_NODE_REQUEST_EVENT = 'canvas-locate-node-request';

export type CanvasLocateNodeRequestDetail = {
  nodeId: string;
  /** 定位原因（审计留痕用，非用户可见） */
  reason: string;
};

/** 模块侧发起定位请求（fire-and-forget；无监听者时事件自然消散）。 */
export const requestCanvasLocateToNode = (detail: CanvasLocateNodeRequestDetail): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CanvasLocateNodeRequestDetail>(CANVAS_LOCATE_NODE_REQUEST_EVENT, { detail }));
};
