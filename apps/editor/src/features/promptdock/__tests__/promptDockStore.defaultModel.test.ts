import { describe, expect, it, beforeEach } from 'vitest';

import type { ExecutableModelDirectoryEntry } from '@iart/contracts';
import {
  EMPTY_PROMPT_DOCK_DRAFT,
  PROMPT_DOCK_DEFAULT_MODEL_ID,
  resolveDefaultDraft,
  usePromptDockStore,
} from '../promptDockStore';

/**
 * 生成形态的默认预选（spec PromptDock生成主链.md PD-AC-010 + 本机配置 `generationDefaultModelId`）。
 *
 * 优先级：配置的默认模型 → 内置首选 gpt-image-2 → 目录首个模型；目录为空时为 null。
 * 配置的模型不在可执行目录里按「没设默认」处理（继续走内置首选），不报错、不阻断创作面。
 * 默认预选不构成自动补选——所选模型不可执行时仍由前置校验阻断，绝不自动换成别的模型。
 * 提交受理后草稿原样保留（PD-AC-012），store 不再提供提交后清空/重置路径。
 */

const entry = (
  modelId: string,
  modelVersion = '1.0.0',
): ExecutableModelDirectoryEntry => ({
  model_id: modelId,
  model_version: modelVersion,
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

const resetStore = () => {
  usePromptDockStore.setState({
    draft: { ...EMPTY_PROMPT_DOCK_DRAFT, references: [] },
    catalog: [],
    catalogLoaded: false,
    generationDefaultModelId: null,
    generationModelChosen: false,
    submitting: false,
    preflightIssues: null,
  });
};

describe('resolveDefaultDraft', () => {
  it('配置的默认模型在目录里时优先预选它，并带 default_values', () => {
    const defaults = resolveDefaultDraft(
      [entry(PROMPT_DOCK_DEFAULT_MODEL_ID), entry('veo-3.1-generate-preview')],
      'veo-3.1-generate-preview',
    );
    expect(defaults?.modelId).toBe('veo-3.1-generate-preview');
    expect(defaults?.arguments).toEqual({ size: 'auto' });
  });

  it('没设默认（null）时优先预选内置首选 gpt-image-2', () => {
    const defaults = resolveDefaultDraft(
      [entry('veo-3.1-generate-preview'), entry(PROMPT_DOCK_DEFAULT_MODEL_ID)],
      null,
    );
    expect(defaults?.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);
  });

  it('配置的模型不在目录里时回落内置首选（按「没设默认」处理）', () => {
    const defaults = resolveDefaultDraft(
      [entry('veo-3.1-generate-preview'), entry(PROMPT_DOCK_DEFAULT_MODEL_ID)],
      'gone-model',
    );
    expect(defaults?.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);
  });

  it('配置与内置首选都不在目录时回退首个模型', () => {
    const defaults = resolveDefaultDraft(
      [entry('veo-3.1-generate-preview'), entry('gemini-3-pro-image')],
      'gone-model',
    );
    expect(defaults?.modelId).toBe('veo-3.1-generate-preview');
  });

  it('目录为空返回 null', () => {
    expect(resolveDefaultDraft([], 'my-model')).toBeNull();
  });
});

describe('promptDockStore 预选写入点', () => {
  beforeEach(resetStore);

  it('目录先到、配置后到：配置的默认模型仍能生效（不被已预选的内置首选吞掉）', () => {
    usePromptDockStore.getState().setCatalog([
      entry('veo-3.1-generate-preview'),
      entry(PROMPT_DOCK_DEFAULT_MODEL_ID),
    ]);
    expect(usePromptDockStore.getState().draft.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);

    usePromptDockStore.getState().setGenerationDefaultModelId('veo-3.1-generate-preview');
    expect(usePromptDockStore.getState().draft.modelId).toBe('veo-3.1-generate-preview');
    expect(usePromptDockStore.getState().draft.arguments).toEqual({ size: 'auto' });
  });

  it('配置先到、目录后到：同样预选配置的默认模型', () => {
    usePromptDockStore.getState().setGenerationDefaultModelId('veo-3.1-generate-preview');
    expect(usePromptDockStore.getState().draft.modelId).toBeNull();

    usePromptDockStore.getState().setCatalog([
      entry(PROMPT_DOCK_DEFAULT_MODEL_ID),
      entry('veo-3.1-generate-preview'),
    ]);
    expect(usePromptDockStore.getState().draft.modelId).toBe('veo-3.1-generate-preview');
  });

  it('没设默认（null）时 setCatalog 按内置首选预选（首次进入）', () => {
    usePromptDockStore.getState().setGenerationDefaultModelId(null);
    usePromptDockStore.getState().setCatalog([
      entry('veo-3.1-generate-preview'),
      entry(PROMPT_DOCK_DEFAULT_MODEL_ID),
    ]);
    expect(usePromptDockStore.getState().draft.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);
    expect(usePromptDockStore.getState().draft.modelVersion).toBe('1.0.0');
  });

  it('配置的模型不在目录里时回落内置首选', () => {
    usePromptDockStore.getState().setCatalog([
      entry('veo-3.1-generate-preview'),
      entry(PROMPT_DOCK_DEFAULT_MODEL_ID),
    ]);
    usePromptDockStore.getState().setGenerationDefaultModelId('gone-model');
    expect(usePromptDockStore.getState().draft.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);
  });

  it('用户显式选过模型后，目录与配置都不覆盖他的选择', () => {
    usePromptDockStore.getState().setDraft({
      modelId: 'veo-3.1-generate-preview',
      modelVersion: '9.9.9',
    });

    usePromptDockStore.getState().setCatalog([
      entry('veo-3.1-generate-preview', '1.0.0'),
      entry(PROMPT_DOCK_DEFAULT_MODEL_ID),
    ]);
    usePromptDockStore.getState().setGenerationDefaultModelId(PROMPT_DOCK_DEFAULT_MODEL_ID);

    expect(usePromptDockStore.getState().draft.modelId).toBe('veo-3.1-generate-preview');
    expect(usePromptDockStore.getState().draft.modelVersion).toBe('9.9.9');
  });

  it('配置带来的还是当前预选的那个模型时，不动草稿（保留用户改过的参数）', () => {
    usePromptDockStore.getState().setCatalog([entry(PROMPT_DOCK_DEFAULT_MODEL_ID)]);
    expect(usePromptDockStore.getState().draft.arguments).toEqual({ size: 'auto' });
    // 改参数不换模型：不算「显式选过模型」，但它仍属于用户此刻的输入。
    usePromptDockStore.getState().setDraft({ arguments: { size: '1024x1024' } });

    usePromptDockStore.getState().setGenerationDefaultModelId(PROMPT_DOCK_DEFAULT_MODEL_ID);
    expect(usePromptDockStore.getState().draft.modelId).toBe(PROMPT_DOCK_DEFAULT_MODEL_ID);
    expect(usePromptDockStore.getState().draft.arguments).toEqual({ size: '1024x1024' });
  });
});
