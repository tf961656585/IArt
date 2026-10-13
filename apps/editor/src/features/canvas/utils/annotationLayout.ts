import type { CanvasAnnotation, NodePosition, NodeSize, GraphNode } from '../types';
import {
  resolveEffectiveSize,
  type EffectiveSizeSources,
} from './effectiveSize';

const BOUND_TO_NODE_GAP = 10;

const EMPTY_SIZE_SOURCES: EffectiveSizeSources = {
  measuredByNodeId: undefined,
  desiredByNodeId: undefined,
  derivedByNodeId: undefined,
  defaultByNodeId: undefined,
  layoutModelByNodeId: undefined,
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const pickNodeSize = (
  node: GraphNode | null | undefined,
  sources: EffectiveSizeSources,
): NodeSize => resolveEffectiveSize(node ?? null, sources);

export function resolveAnnotationPosition(
  annotation: CanvasAnnotation,
  ctx: {
    nodes: GraphNode[];
    sizeSources: EffectiveSizeSources | undefined;
  }
): NodePosition {
  const binding = annotation.binding;
  if (!binding || binding.type === 'free') return annotation.position;

  const sources: EffectiveSizeSources =
    ctx.sizeSources !== null && ctx.sizeSources !== undefined
      ? ctx.sizeSources
      : EMPTY_SIZE_SOURCES;

  if (binding.type === 'node') {
    const node = ctx.nodes.find((n) => n.id === binding.nodeId);
    if (!node) return annotation.position;
    const size = pickNodeSize(node, sources);
    return {
      x: node.position.x,
      y: node.position.y + size.height + BOUND_TO_NODE_GAP,
    };
  }

  return annotation.position;
}

export function clampAnnotationSize(size: NodeSize): NodeSize {
  const width = clampNumber(Math.round(size.width), 80, 1200);
  const height = clampNumber(Math.round(size.height), 40, 800);
  return { width, height };
}
