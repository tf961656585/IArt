import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GraphNode, NodeGraph, TextInputNodeData } from '@/features/canvas/types';
import { TextInputNode } from '../TextInputNode';
import {
  createNodeTaskInfoFixture,
  createTestNodeGraph,
  createTextInputDataFixture,
  createTextInputNodeFixture,
} from '../../__tests__/fixtures/canvasTestBuilders';

type TextInputCanvasState = {
  nodeGraph: NodeGraph;
  selectedNodeIds: string[];
  updateNodeData: ReturnType<typeof vi.fn>;
  addNode: ReturnType<typeof vi.fn>;
};

type TextInputExecutionState = {
  getNodeDiagnosticInfo: () => { backendMessage: string };
};

type TextInputNodeFromStoreResult = {
  node: GraphNode<TextInputNodeData>;
  data: TextInputNodeData;
};

let mockCanvasState: TextInputCanvasState;
let mockExecutionState: TextInputExecutionState;
let mockNodeFromStoreResult: TextInputNodeFromStoreResult;

const revealTaskArchiveMock = vi.fn(async (_taskId: string, _projectPath: string) => ({ ok: true }));

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
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/textarea', () => ({
  Textarea: (props: React.ComponentProps<'textarea'>) => <textarea {...props} />,
}));

vi.mock('../ContentNodeCard', () => ({
  ContentNodeCard: ({ children, overlay }: { children: React.ReactNode; overlay?: React.ReactNode }) => (
    <div>
      {overlay}
      {children}
    </div>
  ),
}));

vi.mock('../shared/TaskStatusBadge', () => ({
  TaskStatusBadge: ({ status }: { status?: string }) => <div>{status}</div>,
}));

vi.mock('../shared/PromptPresetSlashPopover', () => ({
  PromptPresetSlashPopover: () => null,
}));

vi.mock('../shared/PromptPresetTokenEditor', () => ({
  PromptPresetTokenEditor: ({
    value = '',
    onChange,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    onBlur?: React.FocusEventHandler<HTMLTextAreaElement>;
    onCompositionStart?: React.CompositionEventHandler<HTMLTextAreaElement>;
    onCompositionEnd?: React.CompositionEventHandler<HTMLTextAreaElement>;
  }) => (
    <textarea
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      onBlur={onBlur}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
    />
  ),
}));

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
  const useCanvasStore = <T,>(selector: (state: TextInputCanvasState) => T): T => selector(mockCanvasState);
  useCanvasStore.getState = (): TextInputCanvasState => mockCanvasState;
  return { useCanvasStore };
});

vi.mock('../../../store/executionStore', () => ({
  useExecutionStore: <T,>(selector: (state: TextInputExecutionState) => T): T => selector(mockExecutionState),
}));

vi.mock('../../../hooks/useNodeFromStore', () => ({
  resolveFallbackGraphNodeFromNodePropsData: ({
    nodeId,
    type,
    nodePropsData,
  }: {
    nodeId: string;
    type: GraphNode<TextInputNodeData>['type'];
    nodePropsData?: TextInputNodeData;
  }): GraphNode<TextInputNodeData> => ({
    ...createTextInputNodeFixture({
      id: nodeId,
      data: nodePropsData ?? createTextInputDataFixture(),
    }),
    type,
  }),
  useNodeFromStore: () => mockNodeFromStoreResult,
}));

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: () => '/tmp/demo.iartproj',
}));

vi.mock('@iart/backend-sdk/electron-bridge', () => ({
  revealTaskArchive: (taskId: string, projectPath: string) => revealTaskArchiveMock(taskId, projectPath),
}));

const buildNode = (): GraphNode<TextInputNodeData> =>
  createTextInputNodeFixture({
    id: 'node-text-1',
    data: createTextInputDataFixture({
      segments: [
        { kind: 'local', id: 'seg-1', text: 'hello', enabled: true },
        { kind: 'local', id: 'seg-2', text: 'world', enabled: true },
      ],
      taskInfo: createNodeTaskInfoFixture({
        taskId: 'task-text-archive-1',
        status: 'failed',
        error: '文本生成失败',
        modelId: 'text-model',
        createdAt: 1,
        updatedAt: 2,
      }),
    }),
  });

const buildSimpleNode = (): GraphNode<TextInputNodeData> =>
  createTextInputNodeFixture({
    id: 'node-text-1',
    data: createTextInputDataFixture({
      segments: [{ kind: 'local', id: 'seg-1', text: 'hello', enabled: true }],
    }),
  });

const textInputNodeElement = (node: GraphNode<TextInputNodeData>, selected = true) => (
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
  />
);

