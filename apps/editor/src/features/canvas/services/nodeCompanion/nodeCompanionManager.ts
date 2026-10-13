import nodeRegistry, { type NodeDefinition } from '../../nodes/registry';
import type { DynamicRecord } from '@/client/utils/typeGuards';
import { cast } from '@/lib/utils';
import type { GraphNode, NodeGraph, NodePosition } from '../../types';
import type { NodeCompanionDeclaration, NodeCompanionEnsureWhen, NodeCompanionPlacement } from '../../types/nodeCompanion';
import { getDefaultCompanionDeclarationsForNodeType } from './augmentNodeDefinitionCompanions';
import {
  DERIVED_NODE_HEIGHT_ESTIMATE,
  DERIVED_NODE_OFFSET_X,
  DERIVED_NODE_WIDTH_ESTIMATE,
  isOverlapping,
} from '../../utils/derivedNodePlacement';
import { resolveEffectiveSize } from '../../utils/effectiveSize';

type PositionUpdate = { id: string; position: NodePosition };

export type EnsureCompanionsResult = {
  primaryCompanionByKind: Record<string, string>;
  nodesToAdd: GraphNode[];
};

export type EnsureCompanionsContext = {
  reason: NodeCompanionEnsureWhen;
  calculateExecutePlacement: (ownerNode: GraphNode, count: number) => NodePosition[] | undefined;
};

const getOwnerDefinition = (node: GraphNode): NodeDefinition | null => {
  if (node.type === 'model') {
    const modelId = (node.data !== null && node.data !== undefined ? (node.data as { modelId: unknown | undefined }).modelId : undefined);
    if (typeof modelId === 'string' && modelId.trim()) {
      return nodeRegistry.getModelNode(modelId) ?? null;
    }
  }
  return nodeRegistry.get(node.type) ?? null;
};

const getCompanionDeclarationsForOwnerNode = (ownerNode: GraphNode): NodeCompanionDeclaration[] => {
  const ownerDef = getOwnerDefinition(ownerNode);
  const declared = (ownerDef !== null && ownerDef !== undefined ? ownerDef.companions : undefined) ?? [];
  if (declared.length > 0) return declared;
  return getDefaultCompanionDeclarationsForNodeType(ownerNode.type);
};

const getCompanionNodeType = (declaration: NodeCompanionDeclaration): string | null => {
  const def = nodeRegistry.get(declaration.nodeKey);
  return (def !== null && def !== undefined ? def.type : undefined) ?? null;
};

