/**
 * Layout Model store actions（spec：画布启动性能与Layout-Model架构.md）。
 *
 * 承载 Layout Model 的全量计算与增量重算入口。Layout Model 是节点尺寸的唯一业务事实源，
 * 启动期一次性全量计算，runtime 期按 nodeId 增量重算。
 *
 * 重新计算的触发条件（spec「重新计算的触发条件」节）：
 * - 加载完成（loadNodeGraph 完成、hydrate 收敛后）→ 全量计算
 * - 节点内容变化（slot 增减、form 字段、折叠态）→ 按 nodeId 增量重算
 * - 媒体 metadata 异步返回 → 通过 urlIndex 反查受影响节点集合 → 增量重算
 * - 节点结构变化（增删、类型变化）→ 增量重算（含受影响 group 节点）
 * - history 恢复（undo/redo 恢复 nodeGraph 后）→ 全量重算，外壳与几何切片随撤销重建
 *   （几何切片无独立历史快照，见 spec「history 恢复口径」）
 *
 * 不重新计算的条件（spec「不重新计算的条件」节）：
 * - ReactFlow node.measured 变化
 * - ResizeObserver 回调
 * - 节点 selection 变化
 * - 节点拖拽中的 live position
 * - 画布 viewport 变化
 *
 * 增量重算 diff 策略（spec L344 实现层裁定）：
 * - 按 nodeId（单节点内容变化场景天然按 nodeId）
 * - 受影响节点集合识别：
 *   - 节点内容变化 → `{changedNodeId}`
 *   - 节点结构变化 → `{changedNodeId}` ∪ {包含该节点的 group 节点 id}
 *   - 媒体 metadata 异步返回 → urlIndex 反查 → 扫描引用该 assetId 的节点
 * - apply 跳过策略：基于 semanticKey 内容指纹
 * - fallback：受影响集合 > 50 节点时退化为全量重算
 */

import type { ProjectMediaAssets } from "@iart/contracts";
import type {
  GraphNode,
  GraphNodeType,
  NodeGraph,
  NodeSize,
} from "../../types";
import {
  computeLayoutModel,
} from "../../layoutModel/computeLayoutModel";
import {
  lookupAssetIdByUrl,
  buildUrlIndex,
} from "../../layoutModel/urlIndex";
import { nodeRegistry } from "../../nodes/registry";
import type {
  CanvasStoreGet,
  CanvasStoreSet,
  NodeGraphActions,
} from "./canvasStore.core";

/**
 * 全量重算 fallback 阈值。
 *
 * 受影响集合超过此值时退化为全量重算（保证正确性，性能次优）。
 */
const FULL_RECOMPUTE_FALLBACK_THRESHOLD = 50;

/**
 * 投影 NodeDefinition 注册表为 `Record<nodeType, defaultSize>`。
 *
 * computeLayoutModel 是纯函数，不读 NodeDefinition 注册表；调用方预先投影为
 * `Record<nodeType, NodeSize>` 传入。
 */
const buildDefaultSizeByNodeType = (): Record<GraphNodeType, NodeSize | undefined> => {
  const all = nodeRegistry.getAllDefinitions();
  const out: Record<GraphNodeType, NodeSize | undefined> = {
    model: undefined,
    imageInput: undefined,
    videoInput: undefined,
    textInput: undefined,
    audioInput: undefined,
    task: undefined,
    asset: undefined,
    agent: undefined,
    group: undefined,
  };
  for (const def of all) {
    if (def.defaultSize !== null && def.defaultSize !== undefined) {
      out[def.type] = def.defaultSize;
    }
  }
  return out;
};

/**
 * 构建 computeLayoutModel 的输入参数（除 nodeGraph / mediaAssets / urlIndex 外）。
 */
const buildComputeInputExtras = () => {
  return {
    defaultSizeByNodeType: buildDefaultSizeByNodeType(),
  };
};

/**
 * 在 store 中合并 layoutModel 结果。
 *
 * 纯函数辅助：根据传入的 byNodeId 增量 merge 到现有 layoutModelByNodeId。
 *
 * @param current 当前 layoutModelByNodeId
 * @param patch 待合并的 byNodeId 子集
 * @returns 合并后的新对象
 */
const mergeLayoutModelByNodeId = (
  current: Readonly<Record<string, NodeSize>>,
  patch: Readonly<Record<string, NodeSize>>,
): Record<string, NodeSize> => {
  const next: Record<string, NodeSize> = { ...current };
  for (const nodeId of Object.keys(patch)) {
    const size = patch[nodeId];
    if (size === null || size === undefined) continue;
    const prev = next[nodeId];
    if (prev !== undefined && prev.width === size.width && prev.height === size.height) {
      // 内容指纹（semanticKey）跳过：尺寸无变化不写入，避免无意义 setState
      continue;
    }
    next[nodeId] = size;
  }
  return next;
};

/**
 * 把一次 computeLayoutModel 输出原子写入 ui 切片。
 */