describe('TextInputNode archive action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const node = buildNode();
    mockCanvasState = {
      nodeGraph: createTestNodeGraph({
        id: 'graph-1',
        name: 'Graph',
        status: 'draft',
        nodes: [node],
      }),
      selectedNodeIds: [node.id],
      updateNodeData: vi.fn(),
      addNode: vi.fn(),
    };
    mockExecutionState = {
      getNodeDiagnosticInfo: () => ({
        backendMessage: 'backend-debug-message',
      }),
    };
    mockNodeFromStoreResult = { node, data: node.data };
  });

  it('失败态只提供任务文件夹入口，不再提供日志入口', async () => {
    render(
      <TextInputNode
        id="node-text-1"
        type="textInput"
        data={{ ...buildNode().data }}
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

    const archiveButton = screen.getByRole('button', { name: '打开任务文件夹' });
    expect(archiveButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开日志位置' })).toBeNull();

    fireEvent.click(archiveButton);
    expect(revealTaskArchiveMock).toHaveBeenCalledWith('task-text-archive-1', '/tmp/demo.iartproj');
  });

  it('简单文本输入只更新本地草稿，blur 时才提交 segments', () => {
    const node = buildSimpleNode();
    mockCanvasState.nodeGraph.nodes = [node];
    mockCanvasState.updateNodeData = vi.fn();
    mockNodeFromStoreResult = { node, data: node.data };

    render(
      <TextInputNode
        id="node-text-1"
        type="textInput"
        data={{ ...node.data }}
        selected={true}
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

    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'hello a' } });
    fireEvent.change(editor, { target: { value: 'hello ab' } });

    expect(editor.value).toBe('hello ab');
    expect(mockCanvasState.updateNodeData).not.toHaveBeenCalled();

    fireEvent.blur(editor);

    expect(mockCanvasState.updateNodeData).toHaveBeenCalledTimes(1);
    expect(mockCanvasState.updateNodeData).toHaveBeenCalledWith('node-text-1', {
      segments: [{ kind: 'local', id: 'seg-1', text: 'hello ab', enabled: true }],
    }, undefined);
  });

  it('简单文本输入未 blur 时组件卸载也会提交草稿', () => {
    const node = buildSimpleNode();
    mockCanvasState.nodeGraph.nodes = [node];
    mockCanvasState.updateNodeData = vi.fn();
    mockNodeFromStoreResult = { node, data: node.data };

    const { unmount } = render(textInputNodeElement(node));

    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'hello before unmount' } });

    expect(mockCanvasState.updateNodeData).not.toHaveBeenCalled();

    unmount();

    expect(mockCanvasState.updateNodeData).toHaveBeenCalledTimes(1);
    expect(mockCanvasState.updateNodeData).toHaveBeenCalledWith('node-text-1', {
      segments: [{ kind: 'local', id: 'seg-1', text: 'hello before unmount', enabled: true }],
    }, undefined);
  });

  it('简单文本输入未 blur 时进入锁定态也会提交草稿', () => {
    const node = buildSimpleNode();
    mockCanvasState.nodeGraph.nodes = [node];
    mockCanvasState.updateNodeData = vi.fn();
    mockNodeFromStoreResult = { node, data: node.data };

    const { rerender } = render(textInputNodeElement(node));

    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'hello before lock' } });

    expect(mockCanvasState.updateNodeData).not.toHaveBeenCalled();

    const lockedNode: GraphNode<TextInputNodeData> = {
      ...node,
      data: {
        ...node.data,
        taskInfo: createNodeTaskInfoFixture({
          taskId: 'task-text-lock-1',
          status: 'generating',
          modelId: 'text-model',
          createdAt: 1,
          updatedAt: 2,
        }),
      },
    };
    mockCanvasState.nodeGraph.nodes = [lockedNode];
    mockNodeFromStoreResult = { node: lockedNode, data: lockedNode.data };

    rerender(textInputNodeElement(lockedNode));

    expect(mockCanvasState.updateNodeData).toHaveBeenCalledTimes(1);
    expect(mockCanvasState.updateNodeData).toHaveBeenCalledWith('node-text-1', {
      segments: [{ kind: 'local', id: 'seg-1', text: 'hello before lock', enabled: true }],
    }, undefined);
  });

  it('composition 输入结束才提交最终文本，不提交中间态', () => {
    const node = buildSimpleNode();
    mockCanvasState.nodeGraph.nodes = [node];
    mockCanvasState.updateNodeData = vi.fn();
    mockNodeFromStoreResult = { node, data: node.data };

    render(
      <TextInputNode
        id="node-text-1"
        type="textInput"
        data={{ ...node.data }}
        selected={true}
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

    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: '中文' } });

    expect(mockCanvasState.updateNodeData).not.toHaveBeenCalled();

    fireEvent.compositionEnd(editor);

    expect(mockCanvasState.updateNodeData).toHaveBeenCalledTimes(1);
    expect(mockCanvasState.updateNodeData).toHaveBeenCalledWith('node-text-1', {
      segments: [{ kind: 'local', id: 'seg-1', text: '中文', enabled: true }],
    }, undefined);
  });

  it('composition 期间进入锁定态不会提交中间态，compositionEnd 后提交', () => {
    const node = buildSimpleNode();
    mockCanvasState.nodeGraph.nodes = [node];
    mockCanvasState.updateNodeData = vi.fn();
    mockNodeFromStoreResult = { node, data: node.data };

    const { rerender } = render(textInputNodeElement(node));

    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: '锁定前中文' } });

    const lockedNode: GraphNode<TextInputNodeData> = {
      ...node,
      data: {
        ...node.data,
        taskInfo: createNodeTaskInfoFixture({
          taskId: 'task-text-lock-1',
          status: 'generating',
          modelId: 'text-model',
          createdAt: 1,
          updatedAt: 2,
        }),
      },
    };
    mockCanvasState.nodeGraph.nodes = [lockedNode];
    mockNodeFromStoreResult = { node: lockedNode, data: lockedNode.data };

    rerender(textInputNodeElement(lockedNode));

    expect(mockCanvasState.updateNodeData).not.toHaveBeenCalled();

    fireEvent.compositionEnd(screen.getByRole('textbox'));

    expect(mockCanvasState.updateNodeData).toHaveBeenCalledTimes(1);
    expect(mockCanvasState.updateNodeData).toHaveBeenCalledWith('node-text-1', {
      segments: [{ kind: 'local', id: 'seg-1', text: '锁定前中文', enabled: true }],
    }, undefined);
  });
});
