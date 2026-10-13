import type { NodeGraphState } from './canvasStore.core';

export interface CleanupSelectionParams {
  removedNodeIds: ReadonlyArray<string>;
  removedAnnotationIds: ReadonlyArray<string>;
}

/**
 * 统一选中状态清理守卫。在删除操作完成后调用，清理被删除元素的选中引用。
 * 必须在 Immer set() 回调内调用，直接修改 draft state。
 */
export function cleanupSelectionAfterRemoval(
  state: NodeGraphState,
  params: CleanupSelectionParams,
): void {
  const { removedNodeIds, removedAnnotationIds } = params;

  if (removedNodeIds.length > 0) {
    const nodeIdSet = new Set(removedNodeIds);
    state.selectedNodeIds = state.selectedNodeIds.filter(
      (id) => !nodeIdSet.has(id),
    );
  }

  if (removedAnnotationIds.length > 0) {
    const annotationIdSet = new Set(removedAnnotationIds);
    state.selectedAnnotationIds = state.selectedAnnotationIds.filter(
      (id) => !annotationIdSet.has(id),
    );

    if (
      state.editingAnnotationId !== null &&
      annotationIdSet.has(state.editingAnnotationId)
    ) {
      state.editingAnnotationId = null;
    }

    if (
      state.pendingAnnotationBinding !== null &&
      annotationIdSet.has(state.pendingAnnotationBinding.annotationId)
    ) {
      state.pendingAnnotationBinding = null;
    }
  }
}
