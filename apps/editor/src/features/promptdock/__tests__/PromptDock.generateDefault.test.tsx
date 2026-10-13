import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import type { ExecutableModelDirectoryEntry } from '@iart/contracts';

import { fetchChatModelCatalog, fetchExecutableModelCatalog } from '@/client/api/promptDockApi';
import { fetchLocalBackendConfig } from '@/client/api/localConfig';
import type { LocalBackendConfigResponse } from '@/client/api/localConfig';
import { PromptDock } from '../PromptDock';
import { EMPTY_PROMPT_DOCK_AGENT_SELECTION } from '../PromptDock.types';
import {
  EMPTY_PROMPT_DOCK_DRAFT,
  PROMPT_DOCK_DEFAULT_MODEL_ID,
  usePromptDockStore,
} from '../promptDockStore';

/**
 * 「本机配置的生成默认模型 → 创作面预选」的组件级用例（spec PromptDock生成主链.md PD-AC-010）：
 * `GET /api/config` 带回 `generationDefaultModelId` 时，配置到达后生成形态要预选出该模型，
 * 而不是停在目录顺序的内置首选上。
 *
 * 覆盖的是组件里的真实读取路径（两个 effect 各自的竞速：目录与配置谁先返回不一定），
 * 配置响应打桩在本文件；配置写入与回读端到端由
 * `testing/integration/promptDock.generateDefaultSeam.test.ts` 用真实后端覆盖。
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
  getRuntimeProjectPath: () => '/tmp/iart-promptdock-generation-default-test',
}));

vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  fetchExecutableModelCatalog: vi.fn(),
  fetchChatModelCatalog: vi.fn(),
  submitGenerationBatch: vi.fn(),
}));

vi.mock('@/client/api/localConfig', () => ({
  __esModule: true,
  fetchLocalBackendConfig: vi.fn(),
}));

vi.mock('@/features/promptdock/projection/taskProjectionService', () => ({
  __esModule: true,
  createTaskProjectionsForAcceptance: vi.fn(() => ({ ok: true as const })),
}));

const CONFIGURED_MODEL_ID = 'promptdock-seam-config-model';

const entry = (
  modelId: string,
  defaultValues: Record<string, unknown>,
): ExecutableModelDirectoryEntry => ({
  model_id: modelId,
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: { fields: [], required_fields: [], default_values: defaultValues },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_1',
    deployable: true,
    failure_code: 'none',
  },
});

/** 目录顺序把内置首选放在最前：预选到配置的模型只能来自配置，不可能是「取目录首个」。 */
const catalogFixture: ExecutableModelDirectoryEntry[] = [
  entry(PROMPT_DOCK_DEFAULT_MODEL_ID, { size: 'builtin-default-size' }),
  entry(CONFIGURED_MODEL_ID, { size: 'configured-default-size' }),
];

const configPayload = (generationDefaultModelId: string | null): LocalBackendConfigResponse => ({
  config: {
    version: 1,
    preferredPort: 0,
    logLevel: 'info',
    maxUploadSize: 1024,
    maxMediaSize: 1024,
    maxBatchTasks: 30,
    expandInlineParamsOnStartup: false,
    agentDefaultModelId: null,
    generationDefaultModelId,
    allowedRemoteHosts: [],
  },
  resolved: {
    preferredPort: 0,
    logLevel: 'info',
    maxUploadSize: 1024,
    maxMediaSize: 1024,
    maxBatchTasks: 30,
    expandInlineParamsOnStartup: false,
    allowedRemoteHosts: [],
  },
  server: undefined,
});

/** 创作面初始态：目录与配置都还没到（store 是模块级单例，用例之间必须显式复位）。 */
const resetPromptDockStore = () => {
  usePromptDockStore.setState({
    form: 'generate',
    draft: { ...EMPTY_PROMPT_DOCK_DRAFT, references: [] },
    catalog: [],
    catalogLoaded: false,
    chatCatalog: [],
    chatCatalogLoaded: false,
    generationDefaultModelId: null,
    generationModelChosen: false,
    agentDefaultModelId: null,
    agentSelection: { ...EMPTY_PROMPT_DOCK_AGENT_SELECTION },
    agentBinding: null,
    agentEntrySnapshot: null,
    submitting: false,
    preflightIssues: null,
  });
};

beforeEach(() => {
  cleanup();
  resetPromptDockStore();
  vi.mocked(fetchExecutableModelCatalog).mockReset();
  vi.mocked(fetchChatModelCatalog).mockReset();
  vi.mocked(fetchLocalBackendConfig).mockReset();
  vi.mocked(fetchExecutableModelCatalog).mockResolvedValue(catalogFixture);
  vi.mocked(fetchChatModelCatalog).mockResolvedValue([]);
  vi.mocked(fetchLocalBackendConfig).mockResolvedValue(configPayload(null));
});

describe('PromptDock 生成形态的默认模型预选', () => {
  it('配置带回 generationDefaultModelId 时，创作面预选出该模型（压过目录里的内置首选）', async () => {
    vi.mocked(fetchLocalBackendConfig).mockResolvedValue(
      configPayload(CONFIGURED_MODEL_ID),
    );

    await act(async () => {
      render(<PromptDock />);
    });

    const state = usePromptDockStore.getState();
    expect(state.generationDefaultModelId).toBe(CONFIGURED_MODEL_ID);
    expect(state.draft.modelId).toBe(CONFIGURED_MODEL_ID);
    expect(state.draft.modelVersion).toBe('1.0.0');
    expect(state.draft.arguments).toEqual({ size: 'configured-default-size' });
    expect(screen.getByTestId('promptdock-model-select')).toHaveTextContent(
      CONFIGURED_MODEL_ID,
    );
  });

  it('配置没设默认（null）时按内置首选预选，不预选目录首个', async () => {
    await act(async () => {
      render(<PromptDock />);
    });

    const state = usePromptDockStore.getState();
    expect(state.generationDefaultModelId).toBeNull();
    expect(state.draft.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);
    expect(screen.getByTestId('promptdock-model-select')).toHaveTextContent(
      PROMPT_DOCK_DEFAULT_MODEL_ID,
    );
  });
});
