import { createHistoryEntryFromGraph, createNodeRestorationCaches, restoreHistoryEntryState, saveToHistoryState, commitDeferredHistoryBaselineState } from './canvasStore.history';
import { resetDirtyState } from './canvasStore.persistence';
import { buildTaskIdIndex } from './canvasStore.shared';
import { type CanvasStoreGet, type CanvasStoreSet, type NodeGraphActions } from './canvasStore.core';

export const createCanvasHistoryPersistenceActions = (set: CanvasStoreSet, get: CanvasStoreGet): Pick<NodeGraphActions, 'saveToHistory' | 'commitDeferredHistoryBaseline' | 'undo' | 'redo' | 'canUndo' | 'canRedo' | 'markAsSaved' | 'syncPersistenceState' | 'setClosing'> => ({
    // 历史操作
    saveToHistory: () => {
      const { nodeGraph, deferredHistoryBaseline, history } = get();
      if (!nodeGraph) return;
      const entry = createHistoryEntryFromGraph(nodeGraph);
      const deferredBaselineEntry =
        history.length === 0 &&
        deferredHistoryBaseline &&
        deferredHistoryBaseline.nodeGraph.id === nodeGraph.id
          ? createHistoryEntryFromGraph(deferredHistoryBaseline.nodeGraph)
          : null;

      set((state) => {
        saveToHistoryState(state, entry, deferredBaselineEntry);
      });
    },

    commitDeferredHistoryBaseline: () => {
      const { deferredHistoryBaseline, history } = get();
      if (!deferredHistoryBaseline || history.length > 0) return;
      const entry = createHistoryEntryFromGraph(deferredHistoryBaseline.nodeGraph);

      set((state) => {
        if (!state.deferredHistoryBaseline || state.history.length > 0) return;
        commitDeferredHistoryBaselineState(state, entry);
      });
    },

    undo: () => {
      const { nodeGraph, history, historyIndex } = get();
      if (!nodeGraph || historyIndex <= 0) return;
      const entry = history[historyIndex - 1];
      if (!entry) return;
      const caches = createNodeRestorationCaches(nodeGraph.nodes);
      set((state) => {
        restoreHistoryEntryState(state, entry, historyIndex - 1, caches);
        if (state.nodeGraph) {
          state.taskIdIndex = buildTaskIdIndex(state.nodeGraph.nodes);
        }
      });
      // history 恢复口径（spec：画布节点尺寸管理架构.md）：layoutModel 与几何切片
      // 无独立历史快照，恢复 nodeGraph 后必须全量重算重建，禁止滞留撤销前的几何。
      get().recomputeLayoutModelFull();
    },

    redo: () => {
      const { nodeGraph, history, historyIndex } = get();
      if (!nodeGraph || historyIndex >= history.length - 1) return;
      const entry = history[historyIndex + 1];
      if (!entry) return;
      const caches = createNodeRestorationCaches(nodeGraph.nodes);
      set((state) => {
        restoreHistoryEntryState(state, entry, historyIndex + 1, caches);
        if (state.nodeGraph) {
          state.taskIdIndex = buildTaskIdIndex(state.nodeGraph.nodes);
        }
      });
      // 同 undo：恢复 nodeGraph 后触发 Layout Model 全量重算。
      get().recomputeLayoutModelFull();
    },

    canUndo: () => {
      const { historyIndex } = get();
      return historyIndex > 0;
    },

    canRedo: () => {
      const { history, historyIndex } = get();
      return historyIndex < history.length - 1;
    },

    markAsSaved: (expectedDirtyRevision) => {
      set((state) => {
        if (typeof expectedDirtyRevision === 'number' && state.dirtyRevision !== expectedDirtyRevision) {
          return;
        }
        state.hasUnsavedChanges = false;
        resetDirtyState(state);
      });
    },

    syncPersistenceState: (pState) => {
      set((state) => {
        state.persistenceState = pState ?? null;
      });
    },

    setClosing: (value) => {
      set((state) => {
        state.isClosing = value;
      });
    },
});
