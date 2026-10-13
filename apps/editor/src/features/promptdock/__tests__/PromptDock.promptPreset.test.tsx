import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ExecutableModelDirectoryEntry, PromptDockBatchSubmitResponse } from '@iart/contracts';
import { toast } from 'sonner';

import { PromptCollectionStore } from '@/features/canvas/services/promptCollectionStore';
import type { PromptCollectionItem } from '@/features/canvas/types';
import { submitGenerationBatch } from '@/client/api/promptDockApi';
import { usePromptDockStore } from '../promptDockStore';
import { PromptDock } from '../PromptDock';
import type { PromptDockDraft } from '../PromptDock.types';

/**
 * PromptDock prompt 编辑面 / 触发提示词预设（spec docs/editor/prompt内联交互.md）：
 * - / 触发候选 → 插入 `[[pp:<id>]]` token 并写入预设快照（快照随 token 生命周期）；
 * - 提交前把 token 展开为预设正文（后端不认识 token 形态）；
 * - 失效 token（快照缺失）由前置校验阻断，不发起提交。
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
  getRuntimeProjectPath: () => '/tmp/iart-promptdock-preset-test',
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

const PRESET: PromptCollectionItem = {
  id: 'p1',
  name: 'Portrait',
  content: 'portrait prompt',
  createdAt: 0,
  updatedAt: 0,
};

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
    created_at: '2026-09-08T00:00:00.000Z',
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

const submit = async (): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('promptdock-submit'));
  });
  await waitFor(() => {
    expect(usePromptDockStore.getState().submitting).toBe(false);
  });
};

const getAllSpy = vi.spyOn(PromptCollectionStore, 'getAll');

beforeEach(() => {
  if (typeof globalThis.requestAnimationFrame === 'undefined') {
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }));
  }
  cleanup();
  vi.mocked(submitGenerationBatch).mockReset();
  vi.mocked(toast.error).mockReset();
  getAllSpy.mockResolvedValue([PRESET]);
});

describe('PromptDock / 触发提示词预设', () => {
  it('输入 / 弹出预设候选，选中后草稿写入 token 与预设快照', async () => {
    const user = userEvent.setup();
    seedDraft({});
    render(<PromptDock />);

    const editor = screen.getByTestId('promptdock-prompt-editor');
    await user.click(editor);
    await user.type(editor, '/por');

    const item = await screen.findByText('/Portrait');
    await user.click(item);

    const draft = usePromptDockStore.getState().draft;
    expect(draft.prompt).toBe('[[pp:p1]] ');
    expect(draft.promptPresetSnapshots).toEqual({ p1: PRESET });
    expect(screen.getByTestId('promptdock-prompt-editor').textContent).toContain('Portrait');
  });

  it('提交时把预设 token 展开为预设正文，不把 token 形态发给后端', async () => {
    seedDraft({ prompt: '[[pp:p1]] 一只猫', promptPresetSnapshots: { p1: PRESET } });
    vi.mocked(submitGenerationBatch).mockResolvedValue(
      acceptanceResponse('portrait prompt 一只猫'),
    );

    render(<PromptDock />);
    await submit();

    expect(submitGenerationBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitGenerationBatch).mock.calls[0]?.[0]?.prompt).toBe(
      'portrait prompt 一只猫',
    );
  });

  it('预设快照缺失时提交被前置校验阻断，不发起提交', async () => {
    seedDraft({ prompt: '[[pp:gone]] 一只猫' });
    vi.mocked(submitGenerationBatch).mockResolvedValue(acceptanceResponse('unused'));

    render(<PromptDock />);
    await submit();

    expect(submitGenerationBatch).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining('已失效'),
    );
    expect(usePromptDockStore.getState().preflightIssues?.[0]?.message).toContain('已失效');
  });
});
