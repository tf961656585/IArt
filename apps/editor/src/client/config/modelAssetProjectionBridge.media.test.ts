import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchemaPayload } from '@/features/workspace/schema/buildPayload';
import { createProjection, loadConfigSchema, requireProjectionRuntime } from './__tests__/fixtures/modelAssetProjectionBridgeFixtures';
import { buildModelConfigFromNodeProjection } from './modelAssetProjectionBridge';
import type {
  ModelAssetNodeProjectionRuntimeValueRule,
  ModelAssetNodeProjectionRuntimeValueTransform,
} from '@iart/contracts/model-asset-contract';
import type { SchemaFormDefinition } from '@/features/workspace/schema/types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fieldRule = (
  fieldKey: string,
  transforms: ModelAssetNodeProjectionRuntimeValueTransform[] | undefined = undefined,
): ModelAssetNodeProjectionRuntimeValueRule => ({
  kind: 'field',
  field_key: fieldKey,
  transforms,
  media_target: undefined,
  multipart_array_naming: undefined,
  fallback: undefined,
});

const buildPayloadForSchema = (
  schema: SchemaFormDefinition<string>,
  values: Record<string, unknown>,
  modelId: string,
) => buildSchemaPayload({
  schema,
  values,
  modelId,
  runtime: undefined,
});

describe('modelAssetProjectionBridge.media', () => {
  it('支持新 DSL operator / transform（assert / parse / number / base64 / last）', async () => {
    const projection = createProjection({
      parameter_schema: {
        schema_type: 'object',
        fields: [
          {
            field_key: 'speakerVoiceLines',
            label: '多人配音',
            component: 'textarea',
            data_source: 'form',
            required: false,
            default_value: 'Joe|Kore\nJane|Puck',
          },
          {
            field_key: 'image',
            label: '首图',
            component: 'imageUpload',
            data_source: 'form',
            required: false,
            default_value: [],
          },
          {
            field_key: 'referenceImages',
            label: '参考图',
            component: 'imageUpload',
            data_source: 'form',
            required: false,
            default_value: [],
          },
          {
            field_key: 'seconds',
            label: '秒数',
            component: 'number',
            data_source: 'form',
            required: false,
            default_value: 1.5,
          },
          {
            field_key: 'volume',
            label: '音量',
            component: 'number',
            data_source: 'form',
            required: false,
            default_value: 2.5,
          },
        ],
        required_fields: [],
        default_values: {
          speakerVoiceLines: 'Joe|Kore\nJane|Puck',
          image: [],
          referenceImages: [],
          seconds: 1.5,
          volume: 2.5,
        },
        validation_rules: [],
      },
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        payload_rules: {
          'body.speakerVoiceConfigs': {
            kind: 'compute',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            operator: 'parse_line_pairs',
            args: [
              fieldRule('speakerVoiceLines'),
            ],
            options: {
              left_key: 'speaker',
              right_key: 'voiceName',
              pair_delimiter: '|',
              message: undefined,
            },
          },
          'body.imageDataUrl': {
            kind: 'compute',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            operator: 'assert_non_empty',
            args: [
              fieldRule('image', ['extractFirstBase64DataUrl']),
            ],
            options: {
              message: '需要首图',
            },
          },
          'body.lastReferenceImage': {
            ...fieldRule('referenceImages', ['extractUrls', 'last']),
          },
          'meta.strictReferenceImages': {
            kind: 'compute',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            operator: 'assert_array_length',
            args: [
              fieldRule('referenceImages', ['extractUrls']),
            ],
            options: {
              min_items: 2,
              max_items: 2,
              message: undefined,
            },
          },
          'meta.soundEndMs': {
            kind: 'compute',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            operator: 'scale_number',
            args: [
              fieldRule('seconds', ['toNumber']),
            ],
            options: {
              factor: 1000,
              round: 'round',
            },
          },
          'meta.soundVolume': {
            kind: 'compute',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            operator: 'clamp_number',
            args: [
              fieldRule('volume', ['toNumber']),
            ],
            options: {
              min: 0,
              max: 2,
              round: undefined,
            },
          },
        },
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config).toBeTruthy();
    if (!config) return;
    const schema = await loadConfigSchema(config);

    const payload = await buildPayloadForSchema(
      schema,
      {
        speakerVoiceLines: 'Joe|Kore\nJane|Puck',
        image: ['data:image/png;base64,SU1BR0U='],
        referenceImages: [
          'https://assets.example/first.png',
          'https://assets.example/last.png',
        ],
        seconds: 1.75,
        volume: 3,
      },
      config.modelId,
    );

    expect(payload.body).toMatchObject({
      speakerVoiceConfigs: [
        { speaker: 'Joe', voiceName: 'Kore' },
        { speaker: 'Jane', voiceName: 'Puck' },
      ],
      imageDataUrl: 'data:image/png;base64,SU1BR0U=',
      lastReferenceImage: 'https://assets.example/last.png',
    });
    expect(payload.meta).toMatchObject({
      strictReferenceImages: [
        'https://assets.example/first.png',
        'https://assets.example/last.png',
      ],
      soundEndMs: 1750,
      soundVolume: 2,
    });

    await expect(
      buildSchemaPayload({
        schema,
        values: {
          speakerVoiceLines: 'Joe|Kore',
          image: [],
          referenceImages: ['https://assets.example/only.png'],
          seconds: 1,
          volume: 1,
        },
        modelId: config.modelId,
        runtime: undefined,
      }),
    ).rejects.toThrow('需要首图');
  });

  it('支持 Gemini 内容块 operator（build_content_blocks）', async () => {
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
            field_key: 'images',
            label: '图片',
            component: 'imageUpload',
            data_source: 'form',
            required: false,
            default_value: [],
          },
        ],
        required_fields: ['prompt'],
        default_values: {
          prompt: '',
          images: [],
        },
        validation_rules: [],
      },
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        payload_rules: {
          'body.contents': {
            kind: 'compute',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            operator: 'build_content_blocks',
            options: {
              role: 'user',
              output_shape: undefined,
              parts: [
                {
                  part_kind: 'text',
                  value: {
                    ...fieldRule('prompt', ['trim']),
                  },
                  skip_if_empty: true,
                },
                {
                  part_kind: 'inline_data',
                  value: {
                    ...fieldRule('images'),
                  },
                  multiple: undefined,
                  max_items: 1,
                  skip_if_empty: undefined,
                },
              ],
            },
          },
        },
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config).toBeTruthy();
    if (!config) return;
    const schema = await loadConfigSchema(config);

    const payload = await buildPayloadForSchema(
      schema,
      {
        prompt: '  bridge nano  ',
        images: ['data:image/png;base64,VEFSR0VU'],
      },
      config.modelId,
    );

    expect((payload.body as Record<string, unknown>)?.['contents']).toMatchObject([
      {
        role: 'user',
        parts: [
          { text: 'bridge nano' },
          { inline_data: { mime_type: 'image/png', data: 'VEFSR0VU' } },
        ],
      },
    ]);
  });

});
