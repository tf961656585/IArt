import { describe, expect, vi, beforeEach, afterEach, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { createNodeGraph } from '../types/nodeGraph';
import { useAutoSave } from './useAutoSave';
import { __setMockCanvasState } from '../store/canvasStore';

vi.useFakeTimers();

// mock 后端待收口节点改动上报，避免真实 backend 交互
const persistNodeChangesMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const enqueuePendingNodeChangesMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const flushPendingNodeChangesMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock('../storage', () => ({
  persistNodeChanges: async (...args: unknown[]) => persistNodeChangesMock(...args),
  enqueuePendingNodeChanges: async (...args: unknown[]) => enqueuePendingNodeChangesMock(...args),
  flushPendingNodeChanges: async (...args: unknown[]) => flushPendingNodeChangesMock(...args),
}));

// 轻量模拟 canvas store，只提供 useAutoSave 所需的字段
type MockStore = {
  nodeGraph: ReturnType<typeof createNodeGraph> | null;
  hasUnsavedChanges: boolean;
  dirtyRevision: number;
  dirty: {
    graph: boolean;
    viewport: boolean;
    fullReplace: boolean;
    mediaAssets: boolean;
    nodes: Record<string, true>;
    removedNodes: Record<string, true>;
  };
  structureRevision: number;
  positionRevision: number;
  viewportRevision: number;
};

type MockStoreSnapshot = MockStore & {
  syncPersistenceState: ReturnType<typeof vi.fn>;
  markAsSaved: (expectedDirtyRevision?: number) => void;
};

type UseCanvasStoreMock = {
  <T>(selector: (state: MockStoreSnapshot) => T): T;
  getState: () => MockStoreSnapshot;
};

vi.mock('../store/canvasStore', () => {
  const listeners = new Set<() => void>();
  const createDirtyState = () => ({
    graph: false,
    viewport: false,
    fullReplace: false,
    mediaAssets: false,
    nodes: {},
    removedNodes: {},
  });
  let store: MockStore = {
    nodeGraph: null,
    hasUnsavedChanges: false,
    dirtyRevision: 0,
    dirty: createDirtyState(),
    structureRevision: 0,
    positionRevision: 0,
    viewportRevision: 0,
  };
  let snapshot: MockStoreSnapshot = {
    ...store,
    syncPersistenceState: vi.fn(),
    markAsSaved: (expectedDirtyRevision?: number) => {
      if (typeof expectedDirtyRevision === 'number' && expectedDirtyRevision !== store.dirtyRevision) {
        return;
      }
      setStore({ hasUnsavedChanges: false, dirtyRevision: 0, dirty: createDirtyState() });
    },
  };

  function setStore(next: Partial<MockStore>) {
    store = { ...store, ...next };
    snapshot = {
      ...store,
      syncPersistenceState: vi.fn(),
      markAsSaved: (expectedDirtyRevision?: number) => {
        if (typeof expectedDirtyRevision === 'number' && expectedDirtyRevision !== store.dirtyRevision) {
          return;
        }
        setStore({ hasUnsavedChanges: false, dirtyRevision: 0, dirty: createDirtyState() });
      },
    };
    listeners.forEach((l) => l());
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const useCanvasStore: UseCanvasStoreMock = <T,>(selector: (state: MockStoreSnapshot) => T) => {
    return React.useSyncExternalStore(subscribe, () => selector(snapshot));
  };
  useCanvasStore.getState = () => snapshot;

  const buildProjectDelta = (state: MockStore) => {
    const expectedDirtyRevision = state.dirtyRevision;
    if (!state.nodeGraph) {
      return { delta: null, expectedDirtyRevision };
    }
    const hasDirty =
      state.dirty.graph ||
      state.dirty.viewport ||
      state.dirty.fullReplace ||
      state.dirty.mediaAssets ||
      Object.keys(state.dirty.nodes).length > 0 ||
      Object.keys(state.dirty.removedNodes).length > 0;
    if (!hasDirty) {
      return { delta: null, expectedDirtyRevision };
    }
    return { delta: { nodeGraphId: state.nodeGraph.id }, expectedDirtyRevision };
  };

  return { useCanvasStore, buildProjectDelta, __setMockCanvasState: setStore };
});

describe('useAutoSave', () => {
  beforeEach(() => {
    const graph = createNodeGraph({
      name: '测试画板',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    __setMockCanvasState({
      nodeGraph: graph,
      hasUnsavedChanges: true,
      dirtyRevision: 1,
      dirty: {
        graph: true,
        viewport: false,
        fullReplace: false,
        mediaAssets: false,
        nodes: {},
        removedNodes: {},
      },
    });
    persistNodeChangesMock.mockReset();
    persistNodeChangesMock.mockResolvedValue({ ok: true });
    enqueuePendingNodeChangesMock.mockReset();
    enqueuePendingNodeChangesMock.mockResolvedValue({ ok: true });
    flushPendingNodeChangesMock.mockReset();
    flushPendingNodeChangesMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('卸载时若已保存则不再重复上报节点改动', () => {
    const { unmount } = renderHook(() => useAutoSave());

    // 等待自动保存完成，期间 markAsSaved 会把标志置为 false 并触发重渲染
    act(() => {
      vi.advanceTimersByTime(2100);
    });

    // 卸载触发兜底保存
    unmount();

    expect(persistNodeChangesMock).toHaveBeenCalledTimes(1);
  });

  it('仅 runtime size 更新（无 dirty）时不触发保存', () => {
    const graph = createNodeGraph({
      name: '测试画板-runtime-only',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    __setMockCanvasState({
      nodeGraph: graph,
      hasUnsavedChanges: false,
      dirtyRevision: 0,
      dirty: {
        graph: false,
        viewport: false,
        fullReplace: false,
        mediaAssets: false,
        nodes: {},
        removedNodes: {},
      },
    });

    renderHook(() => useAutoSave());

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(persistNodeChangesMock).not.toHaveBeenCalled();
  });
});
