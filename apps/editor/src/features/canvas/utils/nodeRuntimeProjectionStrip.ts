import type { GraphNode } from '../types';

/**
 * 节点运行态投影剥离 —— 共享给所有持久化与交换链路。
 *
 * 职责：从节点 data 中剥离 taskInfo（运行态投影），
 * 同时规范化 runtimeRef（恢复锚点，允许持久化）。
 *
 * model 节点内嵌 resultArea 的 slot 运行态字段不在此处理——由
 * sanitizeNodeGraphResultAreaItemsForPersistence 按 slot 字段白名单重建。
 *
 * 消费方：
 * - SQLite delta 写入链路（canvasStore.persistence.ts）
 * - 工程导出 bundle 链路（export.ts）
 * - 工程导入 bundle 链路（importBundle.ts）
 *
 * 边界依据见 docs/runtime/模型节点内嵌结果区正式内容与运行时状态边界.md
 * 「异步生命周期节点的 taskInfo 持久化边界」段。
 */
interface NodeDataForPersistence {
  taskInfo: unknown | undefined;
  runtimeRef: unknown | undefined;
}

interface RuntimeRefFields {
  taskId: unknown | undefined;
  resultId: unknown | undefined;
  assetId: unknown | undefined;
}

const readRuntimeRefString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/**
 * 剥离节点 data 上的 taskInfo（运行态投影），保留并规范化 runtimeRef（恢复锚点）。
 *
 * resultArea 节点不在此处理：它的运行态字段由 sanitizeNodeGraphResultAreaItemsForPersistence
 * 单独负责（按 slot 字段白名单重建）。
 */
export const stripNodeRuntimeProjectionForPersistence = (node: GraphNode): GraphNode => {
  if (!(node !== null && node !== undefined ? node.data : undefined) || typeof node.data !== 'object') {
    return node;
  }
  const data = node.data as NodeDataForPersistence;
  const existingRuntimeRef =
    data.runtimeRef && typeof data.runtimeRef === 'object' && !Array.isArray(data.runtimeRef)
      ? (data.runtimeRef as RuntimeRefFields)
      : null;
  const taskId = existingRuntimeRef !== null ? readRuntimeRefString(existingRuntimeRef.taskId) : null;
  const resultId = existingRuntimeRef !== null ? readRuntimeRefString(existingRuntimeRef.resultId) : null;
  const assetId = existingRuntimeRef !== null ? readRuntimeRefString(existingRuntimeRef.assetId) : null;
  const runtimeRef = {
    taskId,
    resultId,
    assetId,
  };
  const hasRuntimeRef = Boolean(runtimeRef.taskId || runtimeRef.resultId || runtimeRef.assetId);
  const { taskInfo: _taskInfo, ...rest } = data;
  return {
    ...node,
    data: (hasRuntimeRef ? { ...rest, runtimeRef } : rest) as typeof node.data,
  };
};
