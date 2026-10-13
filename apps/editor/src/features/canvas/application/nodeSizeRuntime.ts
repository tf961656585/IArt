import type {
  DesiredSize,
  NodeSize,
  NodeSizeProposal,
} from '../types';
import { SIZE_CONVERGENCE_EPSILON_PX } from '../utils/effectiveSize';

/**
 * desired size 运行时判定与归一化工具。
 *
 * 原 proposal/preview/declared 三态已合并为 desired（pending/accepted 两态）。
 * 本模块不再维护 preview key、preview entry builder 或三态 commit 判定。
 * commit gate 只需 shouldAcceptDesiredSize 布尔判定（actual 是否收敛到 pending desired）。
 */

export type NodeSizeCommitObservation = {
  actualSizeKeyByNodeId: Record<string, string>;
  desiredKeyByNodeId: Record<string, string>;
};

export const EMPTY_NODE_SIZE_COMMIT_OBSERVATION: NodeSizeCommitObservation = {
  actualSizeKeyByNodeId: {},
  desiredKeyByNodeId: {},
};

const toNormalizedNodeSizeKey = (
  size: NodeSize | null | undefined,
): string => {
  const normalized = normalizeRuntimeNodeSize(size);
  if (!normalized) return '';
  return `${normalized.width}x${normalized.height}`;
};

const toDesiredKey = (
  desired: DesiredSize | undefined,
): string => {
  if (!desired) return '';
  const sizeKey = toNormalizedNodeSizeKey(desired.size);
  if (!sizeKey) return '';
  return `${desired.semanticKey}|${desired.state}|${sizeKey}`;
};

export const createNodeSizeCommitObservation = (params: {
  actualSizeByNodeId: Readonly<Record<string, NodeSize>>;
  desiredSizeByNodeId: Readonly<Record<string, DesiredSize>>;
}): NodeSizeCommitObservation => {
  const nextActualSizeKeyByNodeId: Record<string, string> = {};
  const nextDesiredKeyByNodeId: Record<string, string> = {};

  for (const nodeId of Object.keys(params.actualSizeByNodeId)) {
    const sizeKey = toNormalizedNodeSizeKey(params.actualSizeByNodeId[nodeId]);
    if (!sizeKey) continue;
    nextActualSizeKeyByNodeId[nodeId] = sizeKey;
  }

  for (const nodeId of Object.keys(params.desiredSizeByNodeId)) {
    const desiredKey = toDesiredKey(params.desiredSizeByNodeId[nodeId]);
    if (!desiredKey) continue;
    nextDesiredKeyByNodeId[nodeId] = desiredKey;
  }

  return {
    actualSizeKeyByNodeId: nextActualSizeKeyByNodeId,
    desiredKeyByNodeId: nextDesiredKeyByNodeId,
  };
};

export const collectDirtyNodeSizeCommitCandidates = (params: {
  previous: NodeSizeCommitObservation;
  next: NodeSizeCommitObservation;
}): string[] => {
  const nextNodeIds = new Set<string>();

  for (const nodeId of Object.keys(params.previous.actualSizeKeyByNodeId)) {
    nextNodeIds.add(nodeId);
  }
  for (const nodeId of Object.keys(params.previous.desiredKeyByNodeId)) {
    nextNodeIds.add(nodeId);
  }
  for (const nodeId of Object.keys(params.next.actualSizeKeyByNodeId)) {
    nextNodeIds.add(nodeId);
  }
  for (const nodeId of Object.keys(params.next.desiredKeyByNodeId)) {
    nextNodeIds.add(nodeId);
  }

  const changedNodeIds: string[] = [];
  for (const nodeId of nextNodeIds) {
    const prevActualKey = params.previous.actualSizeKeyByNodeId[nodeId] ?? '';
    const nextActualKey = params.next.actualSizeKeyByNodeId[nodeId] ?? '';
    const prevDesiredKey = params.previous.desiredKeyByNodeId[nodeId] ?? '';
    const nextDesiredKey = params.next.desiredKeyByNodeId[nodeId] ?? '';
    if (prevActualKey === nextActualKey && prevDesiredKey === nextDesiredKey) {
      continue;
    }
    changedNodeIds.push(nodeId);
  }

  return changedNodeIds;
};

/**
 * 判断是否应将 pending desired 迁移到 accepted。
 *
 * 条件：desired 存在、处于 pending 态、actual 已收敛到 desired.size（容差以内）。
 * 这是 commit gate 的唯一判定逻辑，替代原三态 commit/clear/keep。
 */
export const shouldAcceptDesiredSize = (params: {
  desired: DesiredSize | undefined;
  actualSize: NodeSize | null | undefined;
}): boolean => {
  if (!params.desired) return false;
  if (params.desired.state !== 'pending') return false;
  return areNodeSizesWithinEpsilon(
    params.desired.size,
    params.actualSize,
    SIZE_CONVERGENCE_EPSILON_PX,
  );
};

export const normalizeRuntimeNodeSize = (
  size: NodeSize | null | undefined,
): NodeSize | null => {
  if (!size) return null;
  const width = Math.round(Number(size.width));
  const height = Math.round(Number(size.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
};

export const areNodeSizesEqual = (
  left: NodeSize | null | undefined,
  right: NodeSize | null | undefined,
): boolean => {
  if (left === right) return true;
  const normalizedLeft = normalizeRuntimeNodeSize(left);
  const normalizedRight = normalizeRuntimeNodeSize(right);
  if (!normalizedLeft || !normalizedRight) {
    return !normalizedLeft && !normalizedRight;
  }
  return (
    normalizedLeft.width === normalizedRight.width &&
    normalizedLeft.height === normalizedRight.height
  );
};

export const areNodeSizesWithinEpsilon = (
  left: NodeSize | null | undefined,
  right: NodeSize | null | undefined,
  epsilonPx: number,
): boolean => {
  const normalizedLeft = normalizeRuntimeNodeSize(left);
  const normalizedRight = normalizeRuntimeNodeSize(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    Math.abs(normalizedLeft.width - normalizedRight.width) <= epsilonPx &&
    Math.abs(normalizedLeft.height - normalizedRight.height) <= epsilonPx
  );
};

export const normalizeNodeSizeProposal = (
  proposal: NodeSizeProposal,
): NodeSizeProposal | null => {
  const safeNodeId =
    typeof proposal.nodeId === 'string' ? proposal.nodeId.trim() : '';
  const safeSemanticKey =
    typeof proposal.semanticKey === 'string' ? proposal.semanticKey.trim() : '';
  const safeReason =
    typeof proposal.reason === 'string' ? proposal.reason.trim() : '';
  const desiredSize = normalizeRuntimeNodeSize(proposal.desiredSize);
  const priority = Number.isFinite(proposal.priority)
    ? Math.round(proposal.priority)
    : 0;
  if (!safeNodeId || !safeSemanticKey || !safeReason || !desiredSize) {
    return null;
  }
  return {
    nodeId: safeNodeId,
    source: proposal.source,
    semanticKey: safeSemanticKey,
    desiredSize,
    priority,
    reason: safeReason,
  };
};
