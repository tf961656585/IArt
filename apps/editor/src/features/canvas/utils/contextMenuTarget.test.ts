import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveNodeContextMenuBehavior, resolvePaneOrSelectionContextMenuTarget } from './contextMenuTarget';

type MockCanvasStoreState = {
  nodeGraph: {
    nodes: Array<{
      id: string;
      type: string;
      data: Record<string, unknown>;
    }>;
  } | null;
};

type MockExecutionStoreState = {
  getTransientNodeOutputs: ReturnType<typeof vi.fn>;
};

let mockCanvasStoreState: MockCanvasStoreState;
let mockExecutionStoreState: MockExecutionStoreState;

vi.mock('../../store/canvasStore', () => ({
  useCanvasStore: {
    getState: () => mockCanvasStoreState,
  },
}));

vi.mock('../../store/executionStore', () => ({
  useExecutionStore: {
    getState: () => mockExecutionStoreState,
  },
}));

vi.mock('@/client/utils/outputNormalize', () => ({
  extractMediaUrls: vi.fn(() => ({ images: [] })),
}));

describe('contextMenuTarget', () => {
  beforeEach(() => {
    mockCanvasStoreState = { nodeGraph: null };
    mockExecutionStoreState = {
      getTransientNodeOutputs: vi.fn(),
    };
  });

  it('returns selection when more than one node is selected', () => {
    const target = resolvePaneOrSelectionContextMenuTarget({
      position: { x: 10, y: 20 },
      selectedNodeIds: ['n1', 'n2'],
    });

    expect(target).toEqual({
      type: 'selection',
      nodeIds: ['n1', 'n2'],
      position: { x: 10, y: 20 },
    });
  });

  it('returns pane when 0 or 1 node is selected', () => {
    expect(
      resolvePaneOrSelectionContextMenuTarget({
        position: { x: 10, y: 20 },
        selectedNodeIds: [],
      })
    ).toEqual({ type: 'pane', position: { x: 10, y: 20 } });

    expect(
      resolvePaneOrSelectionContextMenuTarget({
        position: { x: 10, y: 20 },
        selectedNodeIds: ['n1'],
      })
    ).toEqual({ type: 'pane', position: { x: 10, y: 20 } });
  });

  it('选中 ≤1 且命中容器空白：返回 containerGap 目标（携带容器 id 与种类）', () => {
    expect(
      resolvePaneOrSelectionContextMenuTarget({
        position: { x: 10, y: 20 },
        selectedNodeIds: [],
        containerHit: { containerNodeId: 'group-1', containerKind: 'group' },
      })
    ).toEqual({
      type: 'containerGap',
      containerNodeId: 'group-1',
      containerKind: 'group',
      position: { x: 10, y: 20 },
    });

    expect(
      resolvePaneOrSelectionContextMenuTarget({
        position: { x: 10, y: 20 },
        selectedNodeIds: ['n1'],
        containerHit: {
          containerNodeId: 'agent-1',
          containerKind: 'agentContainer',
        },
      })
    ).toEqual({
      type: 'containerGap',
      containerNodeId: 'agent-1',
      containerKind: 'agentContainer',
      position: { x: 10, y: 20 },
    });
  });

  // @spec: CM-022
  it('已选中 >1 个节点时多选优先：即便命中容器空白仍返回 selection', () => {
    const target = resolvePaneOrSelectionContextMenuTarget({
      position: { x: 10, y: 20 },
      selectedNodeIds: ['n1', 'n2'],
      containerHit: { containerNodeId: 'group-1', containerKind: 'group' },
    });

    expect(target).toEqual({
      type: 'selection',
      nodeIds: ['n1', 'n2'],
      position: { x: 10, y: 20 },
    });
  });

  it('选中 ≤1 且未命中容器（containerHit 为 null/缺省）：回落 pane', () => {
    expect(
      resolvePaneOrSelectionContextMenuTarget({
        position: { x: 10, y: 20 },
        selectedNodeIds: [],
        containerHit: null,
      })
    ).toEqual({ type: 'pane', position: { x: 10, y: 20 } });
  });
});

describe('resolveNodeContextMenuBehavior', () => {
  // @spec: CM-003
  it('uses default node behavior for multi-select', () => {
    const position = { x: 10, y: 20 };

    const behavior = resolveNodeContextMenuBehavior({
      nodeId: 'n1',
      position,
      selectedNodeIds: ['n1', 'n2'],
    });

    expect(behavior.selectionUpdate).toEqual({ kind: 'select-multi', nodeIds: ['n1', 'n2'] });
    expect(behavior.target).toEqual({ type: 'selection', nodeIds: ['n1', 'n2'], position });
  });

  // @spec: CM-002
  it('uses default node behavior for single node', () => {
    const position = { x: 10, y: 20 };

    const behavior = resolveNodeContextMenuBehavior({
      nodeId: 'n1',
      position,
      selectedNodeIds: ['n2'],
    });

    expect(behavior.selectionUpdate).toEqual({ kind: 'select-single', nodeId: 'n1' });
    expect(behavior.target).toEqual({ type: 'node', nodeId: 'n1', position });
  });

});
