import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type {
  GraphNode,
  NodeGraph,
  TextInputNodeData,
} from '@/features/canvas/types';
import type { AssetMentionCandidate } from '@/features/canvas/engine/promptAssetMentions';
import { assetMentionTokenOf } from '@/features/canvas/engine/promptAssetMentions';
import { TextInputNode } from '../TextInputNode';
import {
  createTestNodeGraph,
  createTextInputDataFixture,
  createTextInputNodeFixture,
} from '../../__tests__/fixtures/canvasTestBuilders';

type TextInputCanvasState = {
  nodeGraph: NodeGraph;
  mediaAssets: Record<string, unknown>;
  selectedNodeIds: string[];
  updateNodeData: ReturnType<typeof vi.fn>;
  pendingTextEditNodeId: string | null;
  clearNodeTextEditRequest: ReturnType<typeof vi.fn>;
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
const mentionPopoverCalls: Array<{ candidates: AssetMentionCandidate[]; disabled: boolean | undefined }> = [];

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

vi.mock('../shared/PromptMentionPopover', () => ({
  PromptMentionPopover: (props: {
    candidates: AssetMentionCandidate[];
    disabled: boolean | undefined;
  }) => {
    mentionPopoverCalls.push({ candidates: props.candidates, disabled: props.disabled });
    return null;
  },
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
  revealTaskArchive: vi.fn(async () => ({ ok: true })),
}));

const TOKEN_TEXT = `参考 ${assetMentionTokenOf('asset-1')} 生成`;

const buildTextNode = (): GraphNode<TextInputNodeData> =>
  createTextInputNodeFixture({
    id: 'node-text-1',
    data: createTextInputDataFixture({
      segments: [{ kind: 'local', id: 'seg-1', text: TOKEN_TEXT, enabled: true }],
    }),
  });

const renderTextNode = (node: GraphNode<TextInputNodeData>) =>
  render(
    <TextInputNode
      id={node.id}
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

describe('TextInputNode @ 素材引用（spec：prompt内联交互「生效位置」）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mentionPopoverCalls.length = 0;
    mockExecutionState = {
      getNodeDiagnosticInfo: () => ({ backendMessage: '' }),
    };
  });

  const setupCanvas = () => {
    const node = buildTextNode();
    mockCanvasState = {
      nodeGraph: createTestNodeGraph({ id: 'graph-1', name: 'Graph', status: 'draft', nodes: [node] }),
      mediaAssets: {},
      selectedNodeIds: [node.id],
      updateNodeData: vi.fn(),
      pendingTextEditNodeId: null,
      clearNodeTextEditRequest: vi.fn(),
    };
    mockNodeFromStoreResult = { node, data: node.data };
    return node;
  };

  it('模型节点退役后 @ 上下文固定禁用：已有 token 渲染失效态，不提供 @ 弹层', () => {
    const node = setupCanvas();
    renderTextNode(node);

    const chip = screen.getByText('@已失效引用');
    expect(chip.closest('[data-asset-id]')?.getAttribute('data-asset-id')).toBe('asset-1');
    expect(mentionPopoverCalls).toHaveLength(0);
  });
});
