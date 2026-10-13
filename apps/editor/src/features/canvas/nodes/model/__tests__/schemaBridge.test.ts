import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { resolveSchemaFieldOptions, applySchemaSelectConstraints } from '../schemaBridge';
import { findModelConfig, setRuntimeProjectedModels } from '@/client/config/models.config';
import type { GenerationAdapter } from '@/client/adapters/types';
import type { ModelConfigEntry } from '@/client/config/models.config';
import type { SchemaFieldOption, SchemaFormDefinition } from '@/features/workspace/schema/types';
import { buildRuntimeProjectedConfigFixture } from '@/client/config/__tests__/fixtures/runtimeProjectionFixtures';

const requireConfig = (modelId: string) => {
  const config = findModelConfig(modelId);
  if (!config) throw new Error(`missing model config: ${modelId}`);
  return config;
};

const stubAdapter: GenerationAdapter = {
  generate: async () => ({ ok: true }),
};

const createOption = (value: string): SchemaFieldOption => ({
  value,
  labelKey: value,
  labelParams: undefined,
  descriptionKey: undefined,
  helperKey: undefined,
  disabledWhen: undefined,
  icon: undefined,
  groupKey: undefined,
});

const buildClearableSelectConfig = (): ModelConfigEntry => {
  const schema: SchemaFormDefinition<string> = {
    meta: {
      id: 'clearable-select-test',
      version: '1',
      modelId: 'clearable-select-model',
      titleKey: undefined,
      descriptionKey: undefined,
      docLinkKey: undefined,
    },
    fields: [
      {
        key: 'size',
        type: 'select',
        labelKey: 'size',
        helperTextKey: undefined,
        helperTextParams: undefined,
        placeholderKey: undefined,
        tooltipKey: undefined,
        descriptionKey: undefined,
        layout: undefined,
        visibleWhen: undefined,
        disabledWhen: undefined,
        required: undefined,
        requiredWhen: undefined,
        validation: undefined,
        events: undefined,
        metadata: undefined,
        defaultValue: undefined,
        className: undefined,
        sx: undefined,
        clearable: true,
        multiple: undefined,
        renderValueKey: undefined,
        options: {
          kind: 'static',
          options: [
            createOption('1024x1024'),
            createOption('1536x1024'),
          ],
        },
      },
    ],
    layout: undefined,
    defaults: undefined,
    formValidators: undefined,
    prompt: undefined,
    payload: {
      format: undefined,
      format_rule: undefined,
      taskType: undefined,
      map: {},
      hooks: undefined,
    },
    responseHandling: undefined,
  };

  return {
    providerId: 'openai',
    groupId: 'openai',
    label: 'Clearable Select Model',
    modelId: 'clearable-select-model',
    defaultTaskType: 'image',
    mode: 'image',
    adapter: stubAdapter,
    defaults: undefined,
    visible: undefined,
    role: undefined,
    description: undefined,
    aliases: undefined,
    routeSegment: undefined,
    workspace: {
      form: {
        kind: 'schema',
        load: async () => schema,
      },
      taskList: undefined,
      output: undefined,
      dock: undefined,
      taskQueue: undefined,
      resultExtractor: undefined,
    },
    canvasPortSpec: undefined,
    i18n: undefined,
    nodeGraphPorts: undefined,
    videoGenMode: undefined,
    canvasInspector: undefined,
    capabilities: undefined,
    assetCapabilities: undefined,
    assetInputContract: undefined,
    variantGroup: undefined,
    };
};

const VEO_MODEL_ID = 'veo-3.1-generate-preview';

describe('schemaBridge', () => {
  beforeEach(() => {
    setRuntimeProjectedModels([buildRuntimeProjectedConfigFixture(VEO_MODEL_ID)]);
  });

  afterEach(() => {
    setRuntimeProjectedModels([]);
  });

  it('VEO 画板仅返回 schema 限定的画面比例', async () => {
    const config = requireConfig(VEO_MODEL_ID);

    const result = await resolveSchemaFieldOptions(config, 'aspectRatio', {});
    expect(result).not.toBeNull();
    if (result === null) throw new Error('missing aspectRatio options');
    const values = result.options.map((opt) => opt.value);
    expect(values).toEqual(['16:9', '9:16']);
  });

  it('非法画面比例会在校验后回退到默认值', async () => {
    const config = requireConfig(VEO_MODEL_ID);

    const checked = await applySchemaSelectConstraints(config, { aspectRatio: '4:3' });
    expect(checked.values['aspectRatio']).toBe('16:9');
  });

  it('clearable 单选字段保持空值，不回填首个枚举项', async () => {
    const config = buildClearableSelectConfig();

    const checked = await applySchemaSelectConstraints(config, {
      prompt: 'a cute cat',
      size: '',
    });

    expect(checked.values['size']).toBe('');
    expect(checked.corrections).not.toHaveProperty('size');
  });
});
