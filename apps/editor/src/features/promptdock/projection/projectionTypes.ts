import type { RuntimeTaskFailure } from '@iart/contracts';

/**
 * 任务节点 / 资产节点投影的 Editor-local 类型（Todo 6）。
 *
 * 任务/资产节点投影容器是 Editor-local 对象，归 Editor 内部类型（AGENTS.md 契约层级判定）；
 * 其持有的运行域引用结构（RuntimeRef / RuntimeTaskFailure）由 contracts 定义。禁止在本文件
 * 复制跨边界 DTO 字段 schema。
 *
 * 单一事实源：TaskNodeData / AssetNodeData / TaskNodeStatus / TaskProjectionDisposition 的
 * 唯一 owner 是 features/canvas/types/taskNode.ts（画布节点数据层）；本文件仅复用，不并列维护。
 */
export type {
  AssetNodeData,
  TaskNodeData,
  TaskNodeStatus,
  TaskProjectionDisposition,
} from '@/features/canvas/types/taskNode';

// 显式保留对运行域失败结构的引用，便于下游在本模块内以单一导入点消费。
export type { RuntimeTaskFailure };
