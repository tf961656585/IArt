"use client";

import { useMemo } from "react";
import type { InternalNode } from "@xyflow/react";
import type { GraphNode } from "../../types";
import type { CanvasLayoutSnapshotNode } from "../../store/selectors";
import type { DesiredSize, NodeSize } from "../../types";
import { mergeFlowNodeSizeByNodeId } from "./nodeCanvasFlowProjection";
import {
  buildActualSizeByNodeId,
  buildProjectionSizeByNodeId,
} from "./flowNodeSizeProjection";
import { buildGroupDerivedSize } from "./groupDerivedSize";
import type { GroupDerivedProjection } from "./groupDerivedSize";

type UseFlowProjectionSizingParams = {
  nodeGraphId: string | null;
  graphIdChanged: boolean;
  flowNodeLookup: ReadonlyMap<string, InternalNode> | null | undefined;
  /**
   * ReactFlow 实测失效信号（见 useNodeCanvasFlowModel 的 selectFlowMeasuredFingerprint）。
   *
   * nodeLookup 引用不随实测变化，实测投影的 useMemo 必须把本信号纳入依赖，否则实测通道
   * 会冻结在首帧结果，布局消费方（全局整理 / 容器内整理）拿不到真实尺寸。
   */
  flowMeasuredFingerprint: string;
  flowVisibleLayoutSnapshotNodes: ReadonlyArray<CanvasLayoutSnapshotNode>;
  /** 当前可见的完整图节点（带 data、groupId；用于组节点派生尺寸计算） */
  flowVisibleGraphNodes: ReadonlyArray<GraphNode>;
  desiredSizeByNodeId: Readonly<Record<string, DesiredSize>>;
  renderFallbackSizeByNodeId: Readonly<Record<string, NodeSize>>;
  /**
   * Layout Model 节点尺寸 map（spec：画布启动性能与Layout-Model架构.md）。
   *
   * Layout-Model-Driven 范式下节点尺寸的唯一业务事实源；由调用方从
   * selectLayoutModelByNodeId 订阅后注入。投影链与组节点派生尺寸都把它作为
   * 主优先级档：layoutModel > measured > default。
   */
  layoutModelByNodeId: Readonly<Record<string, NodeSize>>;
  transientDimensions: Readonly<Record<string, NodeSize>>;
};

export const useFlowProjectionSizing = ({
  nodeGraphId,
  graphIdChanged,
  flowNodeLookup,
  flowMeasuredFingerprint,
  flowVisibleLayoutSnapshotNodes,
  flowVisibleGraphNodes,
  desiredSizeByNodeId,
  renderFallbackSizeByNodeId,
  layoutModelByNodeId,
  transientDimensions,
}: UseFlowProjectionSizingParams): {
  actualSizeByNodeId: Record<string, NodeSize>;
  flowNodeSizeByNodeId: Record<string, NodeSize>;
  projectionSizeByNodeId: Record<string, NodeSize>;
  groupDerivedProjection: GroupDerivedProjection;
} => {
  void nodeGraphId;
  void graphIdChanged;

  const actualSizeByNodeId = useMemo<Record<string, NodeSize>>(
    () => buildActualSizeByNodeId(flowNodeLookup, flowVisibleLayoutSnapshotNodes),
    // flowMeasuredFingerprint 是实测失效信号：只用于失效、不参与计算体。
    // exhaustive-deps 无法建模「nodeLookup 原地更新不换引用」这一外部可变源，故显式声明。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flowNodeLookup, flowVisibleLayoutSnapshotNodes, flowMeasuredFingerprint],
  );

  // 组节点派生尺寸（derived size）：由成员几何派生，独立于 desired 收敛链路。
  // 成员尺寸源经 resolveEffectiveSize 统一解析（layoutModel > measured > default），
  // desired 收窄为 runtime 期漂移校准，不进入主优先级链（spec：画布启动性能与Layout-Model架构.md）。
  const groupDerivedProjection = useMemo<GroupDerivedProjection>(
    () => {
      // desired 保留完整 entry（含 state），让 resolveEffectiveSize 按 pending/accepted 分档处理。
      const result = buildGroupDerivedSize({
        nodes: flowVisibleGraphNodes,
        sizeSources: {
          measuredByNodeId: actualSizeByNodeId,
          desiredByNodeId: desiredSizeByNodeId,
          derivedByNodeId: undefined,
          defaultByNodeId: renderFallbackSizeByNodeId,
          layoutModelByNodeId,
        },
      });
      return result;
    },
    [flowVisibleGraphNodes, actualSizeByNodeId, renderFallbackSizeByNodeId, desiredSizeByNodeId, layoutModelByNodeId],
  );

  const flowNodeSizeByNodeId = useMemo<Record<string, NodeSize>>(
    () =>
      mergeFlowNodeSizeByNodeId(
        Object.keys(actualSizeByNodeId).length > 0
          ? { ...renderFallbackSizeByNodeId, ...actualSizeByNodeId }
          : renderFallbackSizeByNodeId,
        transientDimensions,
      ),
    [actualSizeByNodeId, renderFallbackSizeByNodeId, transientDimensions],
  );

  const projectionSizeByNodeId = useMemo<Record<string, NodeSize>>(
    () =>
      buildProjectionSizeByNodeId({
        actualSizeByNodeId,
        desiredSizeByNodeId,
        fallbackSizeByNodeId: renderFallbackSizeByNodeId,
        layoutModelByNodeId,
        nodes: flowVisibleLayoutSnapshotNodes,
        transientDimensions,
      }),
    [
      actualSizeByNodeId,
      desiredSizeByNodeId,
      flowVisibleLayoutSnapshotNodes,
      layoutModelByNodeId,
      renderFallbackSizeByNodeId,
      transientDimensions,
    ],
  );

  return {
    actualSizeByNodeId,
    flowNodeSizeByNodeId,
    projectionSizeByNodeId,
    groupDerivedProjection,
  };
};
