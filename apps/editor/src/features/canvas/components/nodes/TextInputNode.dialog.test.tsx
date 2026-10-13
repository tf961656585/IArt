import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import { vi } from 'vitest';
import { TextInputNode } from './TextInputNode';
import type { GraphNode, TextInputNodeData, NodeTaskInfo } from '../../types';
import { toNodePropsData } from '../__tests__/fixtures/canvasComponentFixtures';

function createTextInputData(
  overrides: Partial<TextInputNodeData> = {},
): TextInputNodeData {
  return {
    label: 'Text',
    description: undefined,
    runtimeRef: undefined,
    segments: [{ kind: 'local', id: 'local_1', enabled: true, text: '' }],
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    separator: 'comma',
    customSeparator: undefined,
    promptPresetSnapshots: undefined,
    taskInfo: undefined,
    promptInterview: undefined,
    ...overrides,
  };
}

vi.mock('@xyflow/react', () => ({
  NodeResizer: () => null,
  NodeToolbar: ({ isVisible, children }: { isVisible?: boolean; children: React.ReactNode }) =>
    isVisible ? <div data-testid="node-toolbar">{children}</div> : null,
  Position: { Top: 'top' },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useUpdateNodeInternals: () => vi.fn(),
  useReactFlow: () => ({ setCenter: vi.fn() }),
}));

function createNodeData(): GraphNode<TextInputNodeData> {
  return {
    id: 'text_node_1',
    type: 'textInput',
    position: { x: 0, y: 0 },
    data: createTextInputData({
      segments: [
        { kind: 'local', id: 'local_1', enabled: true, text: 'hello' },
        { kind: 'local', id: 'local_2', enabled: true, text: 'world' },
      ],
    }),
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
}

function createSimpleLocalNodeData(overrides?: Partial<TextInputNodeData>): GraphNode<TextInputNodeData> {
  return {
    id: 'text_node_simple',
    type: 'textInput',
    position: { x: 0, y: 0 },
    data: createTextInputData(overrides),
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
}

function renderNode(nodeData: GraphNode<TextInputNodeData>, selected = true) {
  return render(
    <ReactFlowProvider>
      <TextInputNode
        id={nodeData.id}
        data={toNodePropsData(nodeData)}
        selected={selected}
        type="textInput"
        draggable={true}
        dragging={false}
        zIndex={0}
        selectable={true}
        deletable={true}
        isConnectable={true}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>,
  );
}

const generatingTaskInfo: NodeTaskInfo = {
  taskId: 'task-1',
  remoteRequestId: undefined,
  taskIndex: undefined,
  modelId: 'test-model',
  status: 'generating',
  progress: null,
  createdAt: 0,
  updatedAt: 0,
  error: undefined,
  failure: null,
  batchId: undefined,
};

describe('TextInputNode 放大编辑', () => {
  it('不显示放大编辑按钮（多段）', () => {
    const nodeData = createNodeData();

    renderNode(nodeData, true);
    expect(screen.queryByLabelText('放大编辑')).not.toBeInTheDocument();
  });

  it('显示放大编辑按钮并可打开弹窗（单段本地文本）', async () => {
    const nodeData = createSimpleLocalNodeData();
    const user = userEvent.setup();

    renderNode(nodeData, true);

    const openButton = screen.getByLabelText('放大编辑');
    await user.click(openButton);
    expect(await screen.findByRole('heading', { name: '放大编辑' })).toBeInTheDocument();
  });

  it('编辑锁定状态不显示放大编辑按钮', () => {
    const nodeData = createSimpleLocalNodeData({ taskInfo: generatingTaskInfo });

    renderNode(nodeData, true);
    expect(screen.queryByLabelText('放大编辑')).not.toBeInTheDocument();
  });
});
