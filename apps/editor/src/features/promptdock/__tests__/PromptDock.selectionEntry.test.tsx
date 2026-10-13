import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AgentSessionRecord, ChatModelDirectoryEntry } from '@iart/contracts';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import type * as AgentSessionStoreModule from '@/features/agent/agentSessionStore';
import { nodeRegistry } from '@/features/canvas/nodes/registry';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createGraphNode } from '@/features/canvas/types/node';
import type { GraphNode, NodeGraph } from '@/features/canvas/types';
import type { AgentNodeData } from '@/features/canvas/types/agentNode';
import { PromptDock } from '../PromptDock';
import { usePromptDockStore } from '../promptDockStore';
import { enterAgentFormFromSelection, usePromptDockAgentEntryRestore } from '../agentEntry';
import { useRightWorkspaceStore } from '@/features/rightworkspace/rightWorkspaceStore';

/**
 * 选中驱动的进入—还原—粘滞（spec docs/agent/06「形态切换入口·选中驱动的进入—还原—粘滞」、
 * spec docs/agent/02「选中态工具栏」）。
 *
 * 接缝性质：画布选择事实源（真实 canvasStore）→ PromptDock store（真实 store）→
 * 输入面组件（真实 PromptDock）；只有网络提交被替换。
 * 保护三条：
 * - 普通单击选中持有会话引用的 Agent 节点 → 进入并绑定，记录进入前的「形态 + 绑定」；
 * - 选择集离开该节点 → 还原进入前的形态与绑定，草稿原样保留；
 * - 该会话的消息被受理后成为当前会话（粘滞）→ 选择变化不再还原。
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/client/store/runtimeStore', () => ({
  __esModule: true,
  getRuntimeProjectPath: () => '/tmp/iart-promptdock-selection-entry-test',
}));

vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  fetchExecutableModelCatalog: vi.fn(async () => []),
  fetchChatModelCatalog: vi.fn(async () => []),
  submitGenerationBatch: vi.fn(),
}));

vi.mock('@/features/promptdock/projection/taskProjectionService', () => ({
  __esModule: true,
  createTaskProjectionsForAcceptance: vi.fn(() => ({ ok: true as const })),
}));

vi.mock('@/features/agent/agentSessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionStoreModule>();
  return {
    ...actual,
    submitAgentPrompt: vi.fn(),
    updateAgentSessionConfig: vi.fn(),
  };
});

const AGENT_NODE_ID = 'agent-node-1';
const BOUND_SESSION_ID = 'sess_1';

const chatEntry = (modelId: string): ChatModelDirectoryEntry => ({
  model_id: modelId,
  model_version: '1.0.0',
  default_task_type: 'text',
  capability: { input_modalities: ['text'], output_modalities: ['text'] },
  parameter_schema: { fields: [], required_fields: [] },
  thinking_tiers: ['low', 'high'],
  default_thinking_tier: null,
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_chat',
    deployable: true,
    failure_code: 'none',
  },
});

const sessionRecord = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  agentSessionId: BOUND_SESSION_ID,
  nodeId: AGENT_NODE_ID,
  modelId: 'my-llm',
  thinkingTier: 'high',
  approvalMode: 'confirm',
  title: '画一只在雨中弹吉他的柴犬',
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_600_000,
  messageCount: 1,
  lastMessageAt: 1_770_000_600_000,
  ...overrides,
});

const agentNode = (id: string, agentSessionId: string): GraphNode<AgentNodeData> => ({
  ...createGraphNode<AgentNodeData>({
    type: 'agent',
    position: { x: 10, y: 20 },
    data: { label: 'Agent', agentSessionId },
  }),
  id,
});

const MEMBER_ID = 'member-keyframe-1';
const MEMBER_ID_2 = 'member-keyframe-2';
const FREE_NODE_ID = 'free-media-1';
const GROUP_NODE_ID = 'group-1';

/** 容器成员（图片素材节点）：走真实注册表建节点，只改写 id 与所属容器（成员侧 groupId 指向容器）。 */
const memberNode = (id: string, containerId: string): GraphNode => {
  const node = nodeRegistry.createNode('imageInput', { x: 40, y: 60 }, undefined);
  if (node === null) throw new Error('imageInput 节点定义未注册');
  return { ...node, id, groupId: containerId };
};

/** 普通组节点（容器的一种，但不是 Agent 容器）。 */
const groupNode = (id: string): GraphNode => {
  const node = nodeRegistry.createNode('group', { x: 0, y: 0 }, undefined);
  if (node === null) throw new Error('group 节点定义未注册');
  return { ...node, id };
};

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
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