const applyLayoutModelOutput = (
  s: { ui: { layoutModelByNodeId: Record<string, NodeSize> } },
  output: { byNodeId: Readonly<Record<string, NodeSize>> },
  mode: "overwrite" | "merge",
): void => {
  s.ui.layoutModelByNodeId = mode === "overwrite"
    ? { ...output.byNodeId }
    : mergeLayoutModelByNodeId(s.ui.layoutModelByNodeId, output.byNodeId);
};

/**
 * 画布 Layout Model store 动作（全量/增量重算）。
 */
export const createCanvasLayoutModelActions = (
  set: CanvasStoreSet,
  get: CanvasStoreGet,
): Pick<NodeGraphActions, "recomputeLayoutModelFull" | "recomputeLayoutModelForNodes"> => {
  return {
    /**
     * 全量重算 Layout Model。
     *
     * 调用时机：loadNodeGraph 完成、hydrate 收敛后。
     * 必须在 hydrate 完全收敛后的最终 state.nodeGraph 上调用。
     */
    recomputeLayoutModelFull: () => {
      const state = get();
      const nodeGraph = state.nodeGraph;
      if (nodeGraph === null || nodeGraph === undefined) return;
      const mediaAssets = state.mediaAssets ?? {};
      const urlIndex = buildUrlIndex(mediaAssets);
      const output = computeLayoutModel({
        nodeGraph,
        mediaAssets,
        urlIndex,
        ...buildComputeInputExtras(),
      });
      set((s) => {
        applyLayoutModelOutput(s, output, "overwrite");
      });
    },

    /**
     * 按 nodeId 增量重算 Layout Model。
     *
     * 调用时机：
     * - 节点内容变化（slot 增减、form 字段、折叠态）
     * - 媒体 metadata 异步返回（受影响节点集合）
     * - 节点结构变化（含受影响 group 节点）
     *
     * fallback：受影响集合 > FULL_RECOMPUTE_FALLBACK_THRESHOLD 时退化为全量重算。
     */
    recomputeLayoutModelForNodes: (nodeIds: string[]) => {
      if (!Array.isArray(nodeIds) || nodeIds.length === 0) return;
      const state = get();
      const nodeGraph = state.nodeGraph;
      if (nodeGraph === null || nodeGraph === undefined) return;
      // fallback：受影响集合过大 → 全量重算
      if (nodeIds.length > FULL_RECOMPUTE_FALLBACK_THRESHOLD) {
        const mediaAssets = state.mediaAssets ?? {};
        const urlIndex = buildUrlIndex(mediaAssets);
        const output = computeLayoutModel({
          nodeGraph,
          mediaAssets,
          urlIndex,
          ...buildComputeInputExtras(),
        });
        set((s) => {
          applyLayoutModelOutput(s, output, "overwrite");
        });
        return;
      }
      // 增量重算：构造只含受影响节点的子图
      const targetSet = new Set(nodeIds);
      const affectedNodes = nodeGraph.nodes.filter((n) => targetSet.has(n.id));
      if (affectedNodes.length === 0) return;
      const subGraph: NodeGraph = {
        ...nodeGraph,
        nodes: affectedNodes,
        // edges / annotations 等在 Layout Model 中不影响尺寸计算
      };
      const mediaAssets = state.mediaAssets ?? {};
      const urlIndex = buildUrlIndex(mediaAssets);
      const output = computeLayoutModel({
        nodeGraph: subGraph,
        mediaAssets,
        urlIndex,
        ...buildComputeInputExtras(),
      });
      set((s) => {
        applyLayoutModelOutput(s, output, "merge");
      });
    },
  };
};

/**
 * 通过 mediaAssets URL 反查受影响节点集合。
 *
 * 用于：媒体 metadata 异步返回时，识别引用该 assetId 的节点。
 *
 * 纯函数辅助。
 */
export const findNodesReferencingAsset = (
  nodeGraph: NodeGraph,
  mediaAssets: ProjectMediaAssets,
  url: string,
): string[] => {
  if (typeof url !== "string" || url.length === 0) return [];
  const urlIndex = buildUrlIndex(mediaAssets);
  const assetId = lookupAssetIdByUrl(urlIndex, url);
  if (assetId === undefined) return [];
  const result: string[] = [];
  for (const node of nodeGraph.nodes) {
    if (node === null || node === undefined) continue;
    if (referencesAssetId(node, assetId)) {
      result.push(node.id);
    }
  }
  return result;
};

/**
 * 判断节点是否引用了 assetId。
 *
 * 检查 imageInput/videoInput 素材节点与 asset 资产节点的 assetId（模型节点已退出画布）。
 * asset 节点尺寸由媒体 meta 派生，媒体 metadata 异步返回时必须参与反查。
 */
const referencesAssetId = (node: GraphNode, assetId: string): boolean => {
  if (
    node.type === "imageInput" ||
    node.type === "videoInput" ||
    node.type === "asset"
  ) {
    const data = node.data as { assetId: string | null | undefined };
    return data.assetId === assetId;
  }
  return false;
};
