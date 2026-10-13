import type { NodePosition, NodeSize } from '../types';
import type { EffectiveSizeSources } from '../utils/effectiveSize';

export interface AutoLayoutOptions {
  /** 默认尺寸，用于未测量节点 */
  defaultNodeSize: NodeSize | undefined;
  /** 对齐网格，默认使用画板 snapGrid */
  snapGrid: [number, number] | undefined;
  /**
   * 尺寸来源集合，供统一解析入口 resolveEffectiveSize 使用。
   *
   * 布局算法消费的节点尺寸必须经 resolveEffectiveSize 解析（spec：画布自动布局算法.md 输入契约）。
   * 调用方负责组装 EffectiveSizeSources：
   * - measuredByNodeId：ReactFlow DOM 实测 map（来自 measuredSizeByNodeIdRef），可缺失
   * - desiredByNodeId：业务意图尺寸 map（来自 store desiredSizeByNodeId 的 .size 投影）
   * - defaultByNodeId：按节点 id 的回退尺寸 map（可选）
   * - derivedByNodeId：组节点派生尺寸 map（可选，来自投影层 groupDerivedProjection）
   */
  sizeSources: EffectiveSizeSources | undefined;
  /**
   * 本次排布列数（可选）。
   *
   * 缺省或为 1 时单列垂直摆放（全局整理与默认容器内整理口径）；大于 1 时按列数分行摆放，
   * 行数由节点数与列数决定（spec：画布自动布局算法.md「网格摆放」）。
   * 取值由调用层按本次操作显式给出，不是持久化的布局偏好。
   */
  columns?: number | undefined;
}

export interface AutoLayoutResult {
  /** 每个节点的新坐标 */
  positions: Record<string, NodePosition>;
}