const resolveOwnerIdFromCompanion = (node: GraphNode, bindFieldCandidates: string[]): string | null => {
  const data = cast<DynamicRecord>(node.data);
  for (const field of bindFieldCandidates) {
    const value = data[field];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
};

const collectCompanionBindFieldsByType = (): Map<string, string[]> => {
  const map = new Map<string, Set<string>>();

  for (const decl of getDefaultCompanionDeclarationsForNodeType('model')) {
    if (decl.bind.type !== 'dataField') continue;
    const companionType = getCompanionNodeType(decl);
    if (!companionType) continue;
    const set = map.get(companionType) ?? new Set<string>();
    set.add(decl.bind.ownerNodeIdField);
    map.set(companionType, set);
  }

  for (const def of nodeRegistry.getAllDefinitions()) {
    const companions = def.companions ?? [];
    for (const decl of companions) {
      if (decl.bind.type !== 'dataField') continue;
      const companionType = getCompanionNodeType(decl);
      if (!companionType) continue;
      const set = map.get(companionType) ?? new Set<string>();
      set.add(decl.bind.ownerNodeIdField);
      map.set(companionType, set);
    }
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of map) {
    out.set(k, Array.from(v.values()));
  }
  return out;
};

const buildBindings = (nodeGraph: NodeGraph, bindFieldsByType: Map<string, string[]>) => {
  const ownerByCompanionId = new Map<string, string>();
  const companionIdsByOwnerId = new Map<string, string[]>();
  for (const node of nodeGraph.nodes) {
    const fields = bindFieldsByType.get(node.type);
    if (!fields || fields.length === 0) continue;
    const ownerId = resolveOwnerIdFromCompanion(node, fields);
    if (!ownerId) continue;
    ownerByCompanionId.set(node.id, ownerId);
    const list = companionIdsByOwnerId.get(ownerId) ?? [];
    list.push(node.id);
    companionIdsByOwnerId.set(ownerId, list);
  }
  return { ownerByCompanionId, companionIdsByOwnerId };
};

export const expandPositionUpdatesWithCompanions = (nodeGraph: NodeGraph, payload: PositionUpdate[]): PositionUpdate[] => {
  if (!payload.length) return payload;

  const bindFieldsByType = collectCompanionBindFieldsByType();
  const { ownerByCompanionId, companionIdsByOwnerId } = buildBindings(nodeGraph, bindFieldsByType);

  const oldPosById = new Map(nodeGraph.nodes.map((n) => [n.id, n.position]));
  const nextPosById = new Map(payload.map((p) => [p.id, p.position]));

  const additional = new Map<string, NodePosition>();
  const touchedOwnerIds = new Set<string>();

  for (const [movedId, nextPos] of nextPosById) {
    const prevPos = oldPosById.get(movedId);
    if (!prevPos) continue;
    const dx = nextPos.x - prevPos.x;
    const dy = nextPos.y - prevPos.y;
    if (dx === 0 && dy === 0) continue;

    const ownerId = ownerByCompanionId.get(movedId) ?? movedId;
    const movedIsCompanion = ownerByCompanionId.has(movedId);
    const ownerPos = oldPosById.get(ownerId);
    if (!ownerPos && movedIsCompanion) {
      continue;
    }

    touchedOwnerIds.add(ownerId);

    const groupIds = new Set<string>();
    groupIds.add(ownerId);
    for (const cid of companionIdsByOwnerId.get(ownerId) ?? []) {
      groupIds.add(cid);
    }

    for (const id of groupIds) {
      if (nextPosById.has(id)) continue;
      const oldPos = oldPosById.get(id);
      if (!oldPos) continue;
      const proposed = { x: oldPos.x + dx, y: oldPos.y + dy };
      const existing = additional.get(id);
      if (!existing || (existing.x === proposed.x && existing.y === proposed.y)) {
        additional.set(id, proposed);
      }
    }
  }

  const mergedPosById = new Map<string, NodePosition>();
  for (const p of payload) {
    mergedPosById.set(p.id, p.position);
  }
  for (const [id, position] of additional) {
    mergedPosById.set(id, position);
  }

  let dockAdjusted = false;

  if (touchedOwnerIds.size > 0) {
    const nodeById = new Map(nodeGraph.nodes.map((n) => [n.id, n]));
    for (const ownerId of touchedOwnerIds) {
      const ownerNode = nodeById.get(ownerId);
      if (!ownerNode) continue;

      const ownerNextPos = mergedPosById.get(ownerId) ?? ownerNode.position;

      const ownerForCalc =
        ownerNode.position === ownerNextPos ? ownerNode : ({ ...ownerNode, position: ownerNextPos } as GraphNode);
      const declarations = getCompanionDeclarationsForOwnerNode(ownerForCalc);
      for (const decl of declarations) {
        if ((decl.dock !== null && decl.dock !== undefined ? decl.dock.mode : undefined) !== 'locked') continue;

        const primary = findExistingCompanionNodes(nodeGraph, ownerId, decl)[0] ?? null;
        if (!primary) continue;

        const placement = decl.placement ?? undefined;
        const dock = decl.dock ?? undefined;
        const placementOffsetX =
          placement !== undefined && placement.type === 'derived' && Number.isFinite(Number(placement.offsetX))
            ? Math.round(Number(placement.offsetX))
            : undefined;
        const gapX = dock !== undefined && dock.mode === 'locked' && Number.isFinite(Number(dock.gapX))
          ? Math.round(Number(dock.gapX))
          : (placementOffsetX ?? DERIVED_NODE_OFFSET_X);
        const ownerSize = resolveEffectiveSize(ownerForCalc, {
          measuredByNodeId: undefined,
          desiredByNodeId: undefined,
          derivedByNodeId: undefined,
          defaultByNodeId: { [ownerForCalc.id]: { width: DERIVED_NODE_WIDTH_ESTIMATE, height: DERIVED_NODE_HEIGHT_ESTIMATE } },
          layoutModelByNodeId: undefined,
        });

        const dockPos: NodePosition = {
          x: (ownerNextPos.x ?? 0) + ((ownerSize !== null && ownerSize !== undefined ? ownerSize.width : undefined) ?? 0) + gapX,
          y: ownerNextPos.y ?? 0,
        };

        const existing = mergedPosById.get(primary.id);
        if (!existing || existing.x !== dockPos.x || existing.y !== dockPos.y) {
          dockAdjusted = true;
        }
        mergedPosById.set(primary.id, dockPos);
      }
    }
  }

  if (additional.size === 0 && !dockAdjusted) return payload;

  const merged: PositionUpdate[] = [];
  const payloadIds = new Set(payload.map((p) => p.id));
  for (const p of payload) {
    const position = mergedPosById.get(p.id);
    if (!position) continue;
    merged.push({ id: p.id, position });
  }
  for (const [id, position] of mergedPosById) {
    if (payloadIds.has(id)) continue;
    merged.push({ id, position });
  }
  return merged;
};

export const expandRemovalWithCompanions = (nodeGraph: NodeGraph, nodeIds: string[]): string[] => {
  if (!nodeIds.length) return nodeIds;

  const bindFieldsByType = collectCompanionBindFieldsByType();
  if (bindFieldsByType.size === 0) return nodeIds;

  const { companionIdsByOwnerId } = buildBindings(nodeGraph, bindFieldsByType);
  if (companionIdsByOwnerId.size === 0) return nodeIds;

  const removal = new Set<string>();
  for (const nodeId of nodeIds) {
    if (typeof nodeId === 'string' && nodeId.trim()) {
      removal.add(nodeId);
    }
  }

  const queue = Array.from(removal);
  for (let i = 0; i < queue.length; i += 1) {
    const ownerId = queue[i];
    if (!ownerId) continue;
    const companions = companionIdsByOwnerId.get(ownerId);
    if (!companions) continue;
    for (const companionId of companions) {
      if (removal.has(companionId)) continue;
      removal.add(companionId);
      queue.push(companionId);
    }
  }

  return Array.from(removal);
};

const findExistingCompanionNodes = (
  nodeGraph: NodeGraph,
  ownerNodeId: string,
  declaration: NodeCompanionDeclaration
): GraphNode[] => {
  const bindField = declaration.bind.ownerNodeIdField;
  const companionType = getCompanionNodeType(declaration);
  if (!companionType) return [];

  return nodeGraph.nodes.filter((n) => {
    if (n.type !== companionType) return false;
    const ownerId = cast<DynamicRecord>(n.data)[bindField];
    return ownerId === ownerNodeId;
  });
};

const resolvePlacementForEnsure = (
  nodeGraph: NodeGraph,
  ownerNode: GraphNode,
  declaration: NodeCompanionDeclaration,
  context: EnsureCompanionsContext
): NodePosition => {
  if (context.reason === 'execute' && typeof context.calculateExecutePlacement === 'function') {
    const placements = context.calculateExecutePlacement(ownerNode, 1);
    const p = placements !== null && placements !== undefined && placements.length > 0 ? placements[0] : undefined;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      return p;
    }
  }

  const placementFallback: NodeCompanionPlacement = { type: 'derived', offsetX: undefined, fromRightEdge: undefined, yStep: undefined };
  const placement = declaration.placement ?? placementFallback;
  if (placement.type === 'offset') {
    return { x: ((ownerNode.position !== null && ownerNode.position !== undefined ? ownerNode.position.x : undefined) ?? 0) + placement.dx, y: ((ownerNode.position !== null && ownerNode.position !== undefined ? ownerNode.position.y : undefined) ?? 0) + placement.dy };
  }

  const baseY = (ownerNode.position !== null && ownerNode.position !== undefined ? ownerNode.position.y : undefined) ?? 0;
  const offsetX = Number.isFinite(Number(placement.offsetX)) ? Math.round(Number(placement.offsetX)) : undefined;
  const yStep = Number.isFinite(Number(placement.yStep)) ? Math.max(1, Math.round(Number(placement.yStep))) : undefined;
  const fromRightEdge = placement.fromRightEdge === true;

  const ownerSize = fromRightEdge
    ? resolveEffectiveSize(ownerNode, {
        measuredByNodeId: undefined,
        desiredByNodeId: undefined,
        derivedByNodeId: undefined,
        defaultByNodeId: { [ownerNode.id]: { width: DERIVED_NODE_WIDTH_ESTIMATE, height: DERIVED_NODE_HEIGHT_ESTIMATE } },
        layoutModelByNodeId: undefined,
      })
    : null;

  const baseX =
    ((ownerNode.position !== null && ownerNode.position !== undefined ? ownerNode.position.x : undefined) ?? 0) +
    (fromRightEdge ? ((ownerSize !== null && ownerSize !== undefined ? ownerSize.width : undefined) ?? 0) : 0) +
    (offsetX ?? DERIVED_NODE_OFFSET_X);

  let currentY = baseY;
  const step = yStep ?? DERIVED_NODE_HEIGHT_ESTIMATE;
  while (
    isOverlapping(nodeGraph.nodes, baseX, currentY, {
      nodeWidthEstimate: DERIVED_NODE_WIDTH_ESTIMATE,
      nodeHeightEstimate: DERIVED_NODE_HEIGHT_ESTIMATE,
    })
  ) {
    currentY += step;
  }

  return { x: baseX, y: currentY };
};

