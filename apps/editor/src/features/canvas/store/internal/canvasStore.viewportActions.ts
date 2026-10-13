import { markViewportDirty } from './canvasStore.persistence';
import type { CanvasStoreGet, CanvasStoreSet, NodeGraphActions } from './canvasStore.core';

export const createCanvasViewportActions = (
  set: CanvasStoreSet,
  _get: CanvasStoreGet,
): Pick<NodeGraphActions, 'setViewport' | 'fitView' | 'setCanvasContainerSize'> => ({
  setViewport: (viewport) => {
    set((state) => {
      if (state.nodeGraph) {
        const current = state.nodeGraph.viewport;
        if (
          current &&
          current.x === viewport.x &&
          current.y === viewport.y &&
          current.zoom === viewport.zoom
        ) {
          return;
        }
        state.nodeGraph.viewport = viewport;
        state.viewportRevision += 1;
        markViewportDirty(state);
      }
    });
  },

  fitView: () => {
    // 由 React Flow 组件处理
  },

  setCanvasContainerSize: (size) => {
    set((state) => {
      const current = state.ui.canvasContainerSize;
      if (
        current === size ||
        (current !== null &&
          size !== null &&
          current.width === size.width &&
          current.height === size.height)
      ) {
        return;
      }
      state.ui.canvasContainerSize = size;
    });
  },
});
