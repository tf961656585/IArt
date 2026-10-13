'use client';

import { useReactFlow } from '@xyflow/react';

/**
 * useOptionalReactFlow — 仅在存在 ReactFlowProvider 祖先时返回实例，否则返回 null。
 *
 * 供非 ReactFlow 组件（如 CanvasObjectFinder 壳层、定位跳转）在无 Provider 的测试/孤立
 * 场景下安全降级，避免 useReactFlow 抛错。
 */
export function useOptionalReactFlow() {
  try {
    return useReactFlow();
  } catch {
    return null;
  }
}
