import { normalizeSelectionContractFields } from '../../utils/selectionNormalize';
import { isSelectionContractEqual, type CanvasStoreGet, type CanvasStoreSet, type NodeGraphActions, type SelectionContractSnapshot } from './canvasStore.core';

function normalizeSelectionContractSnapshot(snapshot: SelectionContractSnapshot): SelectionContractSnapshot {
  const normalized = normalizeSelectionContractFields({
    nodeIds: snapshot.selectedNodeIds,
    annotationIds: snapshot.selectedAnnotationIds,
  });
  return {
    selectedNodeIds: normalized.nodeIds,
    selectedAnnotationIds: normalized.annotationIds,
    editingAnnotationId: snapshot.editingAnnotationId,
    pendingAnnotationBinding: snapshot.pendingAnnotationBinding,
  };
}

const applySelectionContract = (
  state: ReturnType<CanvasStoreGet>,
  selection: SelectionContractSnapshot,
) => {
  const nextSelection = normalizeSelectionContractSnapshot(selection);
  if (isSelectionContractEqual(state, nextSelection)) return;
  state.selectedNodeIds = nextSelection.selectedNodeIds;
  state.selectedAnnotationIds = nextSelection.selectedAnnotationIds;
  state.editingAnnotationId = nextSelection.editingAnnotationId;
  state.pendingAnnotationBinding = nextSelection.pendingAnnotationBinding;
};

export const createCanvasSelectionViewActions = (set: CanvasStoreSet, _get: CanvasStoreGet): Pick<NodeGraphActions, 'setEditingAnnotation' | 'projectSelectionContract'> => ({
    setEditingAnnotation: (annotationId) => {
      set((state) => {
        state.editingAnnotationId = annotationId;
        if (!annotationId) return;
        state.selectedAnnotationIds = [annotationId];
        state.selectedNodeIds = [];
        state.pendingAnnotationBinding = null;
      });
    },

    projectSelectionContract: (selection) => {
      set((state) => {
        applySelectionContract(state, selection);
      });
    },


});
