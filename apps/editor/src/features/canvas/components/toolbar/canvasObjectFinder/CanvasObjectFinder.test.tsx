import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, beforeEach, vi, expect } from 'vitest';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { AgentSessionRecord } from '@iart/contracts';
import { CanvasObjectFinder } from './CanvasObjectFinder';
import { useCanvasStore } from '../../../store/canvasStore';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { createNodeGraph } from '../../../types/nodeGraph';
import type {
  GraphNode,
  GroupNodeData,
} from '../../../types';
import type { AgentNodeData } from '../../../types/agentNode';
import type { AssetNodeData, TaskNodeData } from '../../../types/taskNode';

/**
 * mock useLocateToNode：定位主抽象。CanvasObjectFinder 委托给它执行定位。
 * 定位语义（中心点、几何源、竞态保护）由 useLocateToNode 自己的测试覆盖；
 * 本测试只验证查找器把正确的 nodeId + reason 传给它。
 */
const locateToNodeMock = vi.fn();
vi.mock('../../../hooks/useLocateToNode', () => ({
  useLocateToNode: () => locateToNodeMock,
}));

/**
 * 测试工具：在 ReactFlowProvider 内渲染 node。
 * CanvasObjectFinder 壳层用 useOptionalReactFlow 判断 RF 可用性，需要 Provider 祖先。
 */
function renderWithProvider(node: ReactNode) {
  return render(<ReactFlowProvider>{node}</ReactFlowProvider>);
}

const PLACEHOLDER = '查找节点 (Cmd/Ctrl+G)';

const resetStores = () => {
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
  useAgentSessionStore.setState({
    sessionsById: {},
    inFlightBySessionId: {},
    errorsBySessionId: {},
  });
};

// ────────────────────────────────────────────
// 节点夹具（与引擎测试 finderModel.test.ts 同口径）
// ────────────────────────────────────────────

const makeNode = (
  id: string,
  type: GraphNode['type'],
  data: GraphNode['data'],
  groupId: string | undefined = undefined,
): GraphNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

const createGroupNode = (id: string, name: string, collapsed = false): GraphNode =>
  makeNode(id, 'group', {
    label: undefined,
    description: undefined,
    runtimeRef: undefined,
    name,
    collapsed,
    color: undefined,
  } satisfies GroupNodeData);

const createAgentNode = (id: string, sessionId: string): GraphNode =>
  makeNode(id, 'agent', {
    label: 'Agent',
    agentSessionId: sessionId,
  } satisfies AgentNodeData);

const createTaskNode = (
  id: string,
  status: TaskNodeData['status'],
  modelId = 'gpt-image-2',
  updatedAt = 2000,
): GraphNode =>
  makeNode(id, 'task', {
    label: modelId,
    modelId,
    taskId: `${id}-task`,
    taskIndex: 0,
    batchId: `${id}-batch`,
    status,
    progressPercent: null,
    progressPhase: null,
    errorMessage: null,
    failure: null,
    createdAt: 1000,
    updatedAt,
  } satisfies TaskNodeData);

const createAssetNode = (id: string, sourceModelId: string): GraphNode =>
  makeNode(id, 'asset', {
    label: '资产',
    sourceBatchId: `${id}-batch`,
    sourceTaskId: `${id}-task`,
    sourceModelId,
    mediaType: 'image',
    assetId: `${id}-asset`,
  } satisfies AssetNodeData);

const makeSession = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  agentSessionId: 'sess-1',
  nodeId: 'node-agent',
  modelId: 'glm-5.3-flash',
  thinkingTier: 'off',
  approvalMode: 'confirm',
  title: '分镜脚本会话',
  createdAt: 1000,
  updatedAt: 2000,
  messageCount: 24,
  lastMessageAt: 3000,
  ...overrides,
});

