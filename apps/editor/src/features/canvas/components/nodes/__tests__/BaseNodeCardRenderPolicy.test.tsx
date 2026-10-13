import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BaseNodeCard, createSelectionContentPolicy } from '../BaseNodeCard';

type MockCanvasState = {
  selectedNodeIds: string[];
  updateNodeMeasured: ReturnType<typeof vi.fn>;
  ui: {
    placeholderNodeIds: Set<string>;
    desiredSizeByNodeId: Record<string, unknown>;
    lastMeasuredSizeByNodeId: Record<string, unknown>;
  };
  nodeGraph: { id: string; nodes: unknown[] } | null;
  structureRevision: number;
  dataRevision: number;
  layoutRevision: number;
};

let mockCanvasState = {} as MockCanvasState;

function getMockCanvasState(): MockCanvasState {
  if (!mockCanvasState) {
    throw new Error('mockCanvasState is not initialized');
  }
  return mockCanvasState;
}

vi.mock('@xyflow/react', () => ({
  Handle: ({ children }: { children?: React.ReactNode }) => <div data-testid="handle">{children}</div>,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useReactFlow: () => ({ setCenter: vi.fn() }),
  useUpdateNodeInternals: () => vi.fn(),
}));

vi.mock('../../../store/canvasStore', () => {
  const useCanvasStore = <T,>(selector: (state: MockCanvasState) => T): T => selector(getMockCanvasState());
  useCanvasStore.getState = getMockCanvasState;
  return { useCanvasStore };
});

describe('BaseNodeCard - content render policy', () => {
  beforeEach(() => {
    mockCanvasState = {
      selectedNodeIds: [],
      updateNodeMeasured: vi.fn(),
      ui: {
        placeholderNodeIds: new Set(),
        desiredSizeByNodeId: {},
        lastMeasuredSizeByNodeId: {},
      },
      nodeGraph: null,
      structureRevision: 0,
      dataRevision: 0,
      layoutRevision: 0,
    };
  });

  it('业务 active 只看 store 单选态，且仍要求 prop.selected 为 true 才渲染完整内容', () => {
    getMockCanvasState().selectedNodeIds = ['node-1'];

    render(
      <BaseNodeCard
        nodeId="node-1"
        title="测试节点"
        selected
        contentRenderPolicy={createSelectionContentPolicy(undefined)}
      >
        <div data-testid="content">Content</div>
      </BaseNodeCard>,
    );

    expect(screen.getByTestId('content')).toBeInTheDocument();
    expect(screen.queryByText('选中以编辑')).toBeNull();
  });

  it('视觉 selected 只看 prop，store 单选命中但 prop.selected=false 时仍回退到 identity', () => {
    getMockCanvasState().selectedNodeIds = ['node-1'];

    render(
      <BaseNodeCard
        nodeId="node-1"
        title="测试节点"
        selected={false}
        contentRenderPolicy={createSelectionContentPolicy(undefined)}
      >
        <div data-testid="content">Content</div>
      </BaseNodeCard>,
    );

    expect(screen.queryByTestId('content')).toBeNull();
    expect(screen.getByText('选中以编辑')).toBeInTheDocument();
  });

  it('store 多选时不再把节点视为 active，即使 prop.selected=true 也只显示 identity 提示', () => {
    getMockCanvasState().selectedNodeIds = ['node-1', 'node-2'];

    render(
      <BaseNodeCard
        nodeId="node-1"
        title="测试节点"
        selected
        contentRenderPolicy={createSelectionContentPolicy(undefined)}
      >
        <div data-testid="content">Content</div>
      </BaseNodeCard>,
    );

    expect(screen.queryByTestId('content')).toBeNull();
    expect(screen.getByText('已选中多个，单独选中后才能编辑')).toBeInTheDocument();
  });
});
