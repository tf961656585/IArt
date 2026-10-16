/**
 * 画布节点占位矩形统一构建（出生落位 / 收口重排等非渲染消费者的共享几何源）。
 *
 * 占位口径（spec：docs/runtime/画布节点尺寸管理架构.md）：
 * - 普通节点：position + resolveEffectiveSize（layoutModel > measured > default 主链），
 *   不再使用固定估计尺寸；
 * - 容器节点（组 | Agent 容器）：按 buildGroupDerivedSize 的派生几何整体占位——
 *   展开态用派生 position + 派生 size（成员包围盒 + padding + 标题高度），折叠态用折叠卡片
 *   position + size。派生计算唯一 owner 就是 buildGroupDerivedSize，本模块不复制第二份派生实现。
 */

import type { EffectiveSizeSources } from './effectiveSize';
import { resolveEffectiveSize } from './effectiveSize';
import { buildGroupDerivedSize } from '../components/canvas/groupDerivedSize';
import type { GraphNode, NodeSize } from '../types';

/** 占位矩形（画布坐标）。 */
export type OccupancyRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BuildNodeOccupancyRectsOptions = {
  /** 排除的节点 id（如正在被替换/移动的节点）；容器被排除时其派生占位一并排除，成员仍占位。 */
  excludeNodeIds?: ReadonlySet<string>;
};

/**
 * 构建既有节点的占位矩形集合。
 *
 * 容器节点的派生 projection 对每个容器节点都有产出（空组/折叠态也有稳定 entry）；
 * 派生 entry 缺失属防御分支：回退 resolveEffectiveSize（含注册表默认值）+ store position，
 * 不静默丢占位（丢占位会让防重叠搜索把新节点排进容器内部）。
 */
export const buildNodeOccupancyRects = (
  nodes: ReadonlyArray<GraphNode>,
  sizeSources: EffectiveSizeSources,
  options?: BuildNodeOccupancyRectsOptions,
): OccupancyRect[] => {
  const excludeNodeIds = options?.excludeNodeIds;
  const derived = buildGroupDerivedSize({ nodes, sizeSources });
  const rects: OccupancyRect[] = [];
  for (const node of nodes) {
    if (excludeNodeIds?.has(node.id)) continue;
    if (node.type === 'group' || node.type === 'agent') {
      const entry = derived.byGroupId[node.id];
      if (entry) {
        rects.push({
          x: entry.position.x,
          y: entry.position.y,
          width: entry.size.width,
          height: entry.size.height,
        });
        continue;
      }
      console.debug('[nodeOccupancy] container derived entry missing, fallback to effective size', {
        nodeId: node.id,
        type: node.type,
      });
    }
    const size: NodeSize = resolveEffectiveSize(node, sizeSources);
    rects.push({ x: node.position.x, y: node.position.y, width: size.width, height: size.height });
  }
  return rects;
};

/** 画布 store 快照的最小形状（避免 utils 反向依赖 store 实现细节）。 */
export type CanvasSizeSourcesState = {
  ui: {
    lastMeasuredSizeByNodeId: Record<string, NodeSize>;
    layoutModelByNodeId: Record<string, NodeSize>;
  };
};

/**
 * 从画布 store 快照组装尺寸来源集合（resolveEffectiveSize 主链输入）。
 *
 * 与 useLocateToNode 的 buildLocateGeometry 同构：measured 用会话态缓存
 * lastMeasuredSizeByNodeId（覆盖视口外节点）；Layout Model 是尺寸唯一业务事实源；
 * desired 不进入主优先级链；容器派生占位由 buildNodeOccupancyRects 内部计算，不在此注入。
 */
export const buildCanvasSizeSources = (state: CanvasSizeSourcesState): EffectiveSizeSources => ({
  measuredByNodeId: state.ui.lastMeasuredSizeByNodeId,
  desiredByNodeId: undefined,
  derivedByNodeId: undefined,
  defaultByNodeId: undefined,
  layoutModelByNodeId: state.ui.layoutModelByNodeId,
});
