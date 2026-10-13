import type { ProjectMediaAssets } from "@iart/contracts";
import type { DynamicRecord } from "@/client/utils/typeGuards";
import { cast } from "@/lib/utils";
import type {
  GraphNodeData,
  NodeGraph,
  NodeGraphMeta,
} from "../../types";

import { isNodeGraphOnCurrentSchema, normalizeNodeGraphSettings } from "../../types/nodeGraph";
import { isAnnotationBinding } from "../../types/annotation";
import {
  normalizeTextInputNodeData,
} from "../../nodes/textInput/enhancedTextNode";
import {
  hydrateNodeGraphResultAreaItems,
} from "../../services/projectMediaAssets";
import { sanitizeNodesForStore } from "../../services/outputSanitizer";
import { sanitizeModelNodeForPersistence } from "../../services/modelMediaPersistence";
import { migrateNodeGraphAnnotations } from "../../services/annotationMigration";
import {
  normalizeNodeSizingOnLoad,
  stripNodeRuntimeLayoutFromNode,
} from "../../utils/nodeSize";
import { getResolvedExpandInlineParamsOnStartup } from "@/client/utils/hubCanvasStartupConfig";
import type {
  LoadRepairDiagnostics,
  DeferredHistoryBaseline,
} from "./canvasStore.shared";
import {
  applyModelInlineControlsCollapsedStartupPreference,
  normalizeNodeDataShape,
  normalizeNodeGraphEntities,
  normalizeNodeGraphMeta,
  normalizeNodePosition,
  normalizeViewport,
  sanitizeRuntimeLayoutData,
  stripLegacySelectionSteadyState,
} from "./loadGraphNormalization";
import { createLegacyModelNodeRejection } from "./legacyModelNodeRejection";
import { assertLegalMemberships } from "./membershipRejection";
type CanvasDynamicObject = DynamicRecord;
export const prepareLoadedNodeGraph = async (
  nodeGraph: NodeGraph,
  mediaAssets: ProjectMediaAssets,
): Promise<{
  nodeGraph: NodeGraph;
  deferredHistoryBaseline: DeferredHistoryBaseline;
  lastLoadDiagnostics: LoadRepairDiagnostics;
  pendingMediaMigrationNotice: string | null;
}> => {
  const migratedGraph = nodeGraph;
  const shouldRunLoadRepair = !isNodeGraphOnCurrentSchema(
    (migratedGraph as { meta: NodeGraphMeta | null | undefined }).meta,
  );
  const loadDiagnostics: LoadRepairDiagnostics = {
    path: shouldRunLoadRepair ? "repair" : "fast",
    stripLegacySelectionSteadyState: 0,
    normalizeNodeData: 0,
    normalizeEntities: 0,
    sanitizeNodeMedia: 0,
    migrateTextNodes: 0,
    remapAnnotations: 0,
    stripRuntimeLayout: 0,
  };
  const nodesForLoad = migratedGraph.nodes;
  for (const node of nodesForLoad) {
    if (node.type !== "model") continue;
    // 旧模型节点数据按 spec 打开时拒绝：不迁移、不恢复、不静默转换
    //（spec PromptDock生成主链.md / 产品定位与核心动作）。
    throw createLegacyModelNodeRejection(node.id, "load");
  }
  const normalizedMeta = normalizeNodeGraphMeta(
    (migratedGraph as { meta: NodeGraphMeta | null | undefined }).meta,
  );
  const expandInlineParamsOnStartup =
    await getResolvedExpandInlineParamsOnStartup(undefined);
  const modelInlineControlsCollapsedDefault = !expandInlineParamsOnStartup;
  if (!shouldRunLoadRepair) {
    const normalizedNodes = (migratedGraph.nodes ?? []).map((node) =>
      applyModelInlineControlsCollapsedStartupPreference(
        node,
        modelInlineControlsCollapsedDefault,
      ),
    );
    const selectionCleanup = stripLegacySelectionSteadyState(normalizedNodes);
    loadDiagnostics.stripLegacySelectionSteadyState = selectionCleanup.touchedNodeCount;
    // 成员关系读取校验（AG-CN-012 / AG-CN-013）：非法 groupId 引用使输入不能进入正式打开态。
    // 必须在校验对象为最终节点集（含 id 归一）之后执行。
    assertLegalMemberships(selectionCleanup.nodes, 'fast');
    const normalizedGraph: NodeGraph = {
      ...migratedGraph,
      nodes: selectionCleanup.nodes,
      annotations: migratedGraph.annotations ?? [],
      meta: normalizedMeta,
      settings: normalizeNodeGraphSettings(migratedGraph.settings),
      viewport: normalizeViewport(migratedGraph.viewport),
    };
    return {
      nodeGraph: hydrateNodeGraphResultAreaItems(normalizedGraph, mediaAssets),
      deferredHistoryBaseline: {
        nodeGraph: normalizedGraph,
      },
      lastLoadDiagnostics: loadDiagnostics,
      pendingMediaMigrationNotice: null,
    };
  }
  const migratedNodes = nodesForLoad.map((node) => {
    loadDiagnostics.normalizeNodeData += 1;
    const normalized = normalizeNodeSizingOnLoad(
      normalizeNodeDataShape(
        {
          ...node,
          data: sanitizeRuntimeLayoutData(node.data as GraphNodeData),
          position: normalizeNodePosition(node.position),
        },
        { modelInlineControlsCollapsedDefault },
      ),
    );
    if (normalized.type !== "model") return normalized;
    // 旧模型节点已在上方统一拒绝（legacy-model-node）；此处防御性兜底，正常不会到达。
    throw createLegacyModelNodeRejection(normalized.id, "repair");
  });
  const selectionCanonicalized = stripLegacySelectionSteadyState(migratedNodes);
  loadDiagnostics.stripLegacySelectionSteadyState = selectionCanonicalized.touchedNodeCount;
  loadDiagnostics.normalizeEntities += 1;
  const normalizedEntities = normalizeNodeGraphEntities(selectionCanonicalized.nodes);
  const sanitizedNodes = sanitizeNodesForStore(normalizedEntities.nodes);
  const mediaPersistenceIssues: Array<{
    nodeId: string;
    message: string;
    fieldKey: string;
  }> = [];
  const persistenceMigratedNodes = sanitizedNodes.map((node) => {
    const sanitized = sanitizeModelNodeForPersistence(node);
    if (sanitized.issues.length > 0) {
      for (const issue of sanitized.issues) {
        mediaPersistenceIssues.push({
          nodeId: node.id,
          fieldKey: issue.fieldKey,
          message: issue.message,
        });
      }
    }
    return sanitized.node;
  });
  loadDiagnostics.sanitizeNodeMedia = sanitizedNodes.length;
  const mediaMigrationNotice =
    mediaPersistenceIssues.length > 0
      ? "检测到历史会话媒体已失效，相关字段已清理，请重新上传后再执行。"
      : null;
  // 此处只做旧结构 segments 归一（legacy text → 本地段；上游段剥离由 sanitize 承载）。
  const migratedTextNodes = persistenceMigratedNodes.map((node) => {
    loadDiagnostics.migrateTextNodes += 1;
    if (node.type !== "textInput") return node;
    const normalizedData = normalizeTextInputNodeData(
      cast<CanvasDynamicObject>(node.data),
    );
    return {
      ...node,
      data: normalizedData,
    };
  });
  const remappedAnnotations = (migratedGraph.annotations ?? []).map(
    (annotation) => {
      loadDiagnostics.remapAnnotations += 1;
      const binding = annotation.binding;
      if (!isAnnotationBinding(binding)) return annotation;
      if (binding.type !== "node") return annotation;
      const nodeId =
        normalizedEntities.nodeIdMap.get(binding.nodeId) ?? binding.nodeId;
      return { ...annotation, binding: { ...binding, nodeId } };
    },
  );
  const { nodeGraph: annotationNormalizedGraph } = migrateNodeGraphAnnotations({
    ...migratedGraph,
    nodes: migratedTextNodes,
    annotations: remappedAnnotations,
  });
  const annotationNodes = annotationNormalizedGraph.nodes;
  loadDiagnostics.stripRuntimeLayout = annotationNodes.length;
  const normalizedNodes = annotationNodes.map((node) => {
    return stripNodeRuntimeLayoutFromNode(node);
  });
  // 成员关系读取校验（AG-CN-012 / AG-CN-013）：repair 路径的最终节点集同样拒绝非法引用。
  assertLegalMemberships(normalizedNodes, 'repair');
  const normalizedGraph: NodeGraph = {
    // spread 里的 nodes 会被 normalizedNodes 立即覆盖，spread 只承载 passthrough 字段。
    // 最终的 sanitize 在 return 时通过 hydrateNodeGraphResultAreaItems 统一执行一次。
    ...migratedGraph,
    nodes: normalizedNodes,
    annotations: annotationNormalizedGraph.annotations ?? [],
    viewport: normalizeViewport(migratedGraph.viewport),
    settings: normalizeNodeGraphSettings(migratedGraph.settings),
    meta: normalizedMeta,
  };
  return {
    nodeGraph: hydrateNodeGraphResultAreaItems(normalizedGraph, mediaAssets),
    deferredHistoryBaseline: {
      nodeGraph: normalizedGraph,
    },
    lastLoadDiagnostics: loadDiagnostics,
    pendingMediaMigrationNotice: mediaMigrationNotice,
  };
};
