import type { NodeGraph, NodePosition } from "../../types";
import { resolveEffectiveSize, type EffectiveSizeSources } from "../../utils/effectiveSize";

const DERIVED_OFFSET_X = 80;
const NODE_WIDTH_ESTIMATE = 240;
const NODE_HEIGHT_ESTIMATE = 180;

const isOverlapping = (
  nodes: Array<{ position: { x: number | undefined; y: number | undefined } | undefined }>,
  x: number,
  y: number,
): boolean =>
  nodes.some((node) => {
    const nx = (node.position !== null && node.position !== undefined ? node.position.x : undefined) ?? 0;
    const ny = (node.position !== null && node.position !== undefined ? node.position.y : undefined) ?? 0;
    return (
      Math.abs(nx - x) < NODE_WIDTH_ESTIMATE &&
      Math.abs(ny - y) < NODE_HEIGHT_ESTIMATE
    );
  });

export const computeDerivedNodePositionFromGraph = (
  graph: NodeGraph | null | undefined,
  sourceNodeId: string,
  sizeSources: EffectiveSizeSources | undefined,
): NodePosition => {
  const graphNodes = (graph !== null && graph !== undefined ? graph.nodes : undefined) ?? [];
  const sourceNode = graphNodes.find((node) => node.id === sourceNodeId);
  // 尺寸经统一解析入口 resolveEffectiveSize 解析：measured 优先，缺失回退到 desired → default。
  // 当 sizeSources 缺失时，defaultByNodeId 用估算尺寸兜底，保证几何计算有合理占位。
  const sources: EffectiveSizeSources = sizeSources !== null && sizeSources !== undefined
    ? sizeSources
    : {
        measuredByNodeId: undefined,
        desiredByNodeId: undefined,
        derivedByNodeId: undefined,
        defaultByNodeId: sourceNode !== undefined ? { [sourceNodeId]: { width: NODE_WIDTH_ESTIMATE, height: NODE_HEIGHT_ESTIMATE } } : undefined,
        layoutModelByNodeId: undefined,
      };
  const sourceSize = resolveEffectiveSize(sourceNode, sources);
  const baseX =
    ((sourceNode !== null && sourceNode !== undefined && sourceNode.position !== null && sourceNode.position !== undefined ? sourceNode.position.x : undefined) ?? 0) + sourceSize.width + DERIVED_OFFSET_X;
  const baseY = (sourceNode !== null && sourceNode !== undefined && sourceNode.position !== null && sourceNode.position !== undefined ? sourceNode.position.y : undefined) ?? 0;
  let currentY = baseY;
  while (isOverlapping(graphNodes, baseX, currentY)) {
    currentY += NODE_HEIGHT_ESTIMATE;
  }
  return { x: baseX, y: currentY };
};
