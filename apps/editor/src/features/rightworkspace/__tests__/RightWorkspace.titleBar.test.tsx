import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import type { AgentSessionRecord } from '@iart/contracts';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createGraphNode } from '@/features/canvas/types/node';
import type { GraphNode, NodeGraph } from '@/features/canvas/types';
import type { AgentNodeData } from '@/features/canvas/types/agentNode';
import {
  RIGHT_WORKSPACE_WIDTH_DEFAULT,
  useRightWorkspaceStore,
} from '../rightWorkspaceStore';

/**
 * 右侧工作区标题栏（spec docs/agent/02「会话视图与多轮历史」、docs/editor/右侧工作区与打包区服务）：
 *
 * 保护：
 * - Agent 会话内容的标题栏显示**当前会话标题**（会话身份信息只在标题栏出现一次，内容区不再重复）；
 * - 标题为空串 / 只有空白 → 「未命名会话」（标题栏不留空白）；
 * - 会话不可用（没有会话 id 或会话记录查不到）→ 回退常量「Agent 会话」；
 * - 关闭钮的无障碍名保持「关闭 Agent 会话」，不随会话标题变化；
 * - 标题可截断显示，title 属性携带全称。
 *
 * 打包区面板与会话视图重内容不在本测试职责内，替换为轻桩。
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

const agentNode = (): GraphNode<AgentNodeData> => ({
  ...createGraphNode<AgentNodeData>({
    type: 'agent',
    position: { x: 10, y: 20 },
    data: { label: 'Agent', agentSessionId: SESSION_ID },
  }),
  id: AGENT_NODE_ID,
});

const sessionRecord = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  agentSessionId: SESSION_ID,
  nodeId: AGENT_NODE_ID,
  modelId: 'my-llm',
  thinkingTier: 'off',
  approvalMode: 'confirm',
  title: '画一只在雨中弹吉他的柴犬',
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_600_000,
  messageCount: 2,
  lastMessageAt: 1_770_000_600_000,
  ...overrides,
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useRightWorkspaceStore.setState({
    activeKind: 'agentSession',
    agentSessionId: SESSION_ID,
    width: RIGHT_WORKSPACE_WIDTH_DEFAULT,
  });
  useAgentSessionStore.setState({
    sessionsById: { [SESSION_ID]: sessionRecord() },
    sessionIdByNodeId: { [AGENT_NODE_ID]: SESSION_ID },
  });
  useCanvasStore.setState({ nodeGraph: graphWith([agentNode()]), selectedNodeIds: [] });
});

describe('右侧工作区标题栏', () => {
  it('Agent 会话：标题栏显示当前会话标题，悬浮全称，关闭钮无障碍名保持常量', () => {
    render(<RightWorkspace />);

    const title = screen.getByTestId('right-workspace-title');
    expect(title).toHaveTextContent('画一只在雨中弹吉他的柴犬');
    expect(title).toHaveAttribute('title', '画一只在雨中弹吉他的柴犬');
    expect(title.className).toContain('truncate');
    expect(screen.getByRole('button', { name: '关闭 Agent 会话' })).toBeInTheDocument();
  });

  it('标题会话变化 / 会话元数据到达后：标题栏同步更新（订阅会话元数据）', () => {
    useAgentSessionStore.setState({ sessionsById: {} });
    const { rerender } = render(<RightWorkspace />);
    expect(screen.getByTestId('right-workspace-title')).toHaveTextContent('Agent 会话');

    act(() => {
      useAgentSessionStore.setState({
        sessionsById: { [SESSION_ID]: sessionRecord({ title: '改过的标题' }) },
      });
    });
    rerender(<RightWorkspace />);
    expect(screen.getByTestId('right-workspace-title')).toHaveTextContent('改过的标题');
  });

  it('标题为空串（或只有空白）→ 「未命名会话」，不留空白标题', () => {
    useAgentSessionStore.setState({
      sessionsById: { [SESSION_ID]: sessionRecord({ title: '   ' }) },
    });
    render(<RightWorkspace />);

    const title = screen.getByTestId('right-workspace-title');
    expect(title).toHaveTextContent('未命名会话');
    expect(title).toHaveAttribute('title', '未命名会话');
  });

  it('会话不可用（没有会话 id）→ 回退常量「Agent 会话」', () => {
    useRightWorkspaceStore.setState({ activeKind: 'agentSession', agentSessionId: null });
    render(<RightWorkspace />);

    expect(screen.getByTestId('right-workspace-title')).toHaveTextContent('Agent 会话');
    expect(screen.getByTestId('agent-session-view-unavailable')).toBeInTheDocument();
  });

  it('会话不可用（会话记录查不到）→ 回退常量「Agent 会话」', () => {
    useAgentSessionStore.setState({ sessionsById: {}, sessionIdByNodeId: {} });
    render(<RightWorkspace />);

    expect(screen.getByTestId('right-workspace-title')).toHaveTextContent('Agent 会话');
  });

  it('打包区标题不动态化：仍显示常量名', () => {
    useRightWorkspaceStore.setState({ activeKind: 'packageArea', agentSessionId: null });
    render(<RightWorkspace />);

    expect(screen.getByTestId('right-workspace-title')).toHaveTextContent('打包区');
    expect(screen.getByRole('button', { name: '关闭 打包区' })).toBeInTheDocument();
  });
});