const seedGraph = (nodes: GraphNode[]) => {
  const graph = createNodeGraph({
    name: '测试画板',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  graph.nodes = nodes;
  useCanvasStore.setState({ nodeGraph: graph });
};

/** 画布含组/Agent/任务/资产各一，覆盖候选渲染与筛选用例。 */
const seedMixedCanvas = () => {
  seedGraph([
    createGroupNode('grp-1', '主视觉组'),
    createAgentNode('node-agent', 'sess-1'),
    createTaskNode('node-task', 'failed', 'gpt-image-2'),
    createAssetNode('node-asset', 'veo-3.1'),
  ]);
  useAgentSessionStore.setState({
    sessionsById: { 'sess-1': makeSession() },
  });
};

describe('CanvasObjectFinder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('渲染不崩溃且显示占位符「查找节点 (Cmd/Ctrl+G)」', () => {
    renderWithProvider(<CanvasObjectFinder />);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    expect(input).toBeInTheDocument();
  });

  it('画布无对象时聚焦显示「画布上还没有可查找的对象」空态', async () => {
    renderWithProvider(<CanvasObjectFinder />);
    fireEvent.focus(screen.getByPlaceholderText(PLACEHOLDER));
    await waitFor(() => {
      expect(screen.getByText('画布上还没有可查找的对象')).toBeInTheDocument();
    });
  });

  it('候选渲染：组 / Agent / 任务 / 媒体各一，主标题与副行正确', async () => {
    seedMixedCanvas();
    renderWithProvider(<CanvasObjectFinder />);
    fireEvent.focus(screen.getByPlaceholderText(PLACEHOLDER));
    await waitFor(() => {
      // 组：主标题 + 成员数副行
      expect(screen.getByText('主视觉组')).toBeInTheDocument();
      expect(screen.getByText('0 个成员 · 已展开')).toBeInTheDocument();
      // Agent：会话标题主行，状态词在副行（限结果项内查找，与筛选行按钮消歧）
      expect(screen.getByText('分镜脚本会话')).toBeInTheDocument();
      const agentItem = screen.getByText('分镜脚本会话').closest('[cmdk-item]');
      expect(agentItem).not.toBeNull();
      expect(agentItem).toHaveTextContent('空闲');
      // 任务：模型 ID 主行 + 失败状态（状态词与筛选按钮同名，用结果项内 span 消歧）
      expect(screen.getByText('gpt-image-2')).toBeInTheDocument();
      const failedTaskItem = screen.getByText('gpt-image-2').closest('[cmdk-item]');
      expect(failedTaskItem).not.toBeNull();
      expect(failedTaskItem).toHaveTextContent('失败');
      // 资产（媒体）：模型 ID 主行
      expect(screen.getByText('veo-3.1')).toBeInTheDocument();
    });
  });

  it('类型筛选生效：选「组」后只留组条目', async () => {
    seedMixedCanvas();
    renderWithProvider(<CanvasObjectFinder />);
    fireEvent.focus(screen.getByPlaceholderText(PLACEHOLDER));
    await waitFor(() => {
      expect(screen.getByText('分镜脚本会话')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '组' }));
    await waitFor(() => {
      expect(screen.getByText('主视觉组')).toBeInTheDocument();
      expect(screen.queryByText('分镜脚本会话')).not.toBeInTheDocument();
      expect(screen.queryByText('gpt-image-2')).not.toBeInTheDocument();
      expect(screen.queryByText('veo-3.1')).not.toBeInTheDocument();
    });
  });

  it('状态筛选生效：选「失败」后排除无状态对象（组）只留失败任务', async () => {
    seedMixedCanvas();
    renderWithProvider(<CanvasObjectFinder />);
    fireEvent.focus(screen.getByPlaceholderText(PLACEHOLDER));
    await waitFor(() => {
      expect(screen.getByText('主视觉组')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '失败' }));
    await waitFor(() => {
      expect(screen.getByText('gpt-image-2')).toBeInTheDocument();
      expect(screen.queryByText('主视觉组')).not.toBeInTheDocument();
      expect(screen.queryByText('分镜脚本会话')).not.toBeInTheDocument();
      expect(screen.queryByText('veo-3.1')).not.toBeInTheDocument();
    });
  });

  it('有关键词输入但无匹配时显示「没有匹配的节点」空态', async () => {
    seedMixedCanvas();
    renderWithProvider(<CanvasObjectFinder />);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    await waitFor(() => {
      expect(screen.getByText('主视觉组')).toBeInTheDocument();
    });
    fireEvent.change(input, { target: { value: '不存在的对象名' } });
    await waitFor(() => {
      expect(screen.getByText('没有匹配的节点')).toBeInTheDocument();
      expect(screen.queryByText('主视觉组')).not.toBeInTheDocument();
    });
  });

  it('键盘 Enter（无高亮）定位列表首项，nodeId 正确传给 useLocateToNode', async () => {
    seedMixedCanvas();
    renderWithProvider(<CanvasObjectFinder />);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    await waitFor(() => {
      expect(screen.getByText('主视觉组')).toBeInTheDocument();
    });
    // 不动高亮直接 Enter → 定位首项（排序后最佳匹配：Agent 有最近活动时间，排最前）
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(locateToNodeMock).toHaveBeenCalledTimes(1);
    });
    const firstCall = locateToNodeMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toBe('node-agent');
    expect(firstCall?.[1]).toBe('locate-finder');
  });

  it('键盘 ArrowDown/ArrowUp 循环移动 data-active 高亮（统一基元接线）', async () => {
    seedMixedCanvas();
    renderWithProvider(<CanvasObjectFinder />);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    await waitFor(() => {
      expect(screen.getByText('主视觉组')).toBeInTheDocument();
    });
    // 注：cmdk List 会用内部生成的 listId 覆盖传入的 id，故这里用 role 定位列表容器
    const items = screen.getByRole('listbox').querySelectorAll('[cmdk-item]');
    expect(items.length).toBeGreaterThan(1);
    // 打开即首项高亮（基元索引归 0 = 首项最佳匹配）
    expect(items[0]).toHaveAttribute('data-active', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items[1]).toHaveAttribute('data-active', 'true');
    expect(items[0]).not.toHaveAttribute('data-active');
    // 连续 ↑ 两次：1 → 0 → 末项（wrap 循环与旧手写实现同语义）
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(items[0]).toHaveAttribute('data-active', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const last = items[items.length - 1];
    expect(last).not.toBeNull();
    expect(last).toHaveAttribute('data-active', 'true');
  });

  it('悬停同步：pointerMove 结果项包裹层后 data-active 移到悬停项，键盘基于同一索引移动', async () => {
    seedMixedCanvas();
    renderWithProvider(<CanvasObjectFinder />);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    await waitFor(() => {
      expect(screen.getByText('主视觉组')).toBeInTheDocument();
    });
    // 注：cmdk List 会用内部生成的 listId 覆盖传入的 id，故这里用 role 定位列表容器
    const items = screen.getByRole('listbox').querySelectorAll('[cmdk-item]');
    const secondWrapper = items[1]?.parentElement;
    if (secondWrapper === null || secondWrapper === undefined) {
      throw new Error('第二项的悬停包裹层不存在');
    }
    fireEvent.pointerMove(secondWrapper);
    expect(items[1]).toHaveAttribute('data-active', 'true');
    expect(items[0]).not.toHaveAttribute('data-active');
    // 悬停写入后键盘基于同一索引相对移动
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items[2]).toHaveAttribute('data-active', 'true');
  });

  it('Cmd/Ctrl+G 聚焦查找框并打开下拉（window 级监听）', async () => {
    seedMixedCanvas();
    renderWithProvider(<CanvasObjectFinder />);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    // 焦点在画布（body）时按 Cmd+G
    act(() => {
      fireEvent.keyDown(window, { key: 'g', metaKey: true });
    });
    await waitFor(() => {
      expect(screen.getByText('主视觉组')).toBeInTheDocument();
      expect(screen.getByText('分镜脚本会话')).toBeInTheDocument();
    });
    expect(input).toHaveFocus();
  });
});
