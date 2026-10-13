import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { toast } from 'sonner';

import type { ExecutableModelDirectoryEntry } from '@iart/contracts';
import type { PromptDockBatchSubmitResponse } from '@iart/contracts';
import { submitGenerationBatch } from '@/client/api/promptDockApi';
import { usePromptDockStore } from '../promptDockStore';
import { PromptDock } from '../PromptDock';

/**
 * 提交受理后草稿保留回归（spec PromptDock生成主链.md PD-AC-012，2026-09-08 口径）：
 * 一次提交被受理后，PromptDock 草稿各字段与受理前逐项一致；用户在同一草稿上微调后
 * 再次提交，携带的是最新草稿，无需重新输入。
 *
 * 旧口径（提交接受即 resetDraft 清空）由本文件封口：任何重新引入提交后清空/重置的实现
 * 都会使这里的首个用例失败。
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
  getRuntimeProjectPath: () => '/tmp/iart-promptdock-submit-test',
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

const entry = (modelId: string): ExecutableModelDirectoryEntry => ({
  model_id: modelId,
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
    created_at: '2026-09-08T00:00:00.000Z',
  },
  tasks: [{ task_id: 'task_1', task_index: 0 }],
});

const seedDraft = (prompt: string) => {
  usePromptDockStore.setState({
    draft: {
      modelId: 'gpt-image-2',
      modelVersion: '1.0.0',
      prompt,
      arguments: { size: 'auto' },
      references: [],
      promptPresetSnapshots: undefined,
      taskCount: 2,
    },
    catalog: [entry('gpt-image-2')],
    catalogLoaded: true,
    submitting: false,
    preflightIssues: null,
  });
};

const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('promptdock-submit'));
  });
  await waitFor(() => {
    expect(usePromptDockStore.getState().submitting).toBe(false);
  });
};

beforeEach(() => {
  cleanup();
  vi.mocked(submitGenerationBatch).mockReset();
});

describe('PromptDock 提交受理后草稿保留（PD-AC-012）', () => {
  it('提交受理后草稿逐字段保留：prompt/模型/参数/任务数不因提交而清空', async () => {
    seedDraft('一只在雨中弹吉他的柴犬');
    vi.mocked(submitGenerationBatch).mockResolvedValue(
      acceptanceResponse('一只在雨中弹吉他的柴犬'),
    );

    render(<PromptDock />);
    await submit();

    expect(submitGenerationBatch).toHaveBeenCalledTimes(1);
    const draft = usePromptDockStore.getState().draft;
    expect(draft.prompt).toBe('一只在雨中弹吉他的柴犬');
    expect(draft.modelId).toBe('gpt-image-2');
    expect(draft.modelVersion).toBe('1.0.0');
    expect(draft.arguments).toEqual({ size: 'auto' });
    expect(draft.taskCount).toBe(2);
    expect(screen.getByTestId('promptdock-prompt-editor').textContent).toBe(
      '一只在雨中弹吉他的柴犬',
    );
  });

  it('微调续作：受理后的第二次提交携带用户最新草稿，而非空字段', async () => {
    seedDraft('初稿提示词');
    vi.mocked(submitGenerationBatch)
      .mockResolvedValueOnce(acceptanceResponse('初稿提示词'))
      .mockResolvedValueOnce(acceptanceResponse('二稿提示词'));

    render(<PromptDock />);
    await submit();

    await act(async () => {
      usePromptDockStore.getState().setDraft({ prompt: '二稿提示词', taskCount: 1 });
    });
    await submit();

    expect(submitGenerationBatch).toHaveBeenCalledTimes(2);
    const secondRequest = vi.mocked(submitGenerationBatch).mock.calls[1]?.[0];
    expect(secondRequest?.prompt).toBe('二稿提示词');
    expect(secondRequest?.task_count).toBe(1);
    expect(usePromptDockStore.getState().draft.prompt).toBe('二稿提示词');
  });

  it('提交失败（网络异常）不清空草稿，出口文案不印异常原文', async () => {
    seedDraft('会被拒绝的提示词');
    vi.mocked(submitGenerationBatch).mockRejectedValue(
      new Error('ZodError: [{"code":"invalid_type","path":["model_id"],"message":"Required"}]'),
    );

    render(<PromptDock />);
    await submit();

    expect(usePromptDockStore.getState().draft.prompt).toBe('会被拒绝的提示词');
    // 生成式的失败出口固定（ZodError / 动态 import 失败一类异常原文只进日志）
    expect(toast.error).toHaveBeenCalledWith('生成没能开始，请重试。');
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('ZodError'));
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('invalid_type'));
  });
});
