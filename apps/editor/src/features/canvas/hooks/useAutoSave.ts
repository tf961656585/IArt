'use client';

import { useCallback, useEffect, useRef } from 'react';
import { enqueuePendingNodeChanges, flushPendingNodeChanges, persistNodeChanges } from '../storage';
import { buildProjectDelta, useCanvasStore } from '../store/canvasStore';

const POSITION_SAVE_DELAY = 500;
const VIEWPORT_SAVE_DELAY = 600;

export function useAutoSave() {
  const nodeGraph = useCanvasStore((state) => state.nodeGraph);
  const hasUnsavedChanges = useCanvasStore((state) => state.hasUnsavedChanges);
  const markAsSaved = useCanvasStore((state) => state.markAsSaved);
  const syncPersistenceState = useCanvasStore((state) => state.syncPersistenceState);
  const structureRevision = useCanvasStore((state) => state.structureRevision);
  const positionRevision = useCanvasStore((state) => state.positionRevision);
  const viewportRevision = useCanvasStore((state) => state.viewportRevision);

  const positionTimerRef = useRef<number | undefined>(undefined);
  const viewportTimerRef = useRef<number | undefined>(undefined);
  const lastViewportSnapshotRef = useRef<string | null>(null);
  const savingRef = useRef(false);

  const clearTimer = useCallback((ref: React.RefObject<number | undefined>) => {
    if (ref.current) {
      window.clearTimeout(ref.current);
      ref.current = undefined;
    }
  }, []);

  const persistStructureChanges = useCallback(async () => {
    if (useCanvasStore.getState().isClosing) {
      return;
    }

    if (savingRef.current) {
      window.setTimeout(() => {
        void persistStructureChanges();
      }, 180);
      return;
    }

    const snapshot = useCanvasStore.getState();
    const { delta, expectedDirtyRevision } = buildProjectDelta(snapshot, undefined);
    if (!delta) return;

    savingRef.current = true;
    try {
      const result = await persistNodeChanges(delta);
      syncPersistenceState(
        result !== null && result !== undefined ? result.persistenceState ?? null : null
      );
      markAsSaved(expectedDirtyRevision);
    } catch {
      // 结构变更自动保存失败
    } finally {
      savingRef.current = false;
    }
  }, [markAsSaved, syncPersistenceState]);

  const scheduleDebouncedSave = useCallback(
    (timerRef: React.RefObject<number | undefined>, delay: number) => {
      clearTimer(timerRef);
      timerRef.current = window.setTimeout(async () => {
        if (useCanvasStore.getState().isClosing) {
          return;
        }

        if (savingRef.current) {
          window.setTimeout(() => scheduleDebouncedSave(timerRef, delay), 180);
          return;
        }

        const snapshot = useCanvasStore.getState();
        const { delta, expectedDirtyRevision } = buildProjectDelta(snapshot, undefined);
        if (!delta) return;

        savingRef.current = true;
        try {
          const enqueueResult = await enqueuePendingNodeChanges(delta);
          syncPersistenceState(
            enqueueResult !== null && enqueueResult !== undefined
              ? enqueueResult.persistenceState ?? null
              : null
          );
          const flushResult = await flushPendingNodeChanges();
          if (flushResult && 'persistenceState' in flushResult) {
            syncPersistenceState(flushResult.persistenceState ?? null);
          }
          markAsSaved(expectedDirtyRevision);
        } catch {
          // 布局变更防抖保存失败
        } finally {
          savingRef.current = false;
        }
      }, delay);
    },
    [clearTimer, markAsSaved, syncPersistenceState],
  );

  // 结构变更：立即持久化
  useEffect(() => {
    if (!nodeGraph || !hasUnsavedChanges) return;
    void persistStructureChanges();
  }, [nodeGraph, structureRevision, hasUnsavedChanges, persistStructureChanges]);

  // 节点位置变更：防抖持久化
  useEffect(() => {
    if (!nodeGraph || !hasUnsavedChanges) return undefined;
    scheduleDebouncedSave(positionTimerRef, POSITION_SAVE_DELAY);
    return () => clearTimer(positionTimerRef);
  }, [nodeGraph, positionRevision, hasUnsavedChanges, scheduleDebouncedSave, clearTimer]);

  // 视口变更：防抖持久化
  useEffect(() => {
    if (!nodeGraph) return undefined;
    if (hasUnsavedChanges) return undefined;

    const viewportSnapshot = JSON.stringify(nodeGraph.viewport ?? null);
    if (viewportSnapshot === lastViewportSnapshotRef.current) return undefined;
    lastViewportSnapshotRef.current = viewportSnapshot;

    scheduleDebouncedSave(viewportTimerRef, VIEWPORT_SAVE_DELAY);
    return () => clearTimer(viewportTimerRef);
  }, [nodeGraph, viewportRevision, hasUnsavedChanges, scheduleDebouncedSave, clearTimer]);

  // 卸载兜底
  useEffect(() => {
    return () => {
      if (savingRef.current) return;
      if (useCanvasStore.getState().isClosing) return;
      const snapshot = useCanvasStore.getState();
      const { delta, expectedDirtyRevision } = buildProjectDelta(snapshot, undefined);
      if (!delta) return;
      persistNodeChanges(delta)
        .then((result) => {
          useCanvasStore.getState().syncPersistenceState(
            result !== null && result !== undefined ? result.persistenceState ?? null : null
          );
          useCanvasStore.getState().markAsSaved(expectedDirtyRevision);
        })
        .catch(() => {});
    };
  }, []);
}

export async function flushAllPending(): Promise<void> {
  const state = useCanvasStore.getState();
  const { delta, expectedDirtyRevision } = buildProjectDelta(state, undefined);

  if (delta) {
    const result = await persistNodeChanges(delta);
    useCanvasStore.getState().syncPersistenceState(
      result !== null && result !== undefined ? result.persistenceState ?? null : null
    );
    useCanvasStore.getState().markAsSaved(expectedDirtyRevision);
  } else {
    const flushResult = await flushPendingNodeChanges();
    if (flushResult && 'persistenceState' in flushResult) {
      useCanvasStore.getState().syncPersistenceState(flushResult.persistenceState ?? null);
    }
  }
}

export default useAutoSave;