/** 选中集变化的真实写入口（画布选择事实源；与选择桥同一条投影动作）。 */
const selectOnCanvas = (nodeIds: string[]) => {
  useCanvasStore.getState().projectSelectionContract({
    selectedNodeIds: nodeIds,
    selectedAnnotationIds: [],
    editingAnnotationId: null,
    pendingAnnotationBinding: null,
  });
};

/** 画布层挂载的还原观察者 + 真实 PromptDock（接缝两端都是真实实现）。 */
function Harness() {
  usePromptDockAgentEntryRestore();
  return <PromptDock />;
}

beforeEach(() => {
  cleanup();
  usePromptDockStore.setState({
    form: 'generate',
    draft: {
      modelId: 'gpt-image-2',
      modelVersion: '1.0.0',
      prompt: '还没发出去的生成式草稿',
      arguments: {},
      references: [],
      promptPresetSnapshots: undefined,
      taskCount: 1,
    },
    catalogLoaded: true,
    chatCatalog: [chatEntry('my-llm')],
    chatCatalogLoaded: true,
    agentSelection: { modelId: 'my-llm', thinkingTier: 'high', approval: 'confirm' },
    agentBinding: null,
    submitting: false,
    preflightIssues: null,
  });
  useAgentSessionStore.setState({
    sessionsById: { [BOUND_SESSION_ID]: sessionRecord() },
    sessionIdByNodeId: { [AGENT_NODE_ID]: BOUND_SESSION_ID },
  });
  useCanvasStore.setState({
    nodeGraph: graphWith([agentNode(AGENT_NODE_ID, BOUND_SESSION_ID)]),
    selectedNodeIds: [],
    selectedAnnotationIds: [],
    mediaAssets: {},
  });
  useRightWorkspaceStore.setState({ activeKind: null, agentSessionId: null });
});