export const ensureNodeCompanions = (
  nodeGraph: NodeGraph,
  owners: GraphNode[],
  context: EnsureCompanionsContext
): EnsureCompanionsResult => {
  const nodesToAdd: GraphNode[] = [];
  const primaryCompanionByKind: Record<string, string> = {};

  for (const ownerNode of owners) {
    const ownerDef = getOwnerDefinition(ownerNode);
    const declarations = ownerDef
      ? (ownerDef.companions ?? [])
      : getDefaultCompanionDeclarationsForNodeType(ownerNode.type);
    for (const decl of declarations) {
      if (!decl.ensureWhen.includes(context.reason)) continue;
      if (decl.bind.type !== 'dataField') continue;

      const existing = findExistingCompanionNodes(nodeGraph, ownerNode.id, decl);
      const primary = existing[0] ?? null;
      if (primary) {
        primaryCompanionByKind[decl.kind] = primary.id;
        continue;
      }

      const position = resolvePlacementForEnsure(nodeGraph, ownerNode, decl, context);
      const newNode = nodeRegistry.createNode(decl.nodeKey, position, {
        ...(decl.data ?? {}),
        [decl.bind.ownerNodeIdField]: ownerNode.id,
      });
      if (!newNode) continue;

      nodesToAdd.push(newNode);
      primaryCompanionByKind[decl.kind] = newNode.id;
    }
  }

  return { nodesToAdd, primaryCompanionByKind };
};

export const applyEnsureResultToNodeGraph = (nodeGraph: NodeGraph, result: EnsureCompanionsResult): boolean => {
  let touched = false;

  if (result.nodesToAdd.length > 0) {
    const existingNodeIds = new Set(nodeGraph.nodes.map((n) => n.id));
    for (const node of result.nodesToAdd) {
      if (existingNodeIds.has(node.id)) continue;
      nodeGraph.nodes.push(node);
      existingNodeIds.add(node.id);

      touched = true;
    }
  }

  return touched;
};
