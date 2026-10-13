import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ChatModelDirectoryEntry, ExecutableModelDirectoryEntry, PromptDockBatchSubmitResponse } from '@iart/contracts';
import { toast } from 'sonner';

import type { PromptDockDraft } from '../PromptDock.types';
import { submitGenerationBatch } from '@/client/api/promptDockApi';
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
 * PromptDock 回车发送（聊天框惯例：Enter 提交、Shift+Enter 换行）。
 * 核心是 IME 防护：输入法组合中的回车属于 IME——用户可能想上屏拼音原文（输英文）
 * 或确认候选词，不得误判为提交。可提交性守卫全权走主按钮同一 handleSubmit。
 * agent 形态（PD-AC-013）：回车受理成功即消费——prompt 与参考清空；失败逐项保留。
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock('@/client/store/runtimeStore', () => ({
  __esModule: true,
  getRuntimeProjectPath: () => '/tmp/iart-promptdock-enter-submit-test',
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

const entry = (): ExecutableModelDirectoryEntry => ({
  model_id: 'gpt-image-2',
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: {
    fields: [],
    required_fields: [],
    default_values: { size: 'auto' },
  },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_1',
    deployable: true,
    failure_code: 'none',
  },
});

const acceptanceResponse = (prompt: string): PromptDockBatchSubmitResponse => ({
  batch_id: 'batch_1',
  intent_snapshot: {
    batch_id: 'batch_1',
    model_id: 'gpt-image-2',
    model_version: '1.0.0',
    prompt,
    params: { size: 'auto' },
    task_count: 1,
    task_ids: ['task_1'],
    created_at: '2026-09-18T00:00:00.000Z',
  },
  tasks: [{ task_id: 'task_1', task_index: 0 }],
});

const seedDraft = (patch: Partial<PromptDockDraft>): void => {
  usePromptDockStore.setState({
    draft: {
      modelId: 'gpt-image-2',
      modelVersion: '1.0.0',
      prompt: '',
      arguments: { size: 'auto' },
      references: [],
      promptPresetSnapshots: undefined,
      taskCount: 1,
      ...patch,
    },
    catalog: [entry()],
    catalogLoaded: true,
    submitting: false,
    preflightIssues: null,
  });
};

const agentChatEntry = (): ChatModelDirectoryEntry => ({
  model_id: 'my-llm',
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

/** agent 形态初始态：已有 prompt 与一条参考引用（受理成功应被消费清空）。 */
const seedAgentDraft = (prompt: string): void => {
  usePromptDockStore.setState({
    form: 'agent',
    draft: {
      modelId: null,
      modelVersion: null,
      prompt,
      arguments: {},
      references: [
        { refId: 'ref_1', assetId: 'asset_1', mediaType: 'image', label: '角色图' },
      ],
      promptPresetSnapshots: undefined,
      taskCount: 1,
    },
    catalog: [],
    catalogLoaded: true,
    chatCatalog: [agentChatEntry()],
    chatCatalogLoaded: true,
    agentSelection: { modelId: 'my-llm', thinkingTier: 'low', approval: 'confirm' },
    agentBinding: null,
    submitting: false,
    preflightIssues: null,
  });
  // 参考区引用必须是画布上仍存在的媒体资产（否则前置校验按「素材已被移除」阻断）
  useCanvasStore.setState({
    mediaAssets: createMediaAssetMapFixture([createMediaAssetFixture({ id: 'asset_1' })]),
  });
};

beforeEach(() => {
  if (typeof globalThis.requestAnimationFrame === 'undefined') {
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }));
  }
  cleanup();
  vi.mocked(submitGenerationBatch).mockReset();
  vi.mocked(submitAgentPrompt).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
  usePromptDockStore.setState({
    form: 'generate',
    agentBinding: null,
    agentEntrySnapshot: null,
    submitting: false,
    preflightIssues: null,
  });
  useAgentSessionStore.setState({ sessionsById: {}, sessionIdByNodeId: {} });
  useRightWorkspaceStore.setState({ activeKind: null, agentSessionId: null });
  useCanvasStore.setState({ mediaAssets: {} });
});

describe('PromptDock / 回车发送', () => {
  it('非组合 Enter 触发提交，且不向编辑器插换行', async () => {
    seedDraft({ prompt: '一只猫' });
    vi.mocked(submitGenerationBatch).mockResolvedValue(acceptanceResponse('一只猫'));
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await userEvent.setup().click(editor);

    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' });
    });

    expect(vi.mocked(submitGenerationBatch)).toHaveBeenCalledTimes(1);
    expect(usePromptDockStore.getState().draft.prompt).toBe('一只猫');
  });

  it('输入法组合中的回车（isComposing）不提交：用户可能是想上屏英文，随后上屏+再按回车才发送', async () => {
    seedDraft({ prompt: '一只猫' });
    vi.mocked(submitGenerationBatch).mockResolvedValue(acceptanceResponse('一只猫'));
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await userEvent.setup().click(editor);

    // 组合进行中按回车（部分环境下 key 仍报 Enter 且 isComposing=true）：交给 IME，不提交
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
    expect(vi.mocked(submitGenerationBatch)).not.toHaveBeenCalled();

    // 组合结束（拼音原文上屏）后的回车才是提交意图
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' });
    });
    expect(vi.mocked(submitGenerationBatch)).toHaveBeenCalledTimes(1);
  });

  it('IME 处理中的回车（keyCode 229 兜底）不提交', async () => {
    seedDraft({ prompt: '一只猫' });
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await userEvent.setup().click(editor);

    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });
    expect(vi.mocked(submitGenerationBatch)).not.toHaveBeenCalled();
  });

  it('Shift+Enter 不提交，且换行经共享编辑器落入草稿（换行交给共享编辑器）', async () => {
    seedDraft({ prompt: '一只猫' });
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await userEvent.setup().click(editor);

    // jsdom 不会像真实浏览器那样在点击后放置插入符：显式把光标折叠到文本末尾，
    // 等价真实场景「点击文本末尾后按 Shift+Enter」
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(vi.mocked(submitGenerationBatch)).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(usePromptDockStore.getState().draft.prompt).toBe('一只猫\n');
    });
    expect(editor).toHaveFocus();
  });

  it('空内容回车不提交', async () => {
    seedDraft({ prompt: '' });
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await userEvent.setup().click(editor);

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(vi.mocked(submitGenerationBatch)).not.toHaveBeenCalled();
  });

  it('预设候选打开时回车不提交（回车是选中候选，让给弹层）', async () => {
    seedDraft({ prompt: '一只猫' });
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await userEvent.setup().click(editor);
    // 模拟候选打开态（与共享编辑器 syncSuggestionDataset 同款 dataset 信号）
    editor.dataset.ppOpen = 'true';

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(vi.mocked(submitGenerationBatch)).not.toHaveBeenCalled();
  });

  it('提交中快速回车不重复提交（与按钮共用 submitting 守卫）', async () => {
    seedDraft({ prompt: '一只猫' });
    let releaseSubmit: ((value: PromptDockBatchSubmitResponse) => void) | undefined;
    vi.mocked(submitGenerationBatch).mockImplementation(
      () => new Promise<PromptDockBatchSubmitResponse>((resolve) => {
        releaseSubmit = resolve;
      }),
    );
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await userEvent.setup().click(editor);

    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' });
    });
    expect(usePromptDockStore.getState().submitting).toBe(true);

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(vi.mocked(submitGenerationBatch)).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseSubmit?.(acceptanceResponse('一只猫'));
    });
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });
  });
});

