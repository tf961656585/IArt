import type { NodePosition, NodeSize } from '../types';
import type { EffectiveSizeSources } from '../utils/effectiveSize';
import type { OrderChange } from './readingOrder';

export interface AutoLayoutOptions {
  /** 默认尺寸，用于未测量节点 */
  defaultNodeSize: NodeSize | undefined;
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
  /**
   * 本次格子间距（可选，缺省 `NODE_GAP=120`）。
   *
   * 列/行推进量 = 该列最大宽 / 该行最大高 + `nodeGap`，间距**精确**等于该值；
   * 算法不做逐点网格吸附（spec：画布自动布局算法.md「分区内流式摆放」「网格摆放」）。
   * 调用入参，非持久化偏好。
   */
  nodeGap?: number | undefined;
}

export interface AutoLayoutResult {
  /** 每个节点的新坐标 */
  positions: Record<string, NodePosition>;
}

/**
 * 整理排序口径（`--order-mode`）。
 *
 * - `position`（缺省）：视觉阅读序（`orderByReadingPosition`）
 * - `insertion`：调用层传入的数组序（插入序）
 * - `created`：创建时间序；由主进程解析为显式 `order` 后传入，画布侧收到该值时
 *   落 debug 日志并按 `insertion` 处理（spec：画布自动布局算法.md「排序口径」）
 */
export type LayoutOrderMode = 'position' | 'insertion' | 'created';

/** 运行时收窄未知值（CLI 入参 / 旧调用方传参）。 */
export const normalizeLayoutOrderMode = (value: unknown): LayoutOrderMode | undefined => {
  if (value === 'position' || value === 'insertion' || value === 'created') return value;
  return undefined;
};

/**
 * 整理重排摘要（与 CLI `content_reordered` / `order_changes` 一一对应）。
 *
 * `orderChanges` 的槽位是各序列中的 0 基下标；`contentReordered` 表示至少一个节点的
 * 阅读位次发生变化（「整理会洗牌内容」的机器可读信号）。
 */
export type LayoutOrderSummary = {
  contentReordered: boolean;
  orderChanges: OrderChange[];
};

/** 整理（真实执行与 dry-run 同形）返回值。 */
export type LayoutApplyResult = AutoLayoutResult & {
  changedCount: number;
} & LayoutOrderSummary;
