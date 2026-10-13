import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { toast } from 'sonner';

import type { AgentSessionRecord, ChatModelDirectoryEntry } from '@iart/contracts';
import { AgentSubmitFailure } from '@/features/agent/agentErrorText';
import {
  submitAgentPrompt,
  useAgentSessionStore,
} from '@/features/agent/agentSessionStore';
import type * as AgentSessionStoreModule from '@/features/agent/agentSessionStore';
import {
  createMediaAssetFixture,
  createMediaAssetMapFixture,
} from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { useRightWorkspaceStore } from '@/features/rightworkspace/rightWorkspaceStore';
import { usePromptDockStore } from '../promptDockStore';
import { PromptDock } from '../PromptDock';

/**
 * agent 形态提交接通（spec docs/agent/06「agent 形态的输入面」、
 * spec docs/architecture/PromptDock生成主链.md PD-AC-013）。
 *
 * 保护：提交构造 AgentSubmitInput（未绑定 = 自造会话标识 + nodeId null）；
 * 受理成功即消费——prompt 与参考引用清空、输入焦点保留在编辑器、自动打开该会话的会话视图，
 * 并把受理产出的会话写回绑定（续发追加到同一 Agent 节点；「新会话」解绑后下一次提交
 * 才重新自造标识），不再弹成功 toast（会话视图本身就是反馈）；失败按错误码给出口文案
 * （不印后端原文）、草稿与参考逐项保留、不设绑定、不静默失败；
 * 提交中拦截重复提交；绑定会话但会话数据缺失时阻断并给出出口；
 * 续作会话时配置取会话（模型不因形态选择被换掉），受理成功同样按消费语义清空。
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
  getRuntimeProjectPath: () => '/tmp/iart-promptdock-agent-submit-test',
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

const chatEntry = (modelId: string): ChatModelDirectoryEntry => ({
  model_id: modelId,
  model_version: '1.0.0',
  default_task_type: 'text',
  capability: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
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
  messageCount: 1,
  lastMessageAt: 1_770_000_600_000,
  ...overrides,
});

const seedAgentForm = (params: { prompt: string; modelId: string }) => {
  usePromptDockStore.setState({
    form: 'agent',
    draft: {
      modelId: null,
      modelVersion: null,
      prompt: params.prompt,
      arguments: {},
      references: [
        { refId: 'ref_1', assetId: 'asset_1', mediaType: 'image', label: '角色图' },
      ],
      promptPresetSnapshots: undefined,
      taskCount: 1,
    },
    catalog: [],
    catalogLoaded: true,
    chatCatalog: [chatEntry('my-llm'), chatEntry('my-llm-2')],
    chatCatalogLoaded: true,
    agentSelection: { modelId: params.modelId, thinkingTier: 'low', approval: 'confirm' },
    submitting: false,
    preflightIssues: null,
  });
};

const clickSubmit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('promptdock-submit'));
  });
};

beforeEach(() => {
  cleanup();
  vi.mocked(submitAgentPrompt).mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  usePromptDockStore.setState({
    form: 'generate',
    agentBinding: null,
    agentEntrySnapshot: null,
    submitting: false,
    preflightIssues: null,
  });
  useAgentSessionStore.setState({ sessionsById: {}, sessionIdByNodeId: {} });
  useRightWorkspaceStore.setState({ activeKind: null, agentSessionId: null });
  // 参考区引用必须是画布上仍存在的媒体资产（否则前置校验按「素材已被移除」阻断）
  useCanvasStore.setState({
    mediaAssets: createMediaAssetMapFixture([createMediaAssetFixture({ id: 'asset_1' })]),
  });
});

describe('PromptDock agent 提交接通', () => {
  it('首次提交：构造 AgentSubmitInput（自造会话标识、nodeId 为 null）并自动打开会话视图', async () => {
    seedAgentForm({ prompt: '画一只在雨中弹吉他的柴犬', modelId: 'my-llm' });
    // 预置一条预设快照：受理成功后应随消费一并清除
    usePromptDockStore.getState().setDraft({ promptPresetSnapshots: {} });
    vi.mocked(submitAgentPrompt).mockResolvedValue({
      agentSessionId: 'sess_created',
      nodeId: 'node_created',
    });

    render(<PromptDock />);
    await clickSubmit();
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    expect(submitAgentPrompt).toHaveBeenCalledTimes(1);
    const input = vi.mocked(submitAgentPrompt).mock.calls[0]?.[0];
    expect(input?.agentSessionId).toBeTruthy();
    expect(input?.requestId).toBeTruthy();
    expect(input?.nodeId).toBeNull();
    expect(input?.modelId).toBe('my-llm');
    expect(input?.thinkingTier).toBe('low');
    expect(input?.approvalMode).toBe('confirm');
    expect(input?.content).toBe('画一只在雨中弹吉他的柴犬');
    expect(input?.referenceAssetIds).toEqual(['asset_1']);

    // 首次提交后自动打开该会话的会话视图（spec 06「首次提交」）
    expect(useRightWorkspaceStore.getState().activeKind).toBe('agentSession');
    expect(useRightWorkspaceStore.getState().agentSessionId).toBe('sess_created');

    // 受理产出的会话写回绑定（续发追加到同一 Agent 节点，不再自造新会话标识）
    expect(usePromptDockStore.getState().agentBinding).toEqual({
      nodeId: 'node_created',
      agentSessionId: 'sess_created',
    });

    // 受理成功即消费（PD-AC-013）：prompt 与参考引用清空、预设快照一并清除；
    // 会话视图自动打开已是反馈，退役「消息已发送」成功 toast
    expect(usePromptDockStore.getState().draft.prompt).toBe('');
    expect(usePromptDockStore.getState().draft.references).toHaveLength(0);
    expect(usePromptDockStore.getState().draft.promptPresetSnapshots).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();

    // 输入焦点保留在编辑器：清空后可直接输入下一条消息
    await waitFor(() => {
      expect(screen.getByTestId('promptdock-prompt-editor')).toHaveFocus();
    });
  });

  it('续作会话：用绑定的会话与节点，配置取会话记录（模型不被形态选择覆盖）', async () => {
    seedAgentForm({ prompt: '再画一张', modelId: 'my-llm-2' });
    useAgentSessionStore.setState({ sessionsById: { sess_1: sessionRecord() } });
    usePromptDockStore.setState({
      agentBinding: { nodeId: 'node_1', agentSessionId: 'sess_1' },
    });
    vi.mocked(submitAgentPrompt).mockResolvedValue({
      agentSessionId: 'sess_1',
      nodeId: 'node_1',
    });

    render(<PromptDock />);
    await clickSubmit();
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    const input = vi.mocked(submitAgentPrompt).mock.calls[0]?.[0];
    expect(input?.agentSessionId).toBe('sess_1');
    expect(input?.nodeId).toBe('node_1');
    expect(input?.modelId).toBe('my-llm');
    expect(input?.thinkingTier).toBe('high');
    // 续作不自动打开会话视图：自动聚焦只发生在首次提交创建节点时
    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();

    // 已绑定的续作不重设绑定（binding 原样）
    expect(usePromptDockStore.getState().agentBinding).toEqual({
      nodeId: 'node_1',
      agentSessionId: 'sess_1',
    });

    // 续作消息按同一对话语义消费（PD-AC-013）：受理成功即清空 prompt 与参考
    expect(usePromptDockStore.getState().draft.prompt).toBe('');
    expect(usePromptDockStore.getState().draft.references).toHaveLength(0);
  });

  it('首次受理成功写回绑定后，续发携带同一会话与节点（不再自造新会话标识）', async () => {
    seedAgentForm({ prompt: '第一句', modelId: 'my-llm' });
    vi.mocked(submitAgentPrompt)
      .mockResolvedValueOnce({ agentSessionId: 'sess_created', nodeId: 'node_created' })
      .mockResolvedValueOnce({ agentSessionId: 'sess_created', nodeId: 'node_created' });

    render(<PromptDock />);
    await clickSubmit();
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    // 首次提交后绑定来自受理响应，而非任何手动设置
    expect(usePromptDockStore.getState().agentBinding).toEqual({
      nodeId: 'node_created',
      agentSessionId: 'sess_created',
    });

    // 真实时序里会话记录在受理事件中先于 promise resolve 入 store；单测里模拟同态
    useAgentSessionStore.setState({
      sessionsById: {
        sess_created: sessionRecord({
          agentSessionId: 'sess_created',
          nodeId: 'node_created',
          title: '第一句',
        }),
      },
    });

    // 不手动 setState 绑定，直接续发。setDraft 须在 act 内完成：按钮的可点态由
    // 「输入非空」驱动，act 外改 store 会让 fireEvent 命中尚未重渲染的 disabled DOM。
    await act(async () => {
      usePromptDockStore.getState().setDraft({ prompt: '第二句' });
    });
    await clickSubmit();
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    const secondInput = vi.mocked(submitAgentPrompt).mock.calls[1]?.[0];
    expect(secondInput?.agentSessionId).toBe('sess_created');
    expect(secondInput?.nodeId).toBe('node_created');
    // 续发不产生新绑定（已绑定时原样）
    expect(usePromptDockStore.getState().agentBinding).toEqual({
      nodeId: 'node_created',
      agentSessionId: 'sess_created',
    });
  });

  it('「新会话」解绑后下一次提交重新自造会话标识、nodeId 为 null', async () => {
    seedAgentForm({ prompt: '第一句', modelId: 'my-llm' });
    useAgentSessionStore.setState({ sessionsById: { sess_1: sessionRecord() } });
    usePromptDockStore.setState({
      agentBinding: { nodeId: 'node_1', agentSessionId: 'sess_1' },
    });
    vi.mocked(submitAgentPrompt).mockResolvedValue({
      agentSessionId: 'sess_created',
      nodeId: 'node_created',
    });

    render(<PromptDock />);
    await clickSubmit();
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });
    // 已绑定的续作：绑定原样保留
    expect(usePromptDockStore.getState().agentBinding).toEqual({
      nodeId: 'node_1',
      agentSessionId: 'sess_1',
    });

    // 「新会话」解绑（草稿已在受理成功时被消费，重新输入后再发）。
    // setDraft 在 act 内完成：按钮可点态由「输入非空」驱动，act 外改 store 会让
    // fireEvent 命中尚未重渲染的 disabled DOM（onClick 被 React 对 disabled 的
    // click 过滤吞掉，表现为提交静默未发生）。
    await act(async () => {
      fireEvent.click(screen.getByTestId('promptdock-agent-new-session'));
    });
    expect(usePromptDockStore.getState().agentBinding).toBeNull();

    await act(async () => {
      usePromptDockStore.getState().setDraft({ prompt: '重新开始的第二句' });
    });
    await clickSubmit();
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    // 解绑后的下一次提交重新自造会话标识、nodeId 为 null，受理成功后绑定新会话
    const secondInput = vi.mocked(submitAgentPrompt).mock.calls[1]?.[0];
    expect(secondInput?.nodeId).toBeNull();
    expect(secondInput?.agentSessionId).toBeTruthy();
    expect(secondInput?.agentSessionId).not.toBe('sess_1');
    expect(usePromptDockStore.getState().agentBinding).toEqual({
      nodeId: 'node_created',
      agentSessionId: 'sess_created',
    });
  });

  it('提交失败（受理前）：按错误码给出口文案、草稿与参考逐项保留、不自动重试、不打开会话视图', async () => {
    seedAgentForm({ prompt: '画一只在雨中弹吉他的柴犬', modelId: 'my-llm' });
    // 失败只带错误码（受理前失败一律经 AgentSubmitFailure 收口），后端原文不上面
    vi.mocked(submitAgentPrompt).mockRejectedValue(
      new AgentSubmitFailure('connection_unavailable', 'req_failed', '连不上，这一次回复没有完成，请重试。'),
    );

    render(<PromptDock />);
    await clickSubmit();
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    expect(submitAgentPrompt).toHaveBeenCalledTimes(1);
    // 文案来自错误码映射；toast 带轮次标识（与右侧工作区的同一次失败提示去重）
    const failedRequestId = vi.mocked(submitAgentPrompt).mock.calls[0]?.[0]?.requestId;
    expect(failedRequestId).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith('连不上，这一次回复没有完成，请重试。', {
      id: failedRequestId,
    });
    const draft = usePromptDockStore.getState().draft;
    // 受理失败不构成消费（PD-AC-013）：prompt 与参考逐项保留
    expect(draft.prompt).toBe('画一只在雨中弹吉他的柴犬');
    expect(draft.references).toHaveLength(1);
    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();
    // 受理失败不设绑定：下一次提交仍按未绑定构造（自造会话标识 + nodeId null）
    expect(usePromptDockStore.getState().agentBinding).toBeNull();
  });

  it('提交失败的异常没有错误码：回落通用出口文案，不印异常原文', async () => {
    seedAgentForm({ prompt: '画一只在雨中弹吉他的柴犬', modelId: 'my-llm' });
    vi.mocked(submitAgentPrompt).mockRejectedValue(
      new Error('Agent request cancelled by backend guard'),
    );

    render(<PromptDock />);
    await clickSubmit();
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    const failedRequestId = vi.mocked(submitAgentPrompt).mock.calls[0]?.[0]?.requestId;
    expect(toast.error).toHaveBeenCalledWith('这条消息没能发出，请重试。', {
      id: failedRequestId,
    });
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining('backend guard'),
      expect.anything(),
    );
  });

  it('提交中拦截重复提交：连点两次只发一次', async () => {
    seedAgentForm({ prompt: '画一只在雨中弹吉他的柴犬', modelId: 'my-llm' });
    let settle: ((result: { agentSessionId: string; nodeId: string }) => void) | null = null;
    vi.mocked(submitAgentPrompt).mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );

    render(<PromptDock />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('promptdock-submit'));
      fireEvent.click(screen.getByTestId('promptdock-submit'));
    });

    expect(submitAgentPrompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle?.({ agentSessionId: 'sess_created', nodeId: 'node_created' });
    });
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });
  });

  it('绑定会话但会话数据缺失：阻断提交并给出出口，不静默发到别的节点', async () => {
    seedAgentForm({ prompt: '再画一张', modelId: 'my-llm' });
    usePromptDockStore.setState({
      agentBinding: { nodeId: 'node_gone', agentSessionId: 'sess_gone' },
    });

    render(<PromptDock />);
    await clickSubmit();

    expect(submitAgentPrompt).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('这个会话已经不在了，点「新会话」后可以重新开始。');
    // 提交被阻断同样不构成消费（PD-AC-013）：prompt 与参考逐项保留
    expect(usePromptDockStore.getState().draft.prompt).toBe('再画一张');
    expect(usePromptDockStore.getState().draft.references).toHaveLength(1);
    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();
  });
});
