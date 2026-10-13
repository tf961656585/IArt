import { createNodeGraph } from '../../types/nodeGraph';
import { getResolvedExpandInlineParamsOnStartup } from '@/client/utils/hubCanvasStartupConfig';
import { hydrateNodeGraphResultAreaItems, normalizeProjectMediaAssets } from '../../services/projectMediaAssets';
import { mergeMediaAssets, type MediaAssetWriteSource } from '../../services/projectMediaAssetMerge';
import { prepareLoadedNodeGraph } from './canvasStore.loadNodeGraph';
import { buildTaskIdIndex } from './canvasStore.shared';
import { markFullGraphDirty, markGraphDirty, resetDirtyState } from './canvasStore.persistence';
import { ensureNodeGraphMeta, normalizeNodeGraphMeta, type CanvasStoreGet, type CanvasStoreSet, type NodeGraphActions } from './canvasStore.core';
import { findNodesReferencingAsset } from './canvasStore.layoutModelActions';

export const createCanvasLoadActions = (set: CanvasStoreSet, get: CanvasStoreGet): Pick<NodeGraphActions, 'createNewNodeGraph' | 'loadNodeGraph' | 'setProjectMediaAssets' | 'updateNodeGraphMeta' | 'setSelectedCharacters' | 'clearNodeGraph' | 'clearPendingMediaMigrationNotice'> => ({
    createNewNodeGraph: (params) => {
      // 画板模式：创建空白画板，不预设任何节点
      void getResolvedExpandInlineParamsOnStartup({ force: undefined, timeoutMs: undefined, nonBlocking: true });
      const nodeGraph = createNodeGraph(params);
      nodeGraph.meta = normalizeNodeGraphMeta(nodeGraph.meta);
      set((state) => {
        state.nodeGraph = nodeGraph;
        state.mediaAssets = {};
        state.ui.desiredSizeByNodeId = {};
        state.ui.layoutModelByNodeId = {};
        state.taskIdIndex = new Map();
                state.selectedNodeIds = [];
        state.selectedAnnotationIds = [];
        state.editingAnnotationId = null;
        state.pendingAnnotationBinding = null;
        state.pendingMediaMigrationNotice = null;
        state.history = [];
        state.historyIndex = -1;
        state.deferredHistoryBaseline = null;
        state.lastLoadDiagnostics = null;
        state.hasUnsavedChanges = false;
        state.persistenceState = null;
        state.isClosing = false;
        resetDirtyState(state);
        state.structureRevision += 1;
        state.taskRevision += 1;
        state.positionRevision += 1;
        state.viewportRevision += 1;
        state.layoutRevision = 0;
      });
      get().saveToHistory();
    },

    loadNodeGraph: async (nodeGraph) => {
      const prepared = await prepareLoadedNodeGraph(nodeGraph, get().mediaAssets);
      set((state) => {
        state.nodeGraph = prepared.nodeGraph;
        state.ui.desiredSizeByNodeId = {};
        // Layout Model 在 hydrate 收敛后全量重算（spec：画布启动性能与Layout-Model架构.md
        // 「重新计算的触发条件」节「加载完成」）。先清空旧值，recomputeLayoutModelFull 在
        // set 回调外触发，确保读取最终 state.nodeGraph。
        state.ui.layoutModelByNodeId = {};
        state.taskIdIndex = buildTaskIdIndex(prepared.nodeGraph.nodes);
                state.selectedNodeIds = [];
        state.selectedAnnotationIds = [];
        state.editingAnnotationId = null;
        state.pendingAnnotationBinding = null;
        state.pendingMediaMigrationNotice = prepared.pendingMediaMigrationNotice;
        state.history = [];
        state.historyIndex = -1;
        state.deferredHistoryBaseline = prepared.deferredHistoryBaseline;
        state.lastLoadDiagnostics = prepared.lastLoadDiagnostics;
        state.hasUnsavedChanges = false;
        state.persistenceState = null;
        state.isClosing = false;
        resetDirtyState(state);
        state.structureRevision += 1;
        state.taskRevision += 1;
        state.positionRevision += 1;
        state.viewportRevision += 1;
        state.layoutRevision = 0;
        if (prepared.lastLoadDiagnostics.path === 'repair' || prepared.lastLoadDiagnostics.stripLegacySelectionSteadyState > 0) {
          markFullGraphDirty(state);
        }
      });
      // 加载完成、hydrate 收敛后全量计算 Layout Model（spec：唯一业务事实源）。
      // 必须在 set 回调外调用，读取最终收敛后的 state.nodeGraph。
      get().recomputeLayoutModelFull();
      // 启动期占位壳契约（spec：画布启动性能与Layout-Model架构.md「ReactFlow 双挂载的消除」）。
      // loadNodeGraph 完成后把全部新加载节点预置为占位壳态：NodeCanvas 在 waiting-interactive
      // 阶段以轻量子树挂载（媒体/重计算子树不挂），避免首帧完整子树挂载压满主线程、rAF 调度不到
      // 导致 readiness 卡死。readiness 通过后由 useNodeCanvasViewportController 监听 preparationPhase
      // 切到 'ready' 触发分帧升级（复用现有 placeholderUpgradeScheduler）。
      // 先清空占位集合，避免上次会话残留 / 项目切换时旧节点 id 混入新图。
      const afterGraph = get().nodeGraph;
      if (afterGraph !== null && afterGraph !== undefined) {
        get().clearPlaceholderUpgrade();
        const allNodeIds: string[] = [];
        const nodes = afterGraph.nodes;
        for (let i = 0; i < nodes.length; i += 1) {
          const node = nodes[i];
          if (node !== undefined) {
            const id = node.id;
            if (id !== undefined && id !== '') {
              allNodeIds.push(id);
            }
          }
        }
        if (allNodeIds.length > 0) {
          get().markNodesAsPlaceholder(allNodeIds);
        }
      }
    },

    setProjectMediaAssets: (patch, options) => {
      const source: MediaAssetWriteSource =
        options !== null && options !== undefined && options.source !== undefined
          ? options.source
          : 'user-action';
      set((state) => {
        if (source === 'project-load') {
          // 全量替换豁免：项目加载时磁盘数据是唯一事实源。
          // 仍走 normalizeProjectMediaAssets 做防御性字段校验（全量数据需校验）。
          state.mediaAssets = normalizeProjectMediaAssets(patch);
          // project-load 时 state.nodeGraph 还是旧值 / null：本次 hydrate 要么是 no-op，
          // 要么会被紧随其后的 loadNodeGraph → prepareLoadedNodeGraph 重新 hydrate 覆盖，
          // 故显式跳过（spec：layout-model-driven hydrate 收敛）。
        } else {
          // 增量写入走字段级 merge，按 source 裁决并发冲突。
          state.mediaAssets = mergeMediaAssets(state.mediaAssets, patch, source);
          // 非 project-load 来源（user-action / upstream / metadata-ready）需要立刻把
          // 已有的 state.nodeGraph 重新 hydrate，否则引用新媒体的 slot 不会立即显示。
          if (state.nodeGraph) {
            state.nodeGraph = hydrateNodeGraphResultAreaItems(state.nodeGraph, state.mediaAssets);
          }
        }
      });
      // Layout Model 增量重算：媒体 metadata 异步返回触发（spec：「媒体 metadata 异步返回」）。
      // project-load 由 loadNodeGraph 的 recomputeLayoutModelFull 覆盖，无需在此重复触发。
      // 其他来源（user-action / upstream）可能影响任何引用该媒体的节点，
      // 通过 findNodesReferencingAsset 反查受影响节点集合，超阈值时退化为全量重算。
      if (source !== 'project-load') {
        const state = get();
        if (state.nodeGraph !== null && state.nodeGraph !== undefined) {
          const affectedNodeIds: string[] = [];
          for (const assetId of Object.keys(patch)) {
            const asset = patch[assetId];
            if (asset === null || asset === undefined) continue;
            const url = asset.original !== null && asset.original !== undefined
              ? asset.original.url
              : null;
            if (url === null || url.length === 0) continue;
            const nodes = findNodesReferencingAsset(state.nodeGraph, state.mediaAssets, url);
            for (const nid of nodes) {
              if (!affectedNodeIds.includes(nid)) {
                affectedNodeIds.push(nid);
              }
            }
          }
          if (affectedNodeIds.length > 0) {
            get().recomputeLayoutModelForNodes(affectedNodeIds);
          }
        }
      }
    },

    updateNodeGraphMeta: (updates) => {
      set((state) => {
        if (state.nodeGraph) {
          ensureNodeGraphMeta(state.nodeGraph);
          if (updates.name !== undefined) state.nodeGraph.name = updates.name;
          if (updates.description !== undefined) state.nodeGraph.description = updates.description;
          if (updates.status !== undefined) state.nodeGraph.status = updates.status;
          state.nodeGraph.meta.updatedAt = new Date().toISOString();
          markGraphDirty(state);
          state.structureRevision += 1;
        }
      });
    },

    setSelectedCharacters: (characterIds) => {
      set((state) => {
        if (state.nodeGraph) {
          ensureNodeGraphMeta(state.nodeGraph);
          state.nodeGraph.meta.selectedCharacterIds = characterIds;
          state.nodeGraph.meta.updatedAt = new Date().toISOString();
          markGraphDirty(state);
          state.structureRevision += 1;
        }
      });
    },

    clearNodeGraph: () => {
      set((state) => {
        state.nodeGraph = null;
        state.mediaAssets = {};
        state.ui.desiredSizeByNodeId = {};
        state.ui.layoutModelByNodeId = {};
        state.taskIdIndex = new Map();
        state.selectedNodeIds = [];
        state.selectedAnnotationIds = [];
        state.editingAnnotationId = null;
        state.pendingAnnotationBinding = null;
        state.pendingMediaMigrationNotice = null;
        state.history = [];
        state.historyIndex = -1;
        state.deferredHistoryBaseline = null;
        state.lastLoadDiagnostics = null;
        state.hasUnsavedChanges = false;
        state.persistenceState = null;
        state.isClosing = false;
        resetDirtyState(state);
        state.structureRevision += 1;
        state.taskRevision += 1;
        state.positionRevision += 1;
        state.viewportRevision += 1;
        state.layoutRevision = 0;
      });
    },

    clearPendingMediaMigrationNotice: () => {
      set((state) => {
        state.pendingMediaMigrationNotice = null;
      });
    },
});
