import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, beforeEach, vi, expect } from 'vitest';
import type { RefObject } from 'react';
import { CanvasToolbar } from './CanvasToolbar';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import { toast } from 'sonner';
import type {
  GraphNode,
  NodeGraphSettings,
  NodeSize,
  TextInputNodeData,
} from '../../types';

/** 测试用 mock ref，模拟 CanvasEditor 传入的 measured size holder */
const mockMeasuredSizeRef: RefObject<Readonly<Record<string, NodeSize>>> = { current: {} };
/** 测试用 mock ref，模拟 CanvasEditor 传入的组节点派生尺寸 holder */
const mockDerivedSizeRef: RefObject<Readonly<Record<string, NodeSize>>> = { current: {} };

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const resetStore = () => {
  useCanvasStore.setState({
    nodeGraph: null,
    selectedNodeIds: [],
    selectedAnnotationIds: [],
    editingAnnotationId: null,
    pendingAnnotationBinding: null,
    isDragging: false,
    isConnecting: false,
    history: [],
    historyIndex: -1,
    hasUnsavedChanges: false,
    structureRevision: 0,
    positionRevision: 0,
    viewportRevision: 0,
    layoutRevision: 0,
        clipboardPayload: null,
  });
};

const createTextInputNode = (
  id: string,
  label: string,
  position: { x: number; y: number },
): GraphNode<TextInputNodeData> => ({
  id,
  type: 'textInput',
  position,
  data: {
    label,
    description: undefined,
    runtimeRef: undefined,
    segments: [{ kind: 'local', id: `local-${id}`, enabled: true, text: label }],
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    separator: 'comma',
    customSeparator: '',
    promptPresetSnapshots: undefined,
    taskInfo: undefined,
    promptInterview: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

describe('CanvasToolbar 一键整理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('支持右侧扩展插槽', () => {
    render(<CanvasToolbar rightSlot={<div>右侧插槽</div>} measuredSizeByNodeIdRef={mockMeasuredSizeRef} derivedSizeByNodeIdRef={mockDerivedSizeRef} />);
    expect(screen.getByText('右侧插槽')).toBeInTheDocument();
  });

  it('空画板时整理按钮禁用', () => {
    render(<CanvasToolbar rightSlot={undefined} measuredSizeByNodeIdRef={mockMeasuredSizeRef} derivedSizeByNodeIdRef={mockDerivedSizeRef} />);
    const button = screen.getByText('整理').closest('button');
    expect(button).toBeDisabled();
  });

  it('点击整理触发布局并写入历史', async () => {
    const user = userEvent.setup();
    const graph = createNodeGraph({
      name: '测试画板',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    graph.nodes = [
      createTextInputNode('n1', '1', { x: 500, y: 500 }),
      createTextInputNode('n2', '2', { x: 600, y: 620 }),
    ];

    const initialHistory = [
      {
        kind: 'snapshot' as const,
        nodes: structuredClone(graph.nodes),
        annotations: [],
        settings: structuredClone(graph.settings) as NodeGraphSettings,
      },
    ];

    useCanvasStore.setState({
      nodeGraph: graph,
      history: initialHistory,
      historyIndex: 0,
      hasUnsavedChanges: false,
      selectedNodeIds: [],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
      structureRevision: 0,
      positionRevision: 0,
      viewportRevision: 0,
      layoutRevision: 0,
            clipboardPayload: null,
    });

    render(<CanvasToolbar rightSlot={undefined} measuredSizeByNodeIdRef={mockMeasuredSizeRef} derivedSizeByNodeIdRef={mockDerivedSizeRef} />);
    await user.click(screen.getByText('整理'));

    await waitFor(() => {
      expect(useCanvasStore.getState().layoutRevision).toBe(1);
    });

    const state = useCanvasStore.getState();
    expect(state.layoutRevision).toBe(1);
    expect(state.positionRevision).toBe(1);
    expect(state.historyIndex).toBe(1);
    expect(state.history).toHaveLength(2);
    expect(state.hasUnsavedChanges).toBe(true);

    if (state.nodeGraph === null) {
      throw new Error('nodeGraph should exist after auto layout');
    }
    const node1 = state.nodeGraph.nodes.find((n) => n.id === 'n1');
    const node2 = state.nodeGraph.nodes.find((n) => n.id === 'n2');
    expect(node1).toBeDefined();
    expect(node2).toBeDefined();
    if (node1 === undefined || node2 === undefined) {
      throw new Error('expected nodes to remain in graph after auto layout');
    }
    // 画布无连线后布局是纯几何遍历：节点按传入顺序单列垂直摆放（x 对齐，y 递增）。
    expect(node1.position.x).toBe(node2.position.x);
    expect(node2.position.y).toBeGreaterThan(node1.position.y);

    expect(vi.mocked(toast.success)).toHaveBeenCalled();
  });
});
