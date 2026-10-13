import type { ContainerGapKind, ContextMenuTarget, NodePosition } from '../types';

/** 容器内空白命中结果（由 resolveContainerGapHit 产出）。 */
export type ContainerGapHitRef = {
  containerNodeId: string;
  containerKind: ContainerGapKind;
};

export function resolvePaneOrSelectionContextMenuTarget(params: {
  position: NodePosition;
  selectedNodeIds: string[];
  /**
   * 容器内空白命中（可省）。多选优先规则在此收敛：已选中 >1 个节点时右键空白
   * 仍弹多选菜单（containerHit 被忽略）；仅选中 ≤1 时才进入容器内空白判定。
   */
  containerHit?: ContainerGapHitRef | null;
}): ContextMenuTarget {
  const { position, selectedNodeIds, containerHit } = params;
  if (selectedNodeIds.length > 1) {
    return { type: 'selection', nodeIds: selectedNodeIds, position };
  }
  if (containerHit !== null && containerHit !== undefined) {
    return {
      type: 'containerGap',
      containerNodeId: containerHit.containerNodeId,
      containerKind: containerHit.containerKind,
      position,
    };
  }
  return { type: 'pane', position };
}

export type NodeContextMenuSelectionUpdate =
  | { kind: 'none' }
  | { kind: 'select-single'; nodeId: string }
  | { kind: 'select-multi'; nodeIds: string[] };

export type NodeContextMenuBehavior = {
  target: ContextMenuTarget;
  selectionUpdate: NodeContextMenuSelectionUpdate;
};

export type NodeContextMenuBehaviorResolveParams = {
  nodeId: string;
  position: NodePosition;
  selectedNodeIds: string[];
};

export const resolveNodeContextMenuBehavior = (
  params: NodeContextMenuBehaviorResolveParams
): NodeContextMenuBehavior => {
  const isMultiSelect =
    params.selectedNodeIds.length > 1 &&
    params.selectedNodeIds.includes(params.nodeId);
  if (isMultiSelect) {
    return {
      target: { type: 'selection', nodeIds: params.selectedNodeIds, position: params.position },
      selectionUpdate: { kind: 'select-multi', nodeIds: params.selectedNodeIds },
    };
  }

  return {
    target: { type: 'node', nodeId: params.nodeId, position: params.position },
    selectionUpdate: { kind: 'select-single', nodeId: params.nodeId },
  };
};
