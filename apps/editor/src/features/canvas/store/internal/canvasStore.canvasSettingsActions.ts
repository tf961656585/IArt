import { normalizeNodeGraphSettings } from '../../types/nodeGraph';
import { markGraphDirty } from './canvasStore.persistence';
import type { CanvasStoreGet, CanvasStoreSet, NodeGraphActions } from './canvasStore.core';

export const createCanvasCanvasSettingsActions = (
  set: CanvasStoreSet,
  get: CanvasStoreGet,
): Pick<NodeGraphActions, 'setNodeGraphSettings' | 'toggleSnapToGrid' | 'setSnapGrid'> => ({
  setNodeGraphSettings: (settings) => {
    set((state) => {
      if (!state.nodeGraph) return;
      const currentSettings = normalizeNodeGraphSettings(state.nodeGraph.settings);
      state.nodeGraph.settings = normalizeNodeGraphSettings({
        autoSave: settings.autoSave ?? currentSettings.autoSave,
        executionTimeout: settings.executionTimeout ?? currentSettings.executionTimeout,
        maxConcurrentNodes: settings.maxConcurrentNodes ?? currentSettings.maxConcurrentNodes,
        continueOnFailure: settings.continueOnFailure ?? currentSettings.continueOnFailure,
        enableLogging: settings.enableLogging ?? currentSettings.enableLogging,
        snapToGrid: settings.snapToGrid ?? currentSettings.snapToGrid,
        snapGrid: settings.snapGrid ?? currentSettings.snapGrid,
      });
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      markGraphDirty(state);
      state.structureRevision += 1;
    });
    get().saveToHistory();
  },

  toggleSnapToGrid: (enabled) => {
    const nodeGraph = get().nodeGraph;
    const current = normalizeNodeGraphSettings(nodeGraph ? nodeGraph.settings : undefined).snapToGrid;
    const next = typeof enabled === 'boolean' ? enabled : !current;
    get().setNodeGraphSettings({ snapToGrid: next });
  },

  setSnapGrid: (grid) => {
    get().setNodeGraphSettings({ snapGrid: grid });
  },
});
