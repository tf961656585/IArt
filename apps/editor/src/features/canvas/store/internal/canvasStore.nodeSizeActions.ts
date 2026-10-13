import type { NodeSize } from "../../types";
import {
  type CanvasStoreGet,
  type CanvasStoreSet,
  type NodeGraphActions,
} from "./canvasStore.core";
import { getCachedGraphNodeLookup } from "./canvasStore.shared";
import { isElectronDev } from "@/client/utils/runtimeFlags";
import { logCanvasDebugEvent } from "../../debug/canvasDebug";
import {
  areNodeSizesEqual,
  normalizeNodeSizeProposal,
} from "../../application/nodeSizeRuntime";

/**
 * 节点尺寸运行时动作（spec：画布节点尺寸管理架构.md）。
 *
 * desired（pending → accepted 单向迁移）/ measured（会话态缓存）两条写入路径
 * 都收敛在本文件，与 selectors.nodeSizeRuntime 的读取侧对应。
 */
export const createCanvasNodeSizeActions = (
  set: CanvasStoreSet,
  _get: CanvasStoreGet,
): Pick<
  NodeGraphActions,
  | "submitNodeSizeProposal"
  | "acceptDesiredSize"
  | "clearDesiredSize"
  | "commitMeasuredSizeSnapshot"
> => {
  return ({
  submitNodeSizeProposal: (proposal) => {
    const normalized = normalizeNodeSizeProposal(proposal);
    if (!normalized) return;
    set((state) => {
      if (!state.nodeGraph) return;
      const nodeLookup = getCachedGraphNodeLookup(state);
      const node = nodeLookup.get(normalized.nodeId);
      if (!node) return;
      const prev = state.ui.desiredSizeByNodeId[normalized.nodeId];
      // 幂等短路 1：已 accepted 且 semanticKey + size 一致 → 不重复写入
      if (
        prev &&
        prev.state === "accepted" &&
        prev.semanticKey === normalized.semanticKey &&
        areNodeSizesEqual(prev.size, normalized.desiredSize)
      ) {
        return;
      }
      // 幂等短路 2：pending 态且 semanticKey + size 一致 → 不重复写入
      if (
        prev &&
        prev.state === "pending" &&
        prev.semanticKey === normalized.semanticKey &&
        areNodeSizesEqual(prev.size, normalized.desiredSize)
      ) {
        return;
      }
      // 新提案或提案变化：写入 pending 态 desired
      state.ui.desiredSizeByNodeId[normalized.nodeId] = {
        size: normalized.desiredSize,
        state: "pending",
        semanticKey: normalized.semanticKey,
      };
    });
  },

  acceptDesiredSize: (nodeId) => {
    const safeNodeId = typeof nodeId === "string" ? nodeId.trim() : "";
    if (!safeNodeId) return;
    let acceptedSize: NodeSize | null = null;
    let acceptedSemanticKey: string | null = null;
    set((state) => {
      const desired = state.ui.desiredSizeByNodeId[safeNodeId];
      if (!desired || desired.state !== "pending") return;
      // pending → accepted 单向迁移（spec：画布节点尺寸管理架构.md）
      desired.state = "accepted";
      acceptedSize = desired.size;
      acceptedSemanticKey = desired.semanticKey;
    });
    const finalSize = acceptedSize;
    const finalSemanticKey = acceptedSemanticKey;
    if (!finalSize || !finalSemanticKey) return;
    if (isElectronDev()) {
      logCanvasDebugEvent("canvasStore:acceptDesiredSize", {
        traceScope: "node-size-runtime",
        action: "accept-desired-size",
        nodeId: safeNodeId,
        semanticKey: finalSemanticKey,
        desiredSize: finalSize,
      });
    }
  },

  clearDesiredSize: (nodeId) => {
    const safeNodeId = typeof nodeId === "string" ? nodeId.trim() : "";
    if (!safeNodeId) return;
    set((state) => {
      if (state.ui.desiredSizeByNodeId[safeNodeId]) {
        delete state.ui.desiredSizeByNodeId[safeNodeId];
      }
    });
  },

  commitMeasuredSizeSnapshot: (snapshot) => {
    // 合并当前快照到会话态缓存（spec：画布节点尺寸管理架构.md「measured 的会话态缓存」）。
    // 当前快照即每个节点最近一次 ReactFlow measured，天然是最新值，直接覆盖同 id 旧值。
    // 不回流为 desired，不持久化。
    set((state) => {
      if (!state.ui) return;
      state.ui.lastMeasuredSizeByNodeId = {
        ...state.ui.lastMeasuredSizeByNodeId,
        ...snapshot,
      };
    });
  },

  });
};
