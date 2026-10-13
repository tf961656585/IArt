import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchemaPayload } from '@/features/workspace/schema/buildPayload';
import { createProjection, loadConfigSchema, requireProjectionRuntime } from './__tests__/fixtures/modelAssetProjectionBridgeFixtures';
import { buildModelConfigFromNodeProjection } from './modelAssetProjectionBridge';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('modelAssetProjectionBridge.dsl', () => {
  it('支持结构化 DSL operator（normalize_enum / object / compact_object / compact_array）', async () => {
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
            component: 'select',
            data_source: 'form',
            required: false,
            default_value: '1024',
            enum_options: [
              { value: '1024', label: '1024' },
              { value: '2048', label: '2048' },
            ],
          },
          {
            field_key: 'suffix',
            label: '后缀',
            component: 'text',
            data_source: 'form',
            required: false,
            default_value: '',
          },
        ],
        required_fields: ['prompt'],
        default_values: {
          prompt: '',
          size: '1024',
          suffix: '',
        },
        validation_rules: [],
      },
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        payload_rules: {
          'body.request': {
            kind: 'compute',
            operator: 'compact_object',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            entries: {
              prompt: {
                kind: 'field',
                field_key: 'prompt',
                transforms: ['trim'],
                fallback: undefined,
                media_target: undefined,
                multipart_array_naming: undefined,
              },
              size: {
                kind: 'compute',
                operator: 'normalize_enum',
                cache_key: undefined,
                media_target: undefined,
                multipart_array_naming: undefined,
                args: [
                  {
                    kind: 'field',
                    field_key: 'size',
                    transforms: undefined,
                    fallback: undefined,
                    media_target: undefined,
                    multipart_array_naming: undefined,
                  },
                ],
                options: {
                  allowed_values: ['1024', '2048'],
                  fallback: '1024',
                },
              },
              suffix: {
                kind: 'field',
                field_key: 'suffix',
                transforms: ['trim'],
                fallback: undefined,
                media_target: undefined,
                multipart_array_naming: undefined,
              },
            },
          },
          'meta.tags': {
            kind: 'compute',
            operator: 'compact_array',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            args: [
              {
                kind: 'literal',
                value: 'image',
              },
              {
                kind: 'field',
                field_key: 'suffix',
                transforms: ['trim'],
                fallback: undefined,
                media_target: undefined,
                multipart_array_naming: undefined,
              },
              {
                kind: 'literal',
                value: '',
              },
            ],
          },
        },
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config).toBeTruthy();
    if (!config) return;
    const schema = await loadConfigSchema(config);

    const payload = await buildSchemaPayload({
      schema,
      values: {
        prompt: '  runtime object  ',
        size: 'bad-size',
        suffix: '  poster  ',
      },
      modelId: config.modelId,
      runtime: undefined,
    });

    expect(payload.body).toMatchObject({
      request: {
        prompt: 'runtime object',
        size: '1024',
        suffix: 'poster',
      },
    });
    expect(payload.meta).toMatchObject({
      tags: ['image', 'poster'],
    });
  });

  it('支持 map_array 与 item 引用（自身/path、prepend/append、max_items、skip_if_empty）', async () => {
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
            field_key: 'referenceImages',
            label: '参考图',
            component: 'imageUpload',
            data_source: 'form',
            required: false,
            default_value: [],
          },
        ],
        required_fields: ['prompt'],
        default_values: {
          prompt: '',
          referenceImages: [],
        },
        validation_rules: [],
      },
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        payload_rules: {
          'body.contents': {
            kind: 'compute',
            operator: 'map_array',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            options: {
              source: {
                kind: 'literal',
                value: [
                  'https://assets.example/cover.png',
                  'https://assets.example/detail.png',
                ],
              },
              item: {
                kind: 'compute',
                operator: 'object',
                cache_key: undefined,
                media_target: undefined,
                multipart_array_naming: undefined,
                entries: {
                  type: {
                    kind: 'literal',
                    value: 'image_url',
                  },
                  image_url: {
                    kind: 'compute',
                    operator: 'object',
                    cache_key: undefined,
                    media_target: undefined,
                    multipart_array_naming: undefined,
                    entries: {
                      url: {
                        kind: 'item',
                        path: undefined,
                      },
                    },
                  },
                },
              },
              prepend: [
                {
                  kind: 'when',
                  condition: {
                    op: 'truthy',
                    field: 'prompt',
                  },
                 truthy: {
                    kind: 'compute',
                    operator: 'object',
                    cache_key: undefined,
                    media_target: undefined,
                    multipart_array_naming: undefined,
                    entries: {
                      type: {
                        kind: 'literal',
                        value: 'text',
                      },
                      text: {
                        kind: 'field',
                        field_key: 'prompt',
                        transforms: ['trim'],
                        fallback: undefined,
                        media_target: undefined,
                        multipart_array_naming: undefined,
                      },
                    },
                  },
                  falsy: undefined,
                },
              ],
              append: [
                {
                  kind: 'literal',
                  value: [
                    {
                      type: 'marker',
                      text: 'tail',
                    },
                  ],
                },
              ],
              max_items: 1,
              skip_if_empty: true,
            },
          },
          'meta.samples': {
            kind: 'compute',
            operator: 'map_array',
            cache_key: undefined,
            media_target: undefined,
            multipart_array_naming: undefined,
            options: {
              source: {
                kind: 'literal',
                value: [
                  {
                    id: 'cover',
                    meta: {
                      slot: 'left',
                    },
                  },
                  {
                    id: 'detail',
                    meta: {
                      slot: 'right',
                    },
                  },
                ],
              },
              item: {
                kind: 'compute',
                operator: 'object',
                cache_key: undefined,
                media_target: undefined,
                multipart_array_naming: undefined,
                entries: {
                  raw: {
                    kind: 'item',
                    path: undefined,
                  },
                  id: {
                    kind: 'item',
                    path: 'id',
                  },
                  slot: {
                    kind: 'item',
                    path: 'meta.slot',
                  },
                },
              },
              prepend: [
                {
                  kind: 'literal',
                  value: [
                    {
                      id: 'intro',
                    },
                  ],
                },
              ],
              append: [
                {
                  kind: 'literal',
                  value: {
                    id: 'outro',
                  },
                },
              ],
              max_items: 1,
              skip_if_empty: true,
            },
          },
        },
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config).toBeTruthy();
    if (!config) return;
    const schema = await loadConfigSchema(config);

    const payload = await buildSchemaPayload({
      schema,
      values: {
        prompt: '  runtime map array  ',
        referenceImages: [],
      },
      modelId: config.modelId,
      runtime: undefined,
    });

    expect(payload.body).toMatchObject({
      contents: [
        {
          type: 'text',
          text: 'runtime map array',
        },
        {
          type: 'image_url',
          image_url: {
            url: 'https://assets.example/cover.png',
          },
        },
        {
          type: 'marker',
          text: 'tail',
        },
      ],
    });
    expect(payload.meta).toMatchObject({
      samples: [
        {
          id: 'intro',
        },
        {
          raw: {
            id: 'cover',
            meta: {
              slot: 'left',
            },
          },
          id: 'cover',
          slot: 'left',
        },
        {
          id: 'outro',
        },
      ],
    });
  });

});