describe('PromptDock / agent 形态回车发送（PD-AC-013）', () => {
  it('回车受理成功即消费：prompt 与参考引用清空，输入焦点保留在编辑器', async () => {
    seedAgentDraft('帮我把这张图改成夜景');
    vi.mocked(submitAgentPrompt).mockResolvedValue({
      agentSessionId: 'sess_created',
      nodeId: 'node_created',
    });
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await userEvent.setup().click(editor);

    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' });
    });
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    expect(submitAgentPrompt).toHaveBeenCalledTimes(1);
    const state = usePromptDockStore.getState();
    expect(state.draft.prompt).toBe('');
    expect(state.draft.references).toHaveLength(0);

    // 焦点交回编辑器：直接输入下一条消息
    await waitFor(() => {
      expect(screen.getByTestId('promptdock-prompt-editor')).toHaveFocus();
    });
  });

  it('回车受理失败：草稿与参考逐项保留', async () => {
    seedAgentDraft('帮我把这张图改成夜景');
    vi.mocked(submitAgentPrompt).mockRejectedValue(new Error('connection lost'));
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await userEvent.setup().click(editor);

    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' });
    });
    await waitFor(() => {
      expect(usePromptDockStore.getState().submitting).toBe(false);
    });

    // 失败不构成消费（PD-AC-013）
    const state = usePromptDockStore.getState();
    expect(state.draft.prompt).toBe('帮我把这张图改成夜景');
    expect(state.draft.references).toHaveLength(1);
  });
});
