import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';

import type { ExecutableModelDirectoryEntry } from '@iart/contracts';
import { submitGenerationBatch } from '@/client/api/promptDockApi';
import { usePromptDockStore } from '../promptDockStore';
import { PromptDock } from '../PromptDock';

/**
 * PromptDock 形态入口（spec docs/agent/06-UI交互与PromptDock接入.md「形态切换入口」）：
 * 创作条上的常驻切换器是形态的唯一入口；agent 形态不出现生成模型的配置面，改用服务行
 * 三项（模型 / 思考 / 审批）；切换保留未提交草稿；agent 模型不可用（对话目录为空或所选模型
 * 不可提交）时提交被前置校验阻断，且不误走生成批次。
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
  getRuntimeProjectPath: () => '/tmp/iart-promptdock-form-test',
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

/** 生成式形态初始态：已选模型、已有草稿文本。 */
const seedGenerateForm = () => {
  usePromptDockStore.setState({
    form: 'generate',
    draft: {
      modelId: 'gpt-image-2',
      modelVersion: '1.0.0',
      prompt: '一只在雨中弹吉他的柴犬',
      arguments: { size: 'auto' },
      references: [],
      promptPresetSnapshots: undefined,
      taskCount: 1,
    },
    catalog: [entry('gpt-image-2')],
    catalogLoaded: true,
    submitting: false,
    preflightIssues: null,
  });
};

const switchTo = async (label: '生成' | 'Agent') => {
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: label }));
  });
};

beforeEach(() => {
  cleanup();
  vi.mocked(submitGenerationBatch).mockReset();
});

describe('PromptDock 形态入口（spec 06「形态切换入口」）', () => {
  it('默认生成式形态：切换器在、生成模型配置面在、主按钮文案为「生成」', () => {
    seedGenerateForm();
    render(<PromptDock />);

    expect(screen.getByRole('radio', { name: '生成' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('promptdock-model-select')).toBeInTheDocument();
    expect(screen.getByTestId('promptdock-submit')).toHaveTextContent('生成');
    expect(screen.queryByTestId('promptdock-agent-service-row')).not.toBeInTheDocument();
  });

  it('切到 Agent：生成模型配置面让位给服务行三项，主按钮改为图标发送钮（aria-label「发送」）', async () => {
    seedGenerateForm();
    render(<PromptDock />);

    await switchTo('Agent');

    expect(screen.getByRole('radio', { name: 'Agent' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByTestId('promptdock-model-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('promptdock-agent-service-row')).toBeInTheDocument();
    // agent 形态主按钮是圆形图标钮：无可见文字，可及名来自 aria-label
    expect(screen.getByTestId('promptdock-submit')).toHaveAccessibleName('发送');
  });

  it('形态切换保留未提交草稿：prompt 不因切形态被清空或改写', async () => {
    seedGenerateForm();
    render(<PromptDock />);

    await switchTo('Agent');
    expect(usePromptDockStore.getState().draft.prompt).toBe('一只在雨中弹吉他的柴犬');
    expect(screen.getByTestId('promptdock-prompt-editor').textContent).toBe(
      '一只在雨中弹吉他的柴犬',
    );

    await switchTo('生成');
    expect(usePromptDockStore.getState().draft.prompt).toBe('一只在雨中弹吉他的柴犬');
  });

  it('Agent 形态提交被前置校验阻断：不发起生成批次，反馈指向可行动的位置', async () => {
    seedGenerateForm();
    render(<PromptDock />);

    await switchTo('Agent');
    await act(async () => {
      fireEvent.click(screen.getByTestId('promptdock-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('promptdock-preflight-issues')).toHaveTextContent(
        '还没有可用的模型',
      );
    });
    expect(submitGenerationBatch).not.toHaveBeenCalled();
    expect(usePromptDockStore.getState().draft.prompt).toBe('一只在雨中弹吉他的柴犬');
  });
});
