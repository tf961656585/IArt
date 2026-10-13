import type { GraphNode } from '../types';

import { isUnknownRecord } from '@/client/utils/typeGuards';

type NodeWithLegacyMeasuredSize = GraphNode & {
  measuredSize: unknown | undefined;
};

/**
 * 加载工程时清理历史尺寸字段：
 * - 移除 `node.size`
 * - 移除历史布局尺寸字段
 * - 移除 `data.sizeMode`
 */
export const normalizeNodeSizingOnLoad = <T extends GraphNode>(node: T): T => {
  return stripNodeRuntimeLayoutFromNode(node);
};

export const stripNodeRuntimeLayoutFromNode = <T extends GraphNode>(node: T): T => {
  const rawNode = { ...node } as T & NodeWithLegacyMeasuredSize;
  const { size: _size, measuredSize: _legacyMeasuredSize, ...restNode } = rawNode;
  if (isUnknownRecord(restNode.data)) {
    Reflect.deleteProperty(restNode.data, 'sizeMode');
  }
  return restNode as T;
};
