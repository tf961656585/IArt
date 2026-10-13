/**
 * 对齐/分布选中节点 store action。
 *
 * 作用于当前选中节点集（跨组/自由混合），复用 updateNodePositionsBatch 回写
 * （自动处理 companion/group 扩展 + patch history + 组 position 重算）。
 *
 * spec：docs/runtime/画布节点组.md「对齐作用域」
 */

import { toast } from 'sonner';
import { computeAlignment, isDistributeMode, type AlignmentMode } from '../../layout/alignment';
import { isContainerNode } from '../../services/groupMembership';
import { resolveEffectiveSizeByNodeId } from '../../utils/effectiveSize';
import { normalizeNodeGraphSettings, normalizeSnapGrid } from '../../types/nodeGraph';
import { projectDesiredSizeMapForLayout } from './canvasStore.layoutActions';
import type { EffectiveSizeSources } from '../../utils/effectiveSize';
import type { CanvasStoreGet, CanvasStoreSet, NodeGraphActions } from './canvasStore.core';

/** 对齐/分布的默认间距（分布模式用） */
const DEFAULT_DISTRIBUTE_GAP = 80;

export const createCanvasAlignmentActions = (
  set: CanvasStoreSet,
  get: CanvasStoreGet,
): Pick<NodeGraphActions, 'alignSelection'> => {
  return {
    alignSelection: (mode) => {
      const { nodeGraph, selectedNodeIds } = get();
      if (!nodeGraph || selectedNodeIds.length === 0) return;

      // 触发条件校验
      const needsDistribute = isDistributeMode(mode);
      const minNodes = needsDistribute ? 3 : 2;
      if (selectedNodeIds.length < minNodes) {
        toast.info(needsDistribute ? '分布需要至少 3 个节点' : '对齐需要至少 2 个节点');
        return;
      }

      // 取选中节点对象（排除容器节点——组 | Agent 容器的 position 是派生量，不能被对齐操作改写；
      // 对齐/分布只作用于非容器节点，AG-CN-009）
      const selectedSet = new Set(selectedNodeIds);
      const selectedNodes = nodeGraph.nodes.filter(
        (n) => selectedSet.has(n.id) && !isContainerNode(n),
      );
      if (selectedNodes.length < minNodes) {
        toast.info(needsDistribute ? '分布需要至少 3 个节点' : '对齐需要至少 2 个节点');
        return;
      }

      const normalizedSettings = normalizeNodeGraphSettings(nodeGraph.settings);

      // 尺寸来源：选中节点通常在视口内，measured 优先；缺失时用 store 会话态缓存兜底
      const sizeSources: EffectiveSizeSources = {
        measuredByNodeId: get().ui.lastMeasuredSizeByNodeId,
        desiredByNodeId: projectDesiredSizeMapForLayout(get().ui.desiredSizeByNodeId),
        derivedByNodeId: undefined,
        defaultByNodeId: undefined,
        layoutModelByNodeId: undefined,
      };
      const sizeByNodeId = resolveEffectiveSizeByNodeId(selectedNodes, sizeSources);

      // 组装对齐输入
      const alignableNodes = selectedNodes.map((n) => ({
        id: n.id,
        position: n.position,
        size: sizeByNodeId[n.id] ?? { width: 220, height: 120 },
      }));

      const positions = computeAlignment(
        alignableNodes,
        mode,
        DEFAULT_DISTRIBUTE_GAP,
        normalizeSnapGrid(normalizedSettings.snapGrid),
      );
      if (!positions) return;

      // 转为 updateNodePositionsBatch 的 payload
      const payload = Object.entries(positions).map(([id, position]) => ({ id, position }));
      if (payload.length === 0) return;

      get().updateNodePositionsBatch(payload);

      const modeLabel = alignmentModeLabel(mode);
      toast.success(modeLabel, { description: `调整了 ${payload.length} 个节点` });
    },
  };
};

/** 对齐模式的中文名称（用于 toast 反馈） */
const alignmentModeLabel = (mode: AlignmentMode): string => {
  const labels: Record<AlignmentMode, string> = {
    left: '已左对齐',
    centerHorizontal: '已水平居中',
    right: '已右对齐',
    top: '已顶对齐',
    centerVertical: '已垂直居中',
    bottom: '已底对齐',
    distributeHorizontal: '已水平分布',
    distributeVertical: '已垂直分布',
  };
  return labels[mode];
};
