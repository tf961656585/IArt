import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AgentSessionRecord, ChatModelDirectoryEntry } from '@iart/contracts';
import {
  updateAgentSessionConfig,
  useAgentSessionStore,
} from '@/features/agent/agentSessionStore';
import type * as AgentSessionStoreModule from '@/features/agent/agentSessionStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { enterAgentFormForNode, usePromptDockStore } from '../promptDockStore';
import { PromptDock } from '../PromptDock';

/**
 * 「使用 agent」的会话绑定态（spec docs/agent/02「选中态工具栏」、docs/agent/06「agent 形态的输入面」、
 * docs/agent/03「会话归属」）。
 *
 * 保护：未提交输入非空时先问去向再切换（不得静默丢失）；绑定态输入面显示会话摘要 +「新会话」；
 * 「新会话」只解绑、不改形态、不清草稿；切到生成形态不解除绑定；
 * 绑定会话的模型只读、思考与审批改动落库到该会话。
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
  getRuntimeProjectPath: () => '/tmp/iart-promptdock-agent-binding-test',
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

// Radix Select 的指针事件在 jsdom 下缺 pointer capture 实现：补最小桩，让选择项可点。
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

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
  agentSessionId: 'sess_1',
  nodeId: 'node_1',
  modelId: 'my-llm',
  thinkingTier: 'high',
  approvalMode: 'confirm',
  title: '画一只在雨中弹吉他的柴犬',
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_600_000,
  messageCount: 2,
  lastMessageAt: 1_770_000_600_000,
  ...overrides,
});

/** 生成式形态 + 可能非空的未提交输入。 */
const seedDraft = (prompt: string) => {
  usePromptDockStore.setState({
    form: 'generate',
    draft: {
      modelId: 'gpt-image-2',
      modelVersion: '1.0.0',
      prompt,
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
    agentEntrySnapshot: null,
    submitting: false,
    preflightIssues: null,
  });
};

const seedBoundSession = (overrides: Partial<AgentSessionRecord> = {}) => {
  const record = sessionRecord(overrides);
  useAgentSessionStore.setState({
    sessionsById: { [record.agentSessionId]: record },
    sessionIdByNodeId: { [record.nodeId]: record.agentSessionId },
  });
  usePromptDockStore.setState({
    form: 'agent',
    agentBinding: { nodeId: record.nodeId, agentSessionId: record.agentSessionId },
    agentEntrySnapshot: null,
  });
};

beforeEach(() => {
  cleanup();
  vi.mocked(updateAgentSessionConfig).mockReset();
  useAgentSessionStore.setState({ sessionsById: {}, sessionIdByNodeId: {} });
});

describe('enterAgentFormForNode（Agent 节点工具栏「使用 agent」）', () => {
  it('直接进入该会话：切到 agent 形态并绑定，不弹草稿去向确认', () => {
    seedDraft('还没发出去的一段话');

    expect(enterAgentFormForNode('node_1', 'sess_1')).toBe(true);

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('agent');
    expect(state.agentBinding).toEqual({ nodeId: 'node_1', agentSessionId: 'sess_1' });
    // 草稿按形态独立保存：进入 agent 形态不覆盖生成式草稿，也没有待决确认框
    expect(state.draft.prompt).toBe('还没发出去的一段话');
  });

  it('显式动作清掉待还原快照（此后选择变化不再还原）', () => {
    seedDraft('草稿');
    usePromptDockStore.setState({
      agentEntrySnapshot: {
        nodeId: 'node_1',
        agentSessionId: 'sess_1',
        form: 'generate',
        binding: null,
      },
    });

    enterAgentFormForNode('node_1', 'sess_1');

    expect(usePromptDockStore.getState().agentEntrySnapshot).toBeNull();
  });

  it('已经在该会话的 agent 形态下：幂等（形态、绑定、草稿原样）', () => {
    seedDraft('还没发出去的一段话');
    seedBoundSession();

    expect(enterAgentFormForNode('node_1', 'sess_1')).toBe(true);
    const state = usePromptDockStore.getState();
    expect(state.form).toBe('agent');
    expect(state.agentBinding).toEqual({ nodeId: 'node_1', agentSessionId: 'sess_1' });
    expect(state.draft.prompt).toBe('还没发出去的一段话');
  });

  it('会话或节点标识不全：返回未切换', () => {
    seedDraft('');

    expect(enterAgentFormForNode('', 'sess_1')).toBe(false);
    expect(enterAgentFormForNode('node_1', '')).toBe(false);
    expect(usePromptDockStore.getState().form).toBe('generate');
  });
});

describe('绑定态输入面', () => {
  it('摘要行显示「<节点名> · <会话摘要>」与「新会话」；「新会话」只解绑——不改形态、不清草稿', () => {
    seedDraft('草稿里的旧文字');
    seedBoundSession();
    render(<PromptDock />);

    // 节点名取画布事实源；本用例未挂画布图 → 回落到节点默认名
    expect(screen.getByTestId('promptdock-agent-session-summary')).toHaveTextContent(
      'Agent · 画一只在雨中弹吉他的柴犬',
    );

    const newSession = screen.getByTestId('promptdock-agent-new-session');
    expect(newSession).toHaveTextContent('新会话');
    // 界面不挂解释文字（docs/ui-copy-standard.md「界面默认不印解释文字」）
    expect(newSession).not.toHaveAttribute('title');

    fireEvent.click(newSession);

    const state = usePromptDockStore.getState();
    expect(state.agentBinding).toBeNull();
    expect(state.form).toBe('agent');
    expect(state.draft.prompt).toBe('草稿里的旧文字');
  });

  it('摘要行取画布节点名与会话标题（「<节点名> · <会话摘要>」）', () => {
    seedDraft('');
    seedBoundSession();
    useCanvasStore.setState({
      nodeGraph: {
        id: 'g1',
        name: 'test',
        description: undefined,
        status: 'draft',
        nodes: [
          {
            id: 'node_1',
            type: 'agent',
            position: { x: 0, y: 0 },
            data: { label: '雨中的柴犬', agentSessionId: 'sess_1' },
            draggable: true,
            size: undefined,
            style: undefined,
            groupId: undefined,
          },
        ],
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
      },
    });
    render(<PromptDock />);

    expect(screen.getByTestId('promptdock-agent-session-summary')).toHaveTextContent(
      '雨中的柴犬 · 画一只在雨中弹吉他的柴犬',
    );
  });

  it('切到生成形态不解除会话绑定（绑定只经「新会话」解除）', () => {
    seedDraft('');
    seedBoundSession();
    render(<PromptDock />);

    fireEvent.click(screen.getByRole('radio', { name: '生成' }));

    expect(usePromptDockStore.getState().form).toBe('generate');
    expect(usePromptDockStore.getState().agentBinding).toEqual({
      nodeId: 'node_1',
      agentSessionId: 'sess_1',
    });
  });

  it('会话数据缺失时如实说明，不显示空标题', () => {
    seedDraft('');
    usePromptDockStore.setState({
      form: 'agent',
      agentBinding: { nodeId: 'node_gone', agentSessionId: 'sess_gone' },
    });
    render(<PromptDock />);

    expect(screen.getByTestId('promptdock-agent-session-summary')).toHaveTextContent(
      '这个会话已经不在了',
    );
  });
});

describe('绑定会话下的服务行', () => {
  it('模型只读：呈现会话的 model_id，不提供更换入口', () => {
    seedDraft('');
    seedBoundSession();
    render(<PromptDock />);

    expect(screen.getByTestId('promptdock-agent-model-readonly')).toHaveTextContent('my-llm');
    expect(screen.queryByTestId('promptdock-agent-model')).not.toBeInTheDocument();
  });

  it('思考改动落到会话（不写入形态自身的选择）', async () => {
    seedDraft('');
    seedBoundSession();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<PromptDock />);

    await user.click(screen.getByTestId('promptdock-agent-thinking'));
    await user.click(await screen.findByRole('option', { name: 'low' }));

    expect(updateAgentSessionConfig).toHaveBeenCalledWith('sess_1', { thinkingTier: 'low' });
    expect(usePromptDockStore.getState().agentSelection.thinkingTier).toBe('high');
  });

  it('审批改动落到会话', async () => {
    seedDraft('');
    seedBoundSession({ approvalMode: 'yolo' });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<PromptDock />);

    await user.click(screen.getByTestId('promptdock-agent-approval'));
    await user.click(await screen.findByRole('option', { name: '逐条确认' }));

    expect(updateAgentSessionConfig).toHaveBeenCalledWith('sess_1', { approvalMode: 'confirm' });
  });
});
