import type { NodeGraph, GraphNode } from '../types';
import { cloneJsonValue } from '@iart/contracts';
import { stripNodeRuntimeLayoutFromNode } from '../utils/nodeSize';
import { stripNodeRuntimeProjectionForPersistence } from '../utils/nodeRuntimeProjectionStrip';
import { generateNodeGraphId } from '../types/nodeGraph';

const cloneNodeGraph = (nodeGraph: NodeGraph): NodeGraph => {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(nodeGraph);
    }
  } catch {
    // ignore
  }
  return cloneJsonValue(nodeGraph);
};

/**
 * 剥离节点运行态：layout 尺寸字段 + taskInfo 运行态投影。
 *
 * 与 SQLite delta 链路（canvasStore.persistence.ts 的 sanitizeNodeForDelta）保持
 * 同口径，复用共享 utils，禁止 bundle 与 SQLite 出现裁剪分裂。
 * 依据见 docs/runtime/模型节点内嵌结果区正式内容与运行时状态边界.md
 * 「异步生命周期节点的 taskInfo 持久化边界」段。
 */
const stripNodeRuntimeState = (node: GraphNode): GraphNode =>
  stripNodeRuntimeProjectionForPersistence(stripNodeRuntimeLayoutFromNode(node));

/**
 * 清理 NodeGraph 用于导出
 * - 移除运行时状态
 * - 更新 updatedAt
 */
export const sanitizeNodeGraphForExport = (nodeGraph: NodeGraph): NodeGraph => {
  const snapshot = cloneNodeGraph(nodeGraph);
  return {
    ...snapshot,
    id: snapshot.id || generateNodeGraphId(),
    nodes: snapshot.nodes.map(stripNodeRuntimeState),
    meta: {
      ...snapshot.meta,
      updatedAt: new Date().toISOString(),
    },
  };
};
