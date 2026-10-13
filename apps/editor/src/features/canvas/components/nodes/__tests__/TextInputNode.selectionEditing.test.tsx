import React from 'react';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GraphNode, NodeGraph, TextInputNodeData } from '@/features/canvas/types';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';

import { TextInputNode } from '../TextInputNode';

type MockCanvasState = {
  nodeGraph: NodeGraph;
  selectedNodeIds: string[];
  updateNodeData: ReturnType<typeof vi.fn>;
};

type MockExecutionState = {
  getNodeDiagnosticInfo: () => null;
};

type MockNodeFromStoreResult = {
  node: GraphNode<TextInputNodeData>;
  data: TextInputNodeData;
};

let mockCanvasState: MockCanvasState;
let mockExecutionState: MockExecutionState;
let mockNodeFromStoreResult: MockNodeFromStoreResult;
const originalPointerEvent = globalThis.PointerEvent;

vi.mock('@xyflow/react', () => ({
  useUpdateNodeInternals: () => () => undefined,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children?: React.ReactNode;
  }) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/textarea', () => ({
  Textarea: (
    props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  ) => <textarea {...props} />,
}));

vi.mock('../ContentNodeCard', () => ({
  ContentNodeCard: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="content-node-card">{children}</div>
  ),
}));

vi.mock('../shared/TaskStatusBadge', () => ({
  TaskStatusBadge: () => null,
}));

vi.mock('../shared/PromptPresetSlashPopover', () => ({
  PromptPresetSlashPopover: () => null,
}));

vi.mock('../shared/PromptPresetTokenEditor', async () => {
  const ReactModule = await vi.importActual<typeof React>('react');

  return {
    PromptPresetTokenEditor: ReactModule.forwardRef(function MockEditor(
      {
        value,
        readOnly,
        editingSessionActive,
      }: {
        value: string;
        readOnly: boolean | undefined;
        editingSessionActive: boolean | undefined;
      },
      ref: React.ForwardedRef<{
        focus: () => void;
        getElement: () => HTMLDivElement | null;
        getValue: () => string;
        tryGetSelectionRange: () => null;
        getSelectionRange: () => { start: number; end: number };
        setSelectionRange: () => void;
        getCaretViewportRect: () => {
          left: number;
          top: number;
          bottom: number;
          height: number;
        };
        setSuggestionOpen: () => void;
        suppressNextInput: () => void;
      }>,
    ) {
      const surfaceRef = ReactModule.useRef<HTMLDivElement | null>(null);
      const isTextEditable =
        editingSessionActive === true && readOnly !== true;

      ReactModule.useImperativeHandle(
        ref,
        () => ({
          focus: () => {
            if (surfaceRef.current !== null && surfaceRef.current !== undefined) {
              surfaceRef.current.focus();
            }
          },
          getElement: () => surfaceRef.current,
          getValue: () => value,
          tryGetSelectionRange: () => null,
          getSelectionRange: () => ({ start: 0, end: 0 }),
          setSelectionRange: () => undefined,
          getCaretViewportRect: () => ({
            left: 0,
            top: 0,
            bottom: 0,
            height: 0,
          }),
          setSuggestionOpen: () => undefined,
          suppressNextInput: () => undefined,
        }),
        [value],
      );

      return (
        <div
          ref={surfaceRef}
          data-testid="prompt-editor"
          data-editing-session-active={
            editingSessionActive === true ? 'true' : 'false'
          }
          data-canvas-selection-edit-session={
            isTextEditable ? 'true' : undefined
          }
          role={isTextEditable ? 'textbox' : undefined}
          tabIndex={isTextEditable ? 0 : -1}
          contentEditable={isTextEditable}
        />
      );
    }),
  };
});

vi.mock('../TextInputNodeToolbar', () => ({
  TextInputNodeToolbar: () => null,
}));

vi.mock('../../dialogs/TextInputAiEditDialog', () => ({
  TextInputAiEditDialog: () => null,
}));

vi.mock('../../dialogs/TextInputExpandEditDialog', () => ({
  TextInputExpandEditDialog: () => null,
}));

vi.mock('../../../store/canvasStore', () => {
  const useCanvasStore = <T,>(
    selector: (state: MockCanvasState) => T,
  ): T => selector(mockCanvasState);
  useCanvasStore.getState = (): MockCanvasState => mockCanvasState;
  return { useCanvasStore };
});

vi.mock('../../../store/executionStore', () => ({
  useExecutionStore: <T,>(
    selector: (state: MockExecutionState) => T,
  ): T => selector(mockExecutionState),
}));

vi.mock('../../../hooks/useNodeFromStore', () => ({
  resolveFallbackGraphNodeFromNodePropsData: ({
    nodeId,
    type,
    nodePropsData,
  }: {
    nodeId: string;
    type: GraphNode<TextInputNodeData>['type'];
    nodePropsData: TextInputNodeData | undefined;
  }): GraphNode<TextInputNodeData> => ({
    id: nodeId,
    type,
    position: { x: 0, y: 0 },
    data:
      nodePropsData ?? {
        label: '文本节点',
        description: undefined,
        runtimeRef: undefined,
        segments: [],
        lastExecutionId: undefined,
        lastSourceNodeId: undefined,
        lastSourcePortId: undefined,
        separator: 'comma',
        customSeparator: undefined,
        promptPresetSnapshots: undefined,
        taskInfo: undefined,
        promptInterview: undefined,
      },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  }),
  useNodeFromStore: () => mockNodeFromStoreResult,
}));

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: () => '/tmp/demo.iartproj',
}));

