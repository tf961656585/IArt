import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchemaPayload } from '@/features/workspace/schema/buildPayload';
import { createProjection, loadConfigSchema, requireProjectionRuntime } from './__tests__/fixtures/modelAssetProjectionBridgeFixtures';
import { buildModelConfigFromNodeProjection, buildModelConfigsFromNodeProjections } from './modelAssetProjectionBridge';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('modelAssetProjectionBridge', () => {
  it('可将 NodeProjection 转换为 ModelConfig 并保留 payload 映射', async () => {
    const projection = createProjection();
    const config = buildModelConfigFromNodeProjection(projection);

    expect(config).toBeTruthy();
    if (!config) return;

    expect(config.label).toBe('z-image-turbo');
    expect(config.modelId).toBe('z-image-turbo');
    expect(config.modelId).toBe('z-image-turbo');
    expect(config.description).toBeUndefined();
    expect(config.i18n).toBeUndefined();
    expect(config.providerId).toBe('alibaba');
    expect(config.defaults).toMatchObject({
      endpoint: '/v1/images/generations',
      method: 'POST',
    });
    expect(config.canvasPortSpec).toBeUndefined();
    expect(config.nodeGraphPorts?.inputs?.[0]?.fieldKey).toBe('prompt');
    expect(config.workspace?.resultExtractor).toBeUndefined();
    const schema = await loadConfigSchema(config);
    expect(schema.payload.taskType).toBe('image');
    expect(schema.payload.map['body.model']).toMatchObject({
      kind: 'literal',
      value: 'z-image-turbo',
    });
    expect(schema.payload.map['body.prompt']).toMatchObject({
      kind: 'field',
      field: 'prompt',
      transforms: ['trim'],
    });
  });

  it('runtime.payload_format 可驱动 schema 生成 multipart payload', async () => {
    const projection = createProjection({
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        payload_format: 'multipart',
        payload_format_rule: undefined,
        api_defaults: {
          endpoint: '/v1/videos',
          method: 'POST',
          contentType: null,
          headers: undefined,
        },
        payload_rules: {
          'api.endpoint': {
            kind: 'literal',
            value: '/v1/videos',
          },
          'body.model': {
            kind: 'literal',
            value: 'kling-v3-text2video',
          },
          'body.prompt': {
            kind: 'field',
            field_key: 'prompt',
            transforms: ['trim'],
            fallback: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
          },
        },
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config).toBeTruthy();
    if (!config) return;
    const schema = await loadConfigSchema(config);
    expect(schema.payload.format).toBe('multipart');

    const payload = await buildSchemaPayload({
      schema,
      values: {
        prompt: '  veo multipart  ',
        size: '1536x1536',
      },
      modelId: config.modelId,
      runtime: undefined,
    });

    expect(payload.body).toBeInstanceOf(FormData);
    expect(payload.api?.contentType).toBeNull();
    expect((payload.body as FormData).get('model')).toBe('kling-v3-text2video');
    expect((payload.body as FormData).get('prompt')).toBe('veo multipart');
  });

  it('使用通用 execution_driver 时回退到 backend formal task adapter', () => {
    const unsupported = createProjection({
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        execution_driver: 'http_formal_task',
      },
    });

    const config = buildModelConfigFromNodeProjection(unsupported);
    expect(config).toBeTruthy();
    if (!config) return;
    expect(config.modelId).toBe('z-image-turbo');
    expect(typeof config.adapter.generate).toBe('function');

    const configs = buildModelConfigsFromNodeProjections([unsupported, createProjection()]);
    expect(configs).toHaveLength(2);
  });

  it('未知 provider_id 仍可进入投影映射', () => {
    const unknownProvider = createProjection({
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        provider_id: 'not-registered',
      },
    });

    const config = buildModelConfigFromNodeProjection(unknownProvider);
    expect(config?.providerId).toBe('not-registered');

    const configs = buildModelConfigsFromNodeProjections([unknownProvider, createProjection()]);
    expect(configs).toHaveLength(2);
    expect(configs[0]?.providerId).toBe('not-registered');
  });

  it('grouped projection 保留单一壳配置并暴露 shell/default 信息', () => {
    const groupedProjection = createProjection({
      model_id: 'variant-group:kling-v3',
      display_label: 'Kling 3.0',
      shell_model_id: 'variant-group:kling-v3',
      variant_group: {
        group_key: 'kling-v3',
        shell_model_id: 'variant-group:kling-v3',
        default_model_id: 'kling-v3-text2video',
        variants: [
          {
            model_id: 'kling-v3-text2video',
            shell_model_id: 'variant-group:kling-v3',
            label: 'kling-v3-text2video',
            order: 0,
          },
          {
            model_id: 'kling-v3-image2video',
            shell_model_id: 'variant-group:kling-v3',
            label: 'kling-v3-image2video',
            order: 1,
          },
        ],
      },
    });

    const config = buildModelConfigFromNodeProjection(groupedProjection);
    expect(config?.modelId).toBe('variant-group:kling-v3');
    expect(config?.label).toBe('Kling 3.0');
    expect(config?.variantGroup).toMatchObject({
      groupKey: 'kling-v3',
      shellModelId: 'variant-group:kling-v3',
      defaultModelId: 'kling-v3-text2video',
    });
    expect(config?.variantGroup?.variants.map((item) => item.modelId)).toEqual([
      'kling-v3-text2video',
      'kling-v3-image2video',
    ]);

    const configs = buildModelConfigsFromNodeProjections([groupedProjection]);
    expect(configs).toHaveLength(1);
  });

  it('支持从投影读取 role=processor', () => {
    const processorProjection = createProjection({
      role: 'processor',
      model_id: 'edge-detect',
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        execution_driver: 'http_formal_task',
      },
    });
    const config = buildModelConfigFromNodeProjection(processorProjection);
    expect(config?.role).toBe('processor');
  });

  it('runtime.polling 不再暴露为前端模型配置字段', () => {
    const projection = createProjection({
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        execution_driver: 'http_formal_task',
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config !== null && config !== undefined ? Object.prototype.hasOwnProperty.call(config, 'polling') : false).toBe(false);
  });

  it('常规 runtime projection 同样不注入 polling 壳字段', () => {
    const projection = createProjection({
      runtime: {
        ...requireProjectionRuntime(createProjection()),
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config !== null && config !== undefined ? Object.prototype.hasOwnProperty.call(config, 'polling') : false).toBe(false);
  });

  it('支持扩展组件与 DSL 表达（when/compute）', async () => {
    const projection = createProjection({
      parameter_schema: {
        schema_type: 'object',
        fields: [
          {
            field_key: 'prompt',
            label: '提示词',
            component: 'textarea',
            data_source: 'form',
            required: true,
            default_value: '',
          },
          {
            field_key: 'style',
            label: '风格',
            component: 'radio',
            data_source: 'form',
            required: true,
            default_value: 'realistic',
            enum_options: [
              { value: 'realistic', label: '写实' },
              { value: 'anime', label: '动漫' },
            ],
          },
          {
            field_key: 'mode',
            label: '模式',
            component: 'toggle',
            data_source: 'form',
            required: true,
            default_value: 'fast',
            enum_options: [
              { value: 'fast', label: '快速' },
              { value: 'quality', label: '高质量' },
            ],
            component_props: {
              exclusive: true,
            },
          },
          {
            field_key: 'watermark',
            label: '水印',
            component: 'switch',
            data_source: 'form',
            required: false,
            default_value: false,
          },
          {
            field_key: 'reference',
            label: '参考图',
            component: 'imageUpload',
            data_source: 'form',
            required: false,
            default_value: [],
            component_props: {
              maxFiles: 2,
              accept: 'image/*',
            },
          },
          {
            field_key: 'attachment',
            label: '附件',
            component: 'file',
            data_source: 'form',
            required: false,
            default_value: [],
            component_props: {
              maxFiles: 1,
              allowMultiple: false,
            },
          },
          {
            field_key: 'frameSize',
            label: '尺寸',
            component: 'imageSize',
            data_source: 'form',
            required: false,
            default_value: 1024,
            component_props: {
              sizeOptions: [512, 1024],
            },
          },
        ],
        required_fields: ['prompt', 'style', 'mode'],
        default_values: {
          prompt: '',
          style: 'realistic',
          mode: 'fast',
          watermark: false,
          reference: [],
          attachment: [],
          frameSize: 1024,
        },
        validation_rules: [],
      },
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        capabilities: {
          task_group: 'image-pro',
          media_input_mode: 'image+text',
          ui_guards: ['requiresPrompt'],
          execution_traits: ['nonBlocking'],
        },
        payload_rules: {
          'api.endpoint': {
            kind: 'literal',
            value: '/v1/images/generations',
          },
          'body.prompt': {
            kind: 'field',
            field_key: 'prompt',
            transforms: ['trim'],
            fallback: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
          },
          'body.watermark': {
            kind: 'when',
            condition: {
              op: 'truthy',
              field: 'watermark',
            },
            truthy: {
              kind: 'literal',
              value: true,
            },
            falsy: {
              kind: 'literal',
              value: false,
            },
          },
          'meta.promptTag': {
            kind: 'compute',
            operator: 'concat',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            args: [
              {
                kind: 'literal',
                value: 'tag:',
              },
              {
                kind: 'field',
                field_key: 'prompt',
                transforms: ['trim'],
                fallback: undefined,
                media_target: undefined,
                multipart_array_naming: undefined,
              },
            ],
          },
        },
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config).toBeTruthy();
    if (!config) return;

    expect(config.groupId).toBe('alibaba');
    expect(config.assetCapabilities).toMatchObject({
      taskGroup: 'image-pro',
      mediaInputMode: 'image+text',
      uiGuards: ['requiresPrompt'],
      executionTraits: ['nonBlocking'],
    });
    const schema = await loadConfigSchema(config);

    const fieldTypeByKey = schema.fields.reduce<Record<string, string>>((result, field) => {
      if (field.key) {
        result[field.key] = field.type;
      }
      return result;
    }, {});
    expect(fieldTypeByKey['style']).toBe('radio');
    expect(fieldTypeByKey['mode']).toBe('toggle');
    expect(fieldTypeByKey['reference']).toBe('imageUpload');
    expect(fieldTypeByKey['attachment']).toBe('file');
    expect(fieldTypeByKey['frameSize']).toBe('imageSize');

    const payload = await buildSchemaPayload({
      schema,
      values: {
        prompt: '  hello world  ',
        style: 'realistic',
        mode: 'fast',
        watermark: true,
        reference: [],
        attachment: [],
        frameSize: 1024,
      },
      modelId: config.modelId,
      runtime: undefined,
    });

    expect(payload.body).toMatchObject({
      prompt: 'hello world',
      watermark: true,
    });
    expect(payload.meta).toMatchObject({
      promptTag: 'tag:hello world',
    });
  });

  it('可投影 constrained imageSize 组件配置', async () => {
    const projection = createProjection({
      parameter_schema: {
        schema_type: 'object',
        fields: [
          {
            field_key: 'prompt',
            label: '提示词',
            component: 'textarea',
            data_source: 'form',
            required: true,
            default_value: '',
          },
          {
            field_key: 'size',
            label: '尺寸',
            component: 'imageSize',
            data_source: 'form',
            required: false,
            default_value: 'auto',
            component_props: {
              mode: 'constrainedResolution',
              allowAuto: true,
              sizeLevels: [
                {
                  id: '2k',
                  label: 'model-asset/gpt-image-2:fields.size.sizeLevels.2k.label',
                  pixelBudget: 4194304,
                },
                {
                  id: '4k',
                  label: 'model-asset/gpt-image-2:fields.size.sizeLevels.4k.label',
                  pixelBudget: 8294400,
                },
              ],
              aspectPresets: [
                {
                  id: '16:9',
                  label: 'model-asset/gpt-image-2:fields.size.aspectPresets.16_9.label',
                  ratio: 16 / 9,
                },
                {
                  id: '9:16',
                  label: 'model-asset/gpt-image-2:fields.size.aspectPresets.9_16.label',
                  ratio: 9 / 16,
                },
              ],
              presetOptions: [
                {
                  value: 'auto',
                  label: 'model-asset/gpt-image-2:fields.size.presetOptions.auto.label',
                },
              ],
              constraints: {
                dimensionMultiple: 16,
                maxLongEdge: 3840,
                minPixels: 655360,
                maxPixels: 8294400,
                maxAspectRatio: 3,
              },
            },
          },
        ],
        required_fields: ['prompt'],
        default_values: {
          prompt: '',
          size: 'auto',
        },
        validation_rules: [],
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config).toBeTruthy();
    if (!config) return;
    const schema = await loadConfigSchema(config);
    const sizeField = schema.fields.find((field) => field.key === 'size');
    expect(sizeField).toMatchObject({
      type: 'imageSize',
      mode: 'constrainedResolution',
      allowAuto: true,
      defaultValue: 'auto',
      constraints: {
        dimensionMultiple: 16,
        maxLongEdge: 3840,
        minPixels: 655360,
        maxPixels: 8294400,
        maxAspectRatio: 3,
      },
    });
    expect(sizeField?.type === 'imageSize' ? sizeField.sizeLevels : undefined).toEqual([
      {
        id: '2k',
        labelKey: 'model-asset/gpt-image-2:fields.size.sizeLevels.2k.label',
        pixelBudget: 4194304,
      },
      {
        id: '4k',
        labelKey: 'model-asset/gpt-image-2:fields.size.sizeLevels.4k.label',
        pixelBudget: 8294400,
      },
    ]);
    expect(sizeField?.type === 'imageSize' ? sizeField.aspectPresets : undefined).toEqual([
      {
        id: '16:9',
        labelKey: 'model-asset/gpt-image-2:fields.size.aspectPresets.16_9.label',
        ratio: 16 / 9,
      },
      {
        id: '9:16',
        labelKey: 'model-asset/gpt-image-2:fields.size.aspectPresets.9_16.label',
        ratio: 9 / 16,
      },
    ]);
    expect(sizeField?.type === 'imageSize' ? sizeField.presetOptions : undefined).toEqual([
      {
        value: 'auto',
        labelKey: 'model-asset/gpt-image-2:fields.size.presetOptions.auto.label',
      },
    ]);
  });

});