describe('选中驱动进入', () => {
  it('普通单击选中持有会话引用的 Agent 节点 → 进入 agent 形态并绑定该会话，记下进入前的形态与绑定', () => {
    act(() => {
      selectOnCanvas([AGENT_NODE_ID]);
      enterAgentFormFromSelection(AGENT_NODE_ID);
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('agent');
    expect(state.agentBinding).toEqual({
      nodeId: AGENT_NODE_ID,
      agentSessionId: BOUND_SESSION_ID,
    });
    expect(state.agentEntrySnapshot).toEqual({
      nodeId: AGENT_NODE_ID,
      agentSessionId: BOUND_SESSION_ID,
      form: 'generate',
      binding: null,
    });
    // 进入不丢弃任何草稿
    expect(state.draft.prompt).toBe('还没发出去的生成式草稿');
    // 选中驱动打开会话视图（spec 06「历史承载与会话视图」）：进入的同一动作带到右侧工作区
    expect(useRightWorkspaceStore.getState().activeKind).toBe('agentSession');
    expect(useRightWorkspaceStore.getState().agentSessionId).toBe(BOUND_SESSION_ID);
  });

  it('选中集离开该节点（点空白）→ 恢复进入前的形态与绑定，草稿原样保留', async () => {
    render(<Harness />);

    act(() => {
      selectOnCanvas([AGENT_NODE_ID]);
      enterAgentFormFromSelection(AGENT_NODE_ID);
    });
    expect(usePromptDockStore.getState().form).toBe('agent');

    act(() => {
      selectOnCanvas([]);
    });

    await waitFor(() => {
      expect(usePromptDockStore.getState().form).toBe('generate');
    });
    const state = usePromptDockStore.getState();
    expect(state.agentBinding).toBeNull();
    expect(state.agentEntrySnapshot).toBeNull();
    expect(state.draft.prompt).toBe('还没发出去的生成式草稿');
  });

  it('会话已不存在的节点不触发进入（跳过），形态与绑定都不变', () => {
    useAgentSessionStore.setState({
      sessionsById: { [BOUND_SESSION_ID]: sessionRecord() },
      sessionIdByNodeId: {},
    });
    useCanvasStore.setState({
      nodeGraph: graphWith([agentNode(AGENT_NODE_ID, 'sess_gone')]),
    });

    act(() => {
      selectOnCanvas([AGENT_NODE_ID]);
      const entered = enterAgentFormFromSelection(AGENT_NODE_ID);
      expect(entered).toBe(false);
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('generate');
    expect(state.agentBinding).toBeNull();
    expect(state.agentEntrySnapshot).toBeNull();
    // 会话缺失的节点不进入、也不打开会话视图
    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();
  });
});

describe('容器作用域选择（点 Agent 容器里的素材 = 点这个 agent）', () => {
  // @spec: AG-CT-012
  it('普通单击容器成员 → 视为选中该 agent：进入其形态、绑定容器会话、打开会话视图；选中集仍是该成员', () => {
    useCanvasStore.setState({
      nodeGraph: graphWith([
        agentNode(AGENT_NODE_ID, BOUND_SESSION_ID),
        memberNode(MEMBER_ID, AGENT_NODE_ID),
      ]),
    });

    act(() => {
      selectOnCanvas([MEMBER_ID]);
      enterAgentFormFromSelection(MEMBER_ID);
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('agent');
    // 绑定与待还原快照的锚点恒为容器节点，不是被点的成员
    expect(state.agentBinding).toEqual({
      nodeId: AGENT_NODE_ID,
      agentSessionId: BOUND_SESSION_ID,
    });
    expect(state.agentEntrySnapshot).toEqual({
      nodeId: AGENT_NODE_ID,
      agentSessionId: BOUND_SESSION_ID,
      form: 'generate',
      binding: null,
    });
    // 选中集不被改写：成员仍是成员（素材类动作照常可用）
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([MEMBER_ID]);
    expect(useRightWorkspaceStore.getState().activeKind).toBe('agentSession');
    expect(useRightWorkspaceStore.getState().agentSessionId).toBe(BOUND_SESSION_ID);
  });

  // @spec: AG-CT-012
  it('进入后单击同一容器成员 → 不还原，形态、绑定与快照都不变', () => {
    useCanvasStore.setState({
      nodeGraph: graphWith([
        agentNode(AGENT_NODE_ID, BOUND_SESSION_ID),
        memberNode(MEMBER_ID, AGENT_NODE_ID),
      ]),
    });
    render(<Harness />);

    act(() => {
      selectOnCanvas([AGENT_NODE_ID]);
      enterAgentFormFromSelection(AGENT_NODE_ID);
    });
    const snapshotBefore = usePromptDockStore.getState().agentEntrySnapshot;
    expect(snapshotBefore).not.toBeNull();

    act(() => {
      selectOnCanvas([MEMBER_ID]);
      enterAgentFormFromSelection(MEMBER_ID);
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('agent');
    expect(state.agentBinding).toEqual({
      nodeId: AGENT_NODE_ID,
      agentSessionId: BOUND_SESSION_ID,
    });
    // 快照未被重记（锚点仍是容器、形态仍是进入前的生成式）
    expect(state.agentEntrySnapshot).toEqual(snapshotBefore);
  });

  // @spec: AG-CT-012
  it('进入后多选同容器成员（Shift 追加）→ 不还原：作用域内多选保持 agent 形态与绑定', () => {
    useCanvasStore.setState({
      nodeGraph: graphWith([
        agentNode(AGENT_NODE_ID, BOUND_SESSION_ID),
        memberNode(MEMBER_ID, AGENT_NODE_ID),
        memberNode(MEMBER_ID_2, AGENT_NODE_ID),
      ]),
    });
    render(<Harness />);

    act(() => {
      selectOnCanvas([MEMBER_ID]);
      enterAgentFormFromSelection(MEMBER_ID);
    });

    act(() => {
      selectOnCanvas([MEMBER_ID, MEMBER_ID_2]);
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('agent');
    expect(state.agentBinding).toEqual({
      nodeId: AGENT_NODE_ID,
      agentSessionId: BOUND_SESSION_ID,
    });
    expect(state.agentEntrySnapshot).not.toBeNull();
  });

  // @spec: AG-CT-012
  it('选中作用域外的节点 → 还原进入前的形态与绑定，草稿与参考保留', () => {
    useCanvasStore.setState({
      nodeGraph: graphWith([
        agentNode(AGENT_NODE_ID, BOUND_SESSION_ID),
        memberNode(MEMBER_ID, AGENT_NODE_ID),
        memberNode(FREE_NODE_ID, GROUP_NODE_ID),
        groupNode(GROUP_NODE_ID),
      ]),
    });
    render(<Harness />);

    act(() => {
      selectOnCanvas([MEMBER_ID]);
      enterAgentFormFromSelection(MEMBER_ID);
    });
    expect(usePromptDockStore.getState().form).toBe('agent');

    act(() => {
      selectOnCanvas([FREE_NODE_ID]);
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('generate');
    expect(state.agentBinding).toBeNull();
    expect(state.agentEntrySnapshot).toBeNull();
    expect(state.draft.prompt).toBe('还没发出去的生成式草稿');
  });

  // @spec: AG-CT-012
  it('普通组的成员与自由节点都不进入（组不是 Agent 容器）', () => {
    useCanvasStore.setState({
      nodeGraph: graphWith([
        agentNode(AGENT_NODE_ID, BOUND_SESSION_ID),
        groupNode(GROUP_NODE_ID),
        memberNode(FREE_NODE_ID, GROUP_NODE_ID),
      ]),
    });

    act(() => {
      selectOnCanvas([FREE_NODE_ID]);
      expect(enterAgentFormFromSelection(FREE_NODE_ID)).toBe(false);
      selectOnCanvas([GROUP_NODE_ID]);
      expect(enterAgentFormFromSelection(GROUP_NODE_ID)).toBe(false);
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('generate');
    expect(state.agentBinding).toBeNull();
    expect(state.agentEntrySnapshot).toBeNull();
    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();
  });

  // @spec: AG-CT-012
  it('成员所属容器无会话引用 → 不进入、不打开会话视图', () => {
    useAgentSessionStore.setState({ sessionsById: {}, sessionIdByNodeId: {} });
    useCanvasStore.setState({
      nodeGraph: graphWith([
        agentNode(AGENT_NODE_ID, BOUND_SESSION_ID),
        memberNode(MEMBER_ID, AGENT_NODE_ID),
      ]),
    });

    act(() => {
      selectOnCanvas([MEMBER_ID]);
      expect(enterAgentFormFromSelection(MEMBER_ID)).toBe(false);
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('generate');
    expect(state.agentBinding).toBeNull();
    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();
  });
});

describe('粘滞（当前会话）', () => {
  it('向该会话发出的消息被受理后 → 选择集离开该节点不再还原', async () => {
    const { submitAgentPrompt } = await import('@/features/agent/agentSessionStore');
    vi.mocked(submitAgentPrompt).mockResolvedValue({
      agentSessionId: BOUND_SESSION_ID,
      nodeId: AGENT_NODE_ID,
    });
    render(<Harness />);

    act(() => {
      selectOnCanvas([AGENT_NODE_ID]);
      enterAgentFormFromSelection(AGENT_NODE_ID);
    });
    act(() => {
      usePromptDockStore.getState().setDraft({ prompt: '接着聊' });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('promptdock-submit'));
    });
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    expect(submitAgentPrompt).toHaveBeenCalledTimes(1);
    expect(usePromptDockStore.getState().agentEntrySnapshot).toBeNull();

    act(() => {
      selectOnCanvas([]);
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('agent');
    expect(state.agentBinding).toEqual({
      nodeId: AGENT_NODE_ID,
      agentSessionId: BOUND_SESSION_ID,
    });
  });

  it('显式动作（「新会话」解绑）清掉待还原快照，此后选择变化不再还原', () => {
    render(<Harness />);

    act(() => {
      selectOnCanvas([AGENT_NODE_ID]);
      enterAgentFormFromSelection(AGENT_NODE_ID);
    });
    act(() => {
      usePromptDockStore.getState().unbindAgentSession();
    });
    expect(usePromptDockStore.getState().agentEntrySnapshot).toBeNull();

    act(() => {
      selectOnCanvas([]);
    });

    // 解绑只解绑、不改形态：没有被还原回生成式形态，说明快照确实已清
    expect(usePromptDockStore.getState().form).toBe('agent');
    expect(usePromptDockStore.getState().agentBinding).toBeNull();
  });

  it('显式动作（「使用 agent」换到另一节点）清掉待还原快照', async () => {
    const { enterAgentFormForNode } = await import('../promptDockStore');
    const secondNodeId = 'agent-node-2';
    const secondSessionId = 'sess_2';
    useAgentSessionStore.setState({
      sessionsById: {
        [BOUND_SESSION_ID]: sessionRecord(),
        [secondSessionId]: sessionRecord({
          agentSessionId: secondSessionId,
          nodeId: secondNodeId,
          title: '第二个会话',
        }),
      },
      sessionIdByNodeId: {
        [AGENT_NODE_ID]: BOUND_SESSION_ID,
        [secondNodeId]: secondSessionId,
      },
    });
    useCanvasStore.setState({
      nodeGraph: graphWith([
        agentNode(AGENT_NODE_ID, BOUND_SESSION_ID),
        agentNode(secondNodeId, secondSessionId),
      ]),
    });
    render(<Harness />);

    act(() => {
      selectOnCanvas([AGENT_NODE_ID]);
      enterAgentFormFromSelection(AGENT_NODE_ID);
    });
    act(() => {
      enterAgentFormForNode(secondNodeId, secondSessionId);
    });

    expect(usePromptDockStore.getState().agentEntrySnapshot).toBeNull();

    act(() => {
      selectOnCanvas([]);
    });

    expect(usePromptDockStore.getState().agentBinding).toEqual({
      nodeId: secondNodeId,
      agentSessionId: secondSessionId,
    });
  });
});
