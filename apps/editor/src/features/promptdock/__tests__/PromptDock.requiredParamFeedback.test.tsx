import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { ExecutableModelDirectoryEntry } from '@iart/contracts';
import { toast } from 'sonner';
import { usePromptDockStore } from '../promptDockStore';
import { PromptDock } from '../PromptDock';

/**
 * 必填参数缺失的阻断反馈：标签解析得到时点名是哪个字段（不含内部 requiredKey）；
 * 标签取不到时（schema 没给 label，或 label 就是字段名）退回 preflight 的兜底句，
 * 任何情况下都不把字段名印给用户。
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
  getRuntimeProjectPath: () => '/tmp/iart-promptdock-preflight-test',
}));

vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  fetchExecutableModelCatalog: vi.fn(async () => []),
  fetchChatModelCatalog: vi.fn(async () => []),
  submitGenerationBatch: vi.fn(),
}));

const entry = (): ExecutableModelDirectoryEntry => ({
  model_id: 'gpt-image-2',
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: {
    fields: [
      {
        fieldKey: 'size',
        label: '画面尺寸',
        component: 'select',
        required: true,
        enumOptions: [{ value: 'auto', label: '自动' }],
      },
    ],
    required_fields: ['size'],
    default_values: { size: 'auto' },
  },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_1',
    deployable: true,
    failure_code: 'none',
  },
});

const seedRequiredField = (field: { fieldKey: string; label: string }): void => {
  usePromptDockStore.setState({
    catalog: [
      {
        ...entry(),
        parameter_schema: {
          ...entry().parameter_schema,
          fields: [
            {
              fieldKey: field.fieldKey,
              label: field.label,
              component: 'select',
              required: true,
              enumOptions: [{ value: 'auto', label: '自动' }],
            },
          ],
          required_fields: [field.fieldKey],
          default_values: {},
        },
      },
    ],
  });
};

describe('PromptDock 必填参数阻断反馈', () => {
  beforeEach(() => {
    cleanup();
    vi.mocked(toast.error).mockReset();
    usePromptDockStore.setState({
      draft: {
        modelId: 'gpt-image-2',
        modelVersion: '1.0.0',
        prompt: '一只在草地上的猫',
        arguments: {},
        references: [],
        promptPresetSnapshots: undefined,
        taskCount: 1,
      },
      catalog: [entry()],
      catalogLoaded: true,
      submitting: false,
      preflightIssues: null,
    });
  });

  it('提示带上该参数的界面标签，而不是内部 fieldKey', async () => {
    render(<PromptDock />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('promptdock-submit'));
    });

    expect(screen.getByTestId('promptdock-preflight-issues')).toHaveTextContent(
      '请补上「画面尺寸」再提交。',
    );
    expect(toast.error).toHaveBeenCalledWith('请补上「画面尺寸」再提交。');
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('size'));
  });

  it('schema 没给可用 label：退回 preflight 兜底句，不把字段名当标签印出去', async () => {
    seedRequiredField({ fieldKey: 'aspect_ratio', label: '' });
    render(<PromptDock />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('promptdock-submit'));
    });

    expect(screen.getByTestId('promptdock-preflight-issues')).toHaveTextContent(
      '还有必填项没有填写，请打开「完整参数」补充后再提交。',
    );
    expect(toast.error).toHaveBeenCalledWith('还有必填项没有填写，请打开「完整参数」补充后再提交。');
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('aspect_ratio'));
  });

  it('label 就是字段名：同样退回兜底句，不把 aspect_ratio 印出去', async () => {
    seedRequiredField({ fieldKey: 'aspect_ratio', label: 'aspect_ratio' });
    render(<PromptDock />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('promptdock-submit'));
    });

    expect(toast.error).toHaveBeenCalledWith('还有必填项没有填写，请打开「完整参数」补充后再提交。');
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('aspect_ratio'));
  });
});
