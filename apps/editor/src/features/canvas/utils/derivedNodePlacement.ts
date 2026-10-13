import type { GraphNode, NodePosition } from '../types';

export const DERIVED_NODE_OFFSET_X = 260;
export const DERIVED_NODE_WIDTH_ESTIMATE = 240;
export const DERIVED_NODE_HEIGHT_ESTIMATE = 180;

export const isOverlapping = (
  nodes: GraphNode[],
  x: number,
  y: number,
  options: {
    nodeWidthEstimate: number | undefined;
    nodeHeightEstimate: number | undefined;
  } | undefined
): boolean => {
  const nodeWidthEstimate = (options !== null && options !== undefined ? options.nodeWidthEstimate : undefined) ?? DERIVED_NODE_WIDTH_ESTIMATE;
  const nodeHeightEstimate = (options !== null && options !== undefined ? options.nodeHeightEstimate : undefined) ?? DERIVED_NODE_HEIGHT_ESTIMATE;

  return nodes.some((node) => {
    const nx = (node.position !== null && node.position !== undefined ? node.position.x : undefined) ?? 0;
    const ny = (node.position !== null && node.position !== undefined ? node.position.y : undefined) ?? 0;
    return Math.abs(nx - x) < nodeWidthEstimate && Math.abs(ny - y) < nodeHeightEstimate;
  });
};

export const computeDerivedNodePosition = (
  sourceNode: GraphNode,
  existingNodes: GraphNode[],
  options: {
    offsetX: number | undefined;
    nodeWidthEstimate: number | undefined;
    nodeHeightEstimate: number | undefined;
    yStep: number | undefined;
  } | undefined
): NodePosition => {
  const offsetX = (options !== null && options !== undefined ? options.offsetX : undefined) ?? DERIVED_NODE_OFFSET_X;
  const nodeHeightEstimate = (options !== null && options !== undefined ? options.nodeHeightEstimate : undefined) ?? DERIVED_NODE_HEIGHT_ESTIMATE;
  const yStep = (options !== null && options !== undefined ? options.yStep : undefined) ?? nodeHeightEstimate;

  const baseX = ((sourceNode.position !== null && sourceNode.position !== undefined ? sourceNode.position.x : undefined) ?? 0) + offsetX;
  const baseY = (sourceNode.position !== null && sourceNode.position !== undefined ? sourceNode.position.y : undefined) ?? 0;

  let currentY = baseY;
  while (isOverlapping(existingNodes, baseX, currentY, options)) {
    currentY += yStep;
  }

  return { x: baseX, y: currentY };
};

