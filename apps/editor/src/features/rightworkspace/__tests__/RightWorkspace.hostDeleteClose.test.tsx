import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createGraphNode } from '@/features/canvas/types/node';
import type { GraphNode, NodeGraph } from '@/features/canvas/types';
import type { AgentNodeData } from '@/features/canvas/types/agentNode';
import {
  RIGHT_WORKSPACE_WIDTH_DEFAULT,
  useRightWorkspaceStore,
} from '../rightWorkspaceStore';

/**
 * 会话视图宿主节点删除同步关闭（spec docs/agent/02「会话视图与多轮历史」）：
 * 面板正显示某会话、画布上已无任何节点持有该会话引用（覆盖 chrome/右键菜单/键盘/
 * 组连删等全部删除入口的共同后置状态）时，容器同步关闭，不保留指向已删节点的孤儿视图；
 * nodeGraph 未就绪（项目加载中）不判定。
 *
 * 打包区面板与 AgentSessionView 重内容不在本测试职责内，替换为轻桩。
 */

vi.mock('../components/AgentSessionView', () => ({
  AgentSessionView: () => <div data-testid="agent-session-view-stub" />,
}));
vi.mock('@/features/package-area/components/PackageAreaPanel', () => ({
  PackageAreaPanel: () => <div data-testid="package-area-panel-stub" />,
}));
vi.mock('../useAgentSessionErrorToast', () => ({
  useAgentSessionErrorToast: () => undefined,
}));
const loadPackageArea = vi.fn();
const reset = vi.fn();
vi.mock('@/features/package-area/store/packageAreaStore', () => ({
  usePackageAreaStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ loadPackageArea, reset }),
}));

import { RightWorkspace } from '../RightWorkspace';

const AGENT_NODE_ID = 'agent-node-1';
const SESSION_ID = 'sess_1';

const agentNode = (): GraphNode<AgentNodeData> => ({
  ...createGraphNode<AgentNodeData>({
    type: 'agent',
    position: { x: 10, y: 20 },
    data: { label: 'Agent', agentSessionId: SESSION_ID },
  }),
  id: AGENT_NODE_ID,
});

const graphWith = (nodes: GraphNode[]): NodeGraph => ({
  id: 'graph-1',
  name: 'test',
  description: undefined,
  status: 'draft',
  nodes,
  annotations: [],
  variables: undefined,
  settings: undefined,
  viewport: { x: 0, y: 0, zoom: 1 },
  meta: {
    version: '1.0.0',
    schemaVersion: undefined,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

const openSessionView = () => {
  useRightWorkspaceStore.setState({
    activeKind: 'agentSession',
    agentSessionId: SESSION_ID,
    width: RIGHT_WORKSPACE_WIDTH_DEFAULT,
  });
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useRightWorkspaceStore.setState({
    activeKind: null,
    agentSessionId: null,
    width: RIGHT_WORKSPACE_WIDTH_DEFAULT,
  });
  useCanvasStore.setState({
    nodeGraph: graphWith([agentNode()]),
    selectedNodeIds: [],
  });
});

describe('会话视图宿主节点删除同步关闭', () => {
  it('面板正显示某会话、其宿主节点被删除（图中再无引用）→ 容器同步关闭', () => {
    openSessionView();
    const { getByTestId } = render(<RightWorkspace />);
    expect(getByTestId('right-workspace').getAttribute('data-open')).toBe('true');

    act(() => {
      useCanvasStore.setState({ nodeGraph: graphWith([]) });
    });

    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();
    expect(getByTestId('right-workspace').getAttribute('data-open')).toBe('false');
  });

  it('宿主仍在（图发生其他变化）→ 面板保持打开', () => {
    openSessionView();
    const { getByTestId } = render(<RightWorkspace />);

    act(() => {
      useCanvasStore.setState({ nodeGraph: graphWith([agentNode()]) });
    });

    expect(useRightWorkspaceStore.getState().activeKind).toBe('agentSession');
    expect(getByTestId('right-workspace').getAttribute('data-open')).toBe('true');
  });

  it('nodeGraph 未就绪（null，项目加载中）→ 不判定、面板保持打开', () => {
    openSessionView();
    useCanvasStore.setState({ nodeGraph: null });
    const { getByTestId } = render(<RightWorkspace />);

    expect(useRightWorkspaceStore.getState().activeKind).toBe('agentSession');
    expect(getByTestId('right-workspace').getAttribute('data-open')).toBe('true');
  });
});