vi.mock('@iart/backend-sdk/electron-bridge', () => ({
  revealTaskArchive: vi.fn(),
}));

const createTextNodeData = (): TextInputNodeData => ({
  label: 'Text',
  description: undefined,
  runtimeRef: undefined,
  segments: [{ kind: 'local', id: 'local_1', enabled: true, text: 'hello' }],
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  separator: 'comma',
  customSeparator: undefined,
  promptPresetSnapshots: undefined,
  taskInfo: undefined,
  promptInterview: undefined,
});

const createMultiSegmentTextNodeData = (): TextInputNodeData => ({
  label: 'Text',
  description: undefined,
  runtimeRef: undefined,
  segments: [
    { kind: 'local', id: 'local_1', enabled: true, text: 'hello' },
    { kind: 'local', id: 'local_2', enabled: true, text: 'world' },
  ],
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  separator: 'comma',
  customSeparator: undefined,
  promptPresetSnapshots: undefined,
  taskInfo: undefined,
  promptInterview: undefined,
});

const createNode = (): GraphNode<TextInputNodeData> => ({
  id: 'node-text-1',
  type: 'textInput',
  position: { x: 0, y: 0 },
  data: createTextNodeData(),
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const createMultiSegmentNode = (): GraphNode<TextInputNodeData> => ({
  ...createNode(),
  data: createMultiSegmentTextNodeData(),
});

const createMockNodeGraph = (nodes: GraphNode<TextInputNodeData>[]): NodeGraph => {
  const graph = createNodeGraph({
    name: 'Graph',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  graph.id = 'graph-1';
  graph.nodes = nodes;
  graph.viewport = { x: 0, y: 0, zoom: 1 };
  return graph;
};

const renderNode = (selected: boolean) => {
  const node = createNode();
  mockNodeFromStoreResult = {
    node,
    data: node.data,
  };
  mockCanvasState.nodeGraph = createMockNodeGraph([node]);

  return render(
    <TextInputNode
      id={node.id}
      type="textInput"
      data={{ ...node.data }}
      selected={selected}
      draggable={true}
      dragging={false}
      zIndex={0}
      selectable={true}
      deletable={true}
      isConnectable={true}
      positionAbsoluteX={0}
      positionAbsoluteY={0}
    />,
  );
};

const getOverlay = (container: HTMLElement): HTMLDivElement => {
  const overlay = container.querySelector(
    '.absolute.inset-0.z-10',
  ) as HTMLDivElement | null;
  if (overlay === null) {
    throw new Error('未找到文本节点 overlay');
  }
  return overlay;
};

describe('TextInputNode 选中与编辑主链', () => {
  beforeAll(() => {
    if (typeof globalThis.PointerEvent === 'undefined') {
      globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
    }
  });

  afterAll(() => {
    globalThis.PointerEvent = originalPointerEvent;
  });

  beforeEach(() => {
    mockCanvasState = {
      nodeGraph: createMockNodeGraph([]),
      selectedNodeIds: [],
      updateNodeData: vi.fn(),
    };
    mockExecutionState = {
      getNodeDiagnosticInfo: () => null,
    };
    mockNodeFromStoreResult = {
      node: createNode(),
      data: createTextNodeData(),
    };
  });

  it('未选中时第一次点击只允许走 ReactFlow 原生选中，不得直接进入编辑', () => {
    const { container } = renderNode(false);
    const overlay = getOverlay(container);

    fireEvent.pointerDown(overlay, {
      button: 0,
      clientX: 12,
      clientY: 16,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      clientX: 12,
      clientY: 16,
    });

    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('已选中时再次点击应进入编辑态而不是再次请求选中', async () => {
    mockCanvasState.selectedNodeIds = ['node-text-1'];
    const { container } = renderNode(true);
    const overlay = getOverlay(container);

    fireEvent.pointerDown(overlay, {
      button: 0,
      clientX: 12,
      clientY: 16,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      clientX: 12,
      clientY: 16,
    });

    await waitFor(() => {
      expect(screen.getByRole('textbox')).not.toBeNull();
    });
  });

  it('未选中节点的拖拽手势不得补发迟到选中', () => {
    const { container } = renderNode(false);
    const overlay = getOverlay(container);

    fireEvent.pointerDown(overlay, {
      button: 0,
      clientX: 12,
      clientY: 16,
    });
    fireEvent.pointerMove(overlay, {
      button: 0,
      clientX: 24,
      clientY: 32,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      clientX: 24,
      clientY: 32,
    });

    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('已选中节点的拖拽手势不得误进入编辑态', () => {
    mockCanvasState.selectedNodeIds = ['node-text-1'];
    const { container } = renderNode(true);
    const overlay = getOverlay(container);

    fireEvent.pointerDown(overlay, {
      button: 0,
      clientX: 12,
      clientY: 16,
    });
    fireEvent.pointerMove(overlay, {
      button: 0,
      clientX: 24,
      clientY: 32,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      clientX: 24,
      clientY: 32,
    });

    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('多段文本节点不应暴露 textarea/textbox 语义', () => {
    const node = createMultiSegmentNode();
    mockNodeFromStoreResult = {
      node,
      data: node.data,
    };
    mockCanvasState.nodeGraph = createMockNodeGraph([node]);

    const { container } = render(
      <TextInputNode
        id={node.id}
        type="textInput"
        data={{ ...node.data }}
        selected={false}
        draggable={true}
        dragging={false}
        zIndex={0}
        selectable={true}
        deletable={true}
        isConnectable={true}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
    );

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });
});
