import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchemaPayload } from '@/features/workspace/schema/buildPayload';
import { createProjection, loadConfigSchema, requireProjectionRuntime } from './__tests__/fixtures/modelAssetProjectionBridgeFixtures';
import * as mediaReferenceResolverModule from '@/features/models/shared/mediaReferenceResolver';
import { buildModelConfigFromNodeProjection, buildModelConfigsFromNodeProjections } from './modelAssetProjectionBridge';
import type { ModelAssetNodeProjectionRuntimeFieldValueRule } from '@iart/contracts/model-asset-contract';

const hasImagesBody = (value: unknown): value is { images: unknown[] } =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && Array.isArray((value as { images: unknown | undefined }).images);

const runtimeFieldRule = (
  fieldKey: string,
  mediaTarget: ModelAssetNodeProjectionRuntimeFieldValueRule['media_target'] = undefined,
  transforms: ModelAssetNodeProjectionRuntimeFieldValueRule['transforms'] = undefined,
): ModelAssetNodeProjectionRuntimeFieldValueRule => ({
  kind: 'field',
  field_key: fieldKey,
  media_target: mediaTarget,
  multipart_array_naming: undefined,
  transforms,
  fallback: undefined,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('modelAssetProjectionBridge.runtime-media', () => {
  it('qwen_image 资产仍走 backend formal task adapter 统一主链', () => {
    const projection = createProjection({
      model_id: 'qwen-image-max',
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        execution_driver: 'http_formal_task',
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(typeof (config !== null && config !== undefined ? config.adapter.generate : undefined)).toBe('function');
  });

  it('支持 WAN 专用音频上传 DSL（prepare_audio_url / resolve_auto_audio_flag）', async () => {
    const audioBlob = new Blob(['audio-bytes'], { type: 'audio/mpeg' });
    const resolveAllMediaItemsSpy = vi
      .spyOn(mediaReferenceResolverModule, 'resolveAllNormalizedMediaReferences')
      .mockResolvedValue({
        items: [
        {
          id: undefined,
          file: audioBlob,
          url: undefined,
          mimeType: 'audio/mpeg',
          isObjectUrl: undefined,
          target: 'upload-file',
          meta: {
            id: undefined,
            sourceKind: 'file',
            url: undefined,
            mimeType: 'audio/mpeg',
            sizeBytes: undefined,
            hash: undefined,
            base64Bytes: undefined,
          },
        },
      ],
        errors: [],
      });

    vi.stubGlobal(
      'Audio',
      class MockAudio {
        preload = '';
        duration = 6;
        private listeners: Record<string, () => void> = {};

        addEventListener(event: string, callback: () => void) {
          this.listeners[event] = callback;
        }

        removeEventListener(event: string) {
          delete this.listeners[event];
        }

        set src(_value: string) {
          queueMicrotask(() => {
            const listener = this.listeners['loadedmetadata'];
            if (listener !== undefined) {
              listener();
            }
          });
        }
      },
    );
    const createObjectURLSpy = vi.fn(() => 'blob:audio');
    const revokeObjectURLSpy = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURLSpy,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURLSpy,
    });

    const projection = createProjection({
      parameter_schema: {
        schema_type: 'object',
        fields: [
          {
            field_key: 'audio',
            label: '音频',
            component: 'file',
            data_source: 'form',
            required: false,
            default_value: [],
          },
          {
            field_key: 'autoAudio',
            label: '自动音频',
            component: 'switch',
            data_source: 'form',
            required: false,
            default_value: true,
          },
        ],
        required_fields: [],
        default_values: {
          audio: [],
          autoAudio: true,
        },
        validation_rules: [],
      },
      runtime: {
        ...requireProjectionRuntime(createProjection()),
        url_input_upload_mode: 'public_relay',
        url_input_upload_target_type: 'cloudflare_image_public_url',
        payload_rules: {
          'body.input.audio_url': {
            kind: 'compute',
            operator: 'prepare_audio_url',
            media_target: 'public_url',
            multipart_array_naming: undefined,
            cache_key: undefined,
            options: {
              source: runtimeFieldRule('audio'),
              allowed_mime_types: ['audio/mpeg', 'audio/wav', 'audio/x-wav'],
              allowed_extensions: ['mp3', 'wav'],
              max_size_bytes: 15 * 1024 * 1024,
              min_duration_seconds: 3,
              max_duration_seconds: 30,
            },
          },
          'body.parameters.audio': {
            kind: 'compute',
            operator: 'resolve_auto_audio_flag',
            media_target: undefined,
            multipart_array_naming: undefined,
            cache_key: undefined,
            options: {
              audio_source: runtimeFieldRule('audio'),
              auto_audio: runtimeFieldRule('autoAudio'),
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
        audio: [audioBlob],
        autoAudio: true,
      },
      modelId: config.modelId,
      runtime: undefined,
    });

    const body = payload.body as {
      input: { audio_url: unknown | undefined } | undefined;
      parameters: { audio: unknown | undefined } | undefined;
    };
    const audioUrl = body.input !== undefined ? body.input.audio_url : undefined;
    // 媒体文件原样穿透 payload（File 对象），提交时由 taskFacade 归一化为 media_inputs
    expect(audioUrl).toBeInstanceOf(File);
    expect((audioUrl as File).type).toBe('audio/mpeg');
    expect(body.parameters !== undefined ? body.parameters.audio : undefined).toBe(false);
    expect(resolveAllMediaItemsSpy).toHaveBeenCalledWith(
      [
        {
          source: {
            type: 'file',
            file: audioBlob,
          },
        },
      ],
      'upload-file',
    );
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);

    await expect(
      buildSchemaPayload({
        schema,
        values: {
          audio: ['ftp://example.com/source.mp3'],
          autoAudio: true,
        },
        modelId: config.modelId,
        runtime: undefined,
      }),
    ).rejects.toThrow('这个音频地址无法读取，请改用本机文件或 https 开头的地址。');
  });

  it('单条坏投影不会阻断其余投影映射', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformed: unknown = {
      ...createProjection(),
      parameter_schema: {
        schema_type: 'object',
        fields: null,
        required_fields: [],
        default_values: {},
        validation_rules: [],
      },
    };

    const configs = buildModelConfigsFromNodeProjections([malformed, createProjection()]);

    expect(configs).toHaveLength(1);
    const firstConfig = configs[0];
    expect(firstConfig !== undefined ? firstConfig.modelId : undefined).toBe('z-image-turbo');
    expect(warnSpy).toHaveBeenCalledWith(
      '[model-asset] projection dropped',
      expect.objectContaining({
        reason: 'projection_invalid',
        modelId: 'z-image-turbo',
      }),
    );
    warnSpy.mockRestore();
  });

  it('projection 为 null 时应丢弃并继续映射其余投影', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const configs = buildModelConfigsFromNodeProjections([null, createProjection()]);

    expect(configs).toHaveLength(1);
    const firstConfig = configs[0];
    expect(firstConfig !== undefined ? firstConfig.modelId : undefined).toBe('z-image-turbo');
    expect(warnSpy).toHaveBeenCalledWith(
      '[model-asset] projection dropped',
      expect.objectContaining({
        reason: 'projection_invalid',
        error: 'projection must be a non-null object',
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[model-asset] projection mapping summary',
      expect.objectContaining({ total: 2, mapped: 1, dropped: 1 }),
    );
    warnSpy.mockRestore();
  });

  it.each([
    ['cloudflare_image_public_url'],
    ['self_hosted_image_public_url'],
  ])('runtime.url_input_upload_mode 与 target_type=%s 下媒体原样穿透 payload，不在 buildPayload 阶段上传', async (targetType) => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, url: 'https://backend-owned.example/ref.png' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const baseProjection = createProjection();
    const projection = createProjection({
      parameter_schema: {
        ...baseProjection.parameter_schema,
        fields: [
          ...baseProjection.parameter_schema.fields,
          {
            field_key: 'images',
            label: '参考图',
            component: 'textarea',
            data_source: 'form',
            required: false,
            default_value: [],
          },
        ],
        default_values: {
          ...baseProjection.parameter_schema.default_values,
          images: [],
        },
      },
      runtime: {
        ...requireProjectionRuntime(baseProjection),
        url_input_upload_mode: 'public_relay',
        url_input_upload_target_type: targetType as 'cloudflare_image_public_url' | 'self_hosted_image_public_url',
        payload_rules: {
          'body.images': runtimeFieldRule('images', 'public_url', ['extractUrls']),
        },
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config).toBeTruthy();
    if (!config) return;
    const schema = await loadConfigSchema(config);
    const file = new File(['hello'], 'ref.png', { type: 'image/png' });

    const payload = await buildSchemaPayload({
      schema,
      values: {
        prompt: '',
        size: '1536x1536',
        images: [{ id: 'f1', file }],
      },
      modelId: config.modelId,
      runtime: undefined,
    });

    if (!hasImagesBody(payload.body)) {
      throw new Error('missing_images_body');
    }
    // 媒体原样穿透 payload（非 URL 字符串），提交时由 taskFacade 归一化为 media_inputs
    const firstImage: unknown = payload.body.images[0];
    expect(typeof firstImage).toBe('object');
    expect(firstImage).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('未显式声明 extractUrls / extractFirstUrl transform 时不会自动触发上传', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const file = new File(['hello'], 'ref.png', { type: 'image/png' });
    const baseProjection = createProjection();
    const projection = createProjection({
      parameter_schema: {
        ...baseProjection.parameter_schema,
        fields: [
          ...baseProjection.parameter_schema.fields,
          {
            field_key: 'images',
            label: '参考图',
            component: 'textarea',
            data_source: 'form',
            required: false,
            default_value: [],
          },
        ],
        default_values: {
          ...baseProjection.parameter_schema.default_values,
          images: [],
        },
      },
      runtime: {
        ...requireProjectionRuntime(baseProjection),
        url_input_upload_mode: 'public_relay',
        url_input_upload_target_type: 'cloudflare_image_public_url',
        payload_rules: {
          'body.images': runtimeFieldRule('images'),
        },
      },
    });

    const config = buildModelConfigFromNodeProjection(projection);
    expect(config).toBeTruthy();
    if (!config) return;
    const schema = await loadConfigSchema(config);

    await buildSchemaPayload({
      schema,
      values: {
        prompt: '',
        size: '1536x1536',
        images: [{ id: 'f1', file }],
      },
      modelId: config.modelId,
      runtime: undefined,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
