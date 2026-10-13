// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPayloadFromConfig } from '@/features/workspace/modelFormAdapter';
import * as runtimeFixtures from './__tests__/fixtures/runtimeModelSelectionRealPackagesFixtures';
import { setRuntimeProjectedModels } from './models.config';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ success: true, url: 'https://backend-owned.example/runtime-input.png' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })),
  );
});

afterEach(() => {
  setRuntimeProjectedModels([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const expectDataUrl = (value: unknown): string => {
  expect(typeof value).toBe('string');
  if (typeof value !== 'string') {
    throw new Error('missing_data_url');
  }
  expect(value).toMatch(/^data:/);
  return value;
};

const loadInstalledRuntimeModel = (packageId: string): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), '.model-assets', 'packages', packageId, 'runtime_model.json'),
      'utf-8',
    ),
  ) as Record<string, unknown>;

const readRecord = (value: unknown, key: string): Record<string, unknown> | undefined =>
  runtimeFixtures.readRecordProperty(value, key);

const readNestedUrl = (value: unknown, key: string): unknown =>
  readRecord(value, key)?.['url'];

const readArray = (value: unknown, key: string): unknown[] => {
  const record = runtimeFixtures.isJsonRecord(value) ? value : undefined;
  const candidate = record?.[key];
  return Array.isArray(candidate) ? candidate : [];
};

const createMediaUpload = (id: string, content: string, mimeType = 'image/png') => ({
  id,
  file: new Blob([content], { type: mimeType }),
});

describe('runtimeModelSelection.real-packages.video', () => {
  it('当前视频真实资产包已退出 legacy_schema_compute', () => {
    const projections = runtimeFixtures.loadPackageProjections();
    const packageIds = [
      'doubao-seedance-1-5-pro-251215',
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-fast-260128',
      'doubao-seedance-2-0-mini-260615',
      'kling-v3-image2video',
      'kling-v3-omni-video',
      'kling-v3-text2video',
      'veo-3.1-fast-generate-preview',
      'veo-3.1-generate-preview',
      'veo-3.1-lite-generate-preview',
    ];

    packageIds.forEach((packageId) => {
      const projection = projections.find((item) => item.model_id === packageId);
      expect(projection).toBeTruthy();
      expect(JSON.stringify(projection?.runtime?.payload_rules ?? {})).not.toContain('legacy_schema_compute');
    });
  });

  it('doubao-seedance-2-0-260128 真实包已用 extractUrls 与 map_array 组装官方 content 数组', async () => {
    const projection = runtimeFixtures.loadPackageProjections().find((item) => item.model_id === 'doubao-seedance-2-0-260128');
    expect(projection).toBeTruthy();
    expect(projection?.runtime?.payload_rules?.['body.content']).toMatchObject({
      kind: 'compute',
      operator: 'map_array',
    });
    const contentRuleText = JSON.stringify(projection?.runtime?.payload_rules?.['body.content'] ?? {});
    expect(contentRuleText).toContain('"transforms":["extractUrls"]');
    expect(contentRuleText).toContain('"media_target":"public_url"');
    expect(contentRuleText).toContain('"prepend"');
    expect(projection?.runtime?.payload_rules?.['meta.input_mode']).toMatchObject({
      kind: 'field',
      field_key: 'input_mode',
    });

    const config = runtimeFixtures.buildSingleConfig(projection);

    const payload = (await buildPayloadFromConfig(config, {
      __prompt: '  doubao package  ',
      input_mode: 'reference',
      reference_images: [
        createMediaUpload('doubao-image-1', 'doubao-image-1'),
        createMediaUpload('doubao-image-2', 'doubao-image-2', 'image/jpeg'),
      ],
      reference_videos: [createMediaUpload('doubao-video-1', 'doubao-video-1', 'video/mp4')],
      reference_audios: [],
      resolution: 'bad-resolution',
      ratio: 'bad-ratio',
      duration: 99,
      generate_audio: true,
      return_last_frame: true,
      watermark: true,
      seed: 7,
    })) as { body?: Record<string, unknown>; meta?: Record<string, unknown> };

    const content = readArray(payload.body, 'content');
    expect(content).toHaveLength(4);
    expect(content[0]).toMatchObject({ type: 'text', text: 'doubao package' });
    expect(content[1]).toMatchObject({ type: 'image_url', role: 'reference_image' });
    expectDataUrl(readNestedUrl(content[1], 'image_url'));
    expect(content[2]).toMatchObject({ type: 'image_url', role: 'reference_image' });
    expectDataUrl(readNestedUrl(content[2], 'image_url'));
    expect(content[3]).toMatchObject({ type: 'video_url', role: 'reference_video' });
    expectDataUrl(readNestedUrl(content[3], 'video_url'));

    expect(payload.body).toMatchObject({
      model: 'doubao-seedance-2-0-260128',
      // 非法 resolution/ratio/duration 回退包声明 fallback
      resolution: '720p',
      ratio: 'adaptive',
      duration: 5,
      generate_audio: true,
      return_last_frame: true,
      watermark: true,
      seed: 7,
    });
    expect(payload.meta).toMatchObject({
      model_id: 'doubao-seedance-2-0-260128',
      input_mode: 'reference',
      resolution: '720p',
      ratio: 'adaptive',
      duration: 5,
      generate_audio: true,
      return_last_frame: true,
      watermark: true,
      seed: 7,
    });
    expect(runtimeFixtures.readOptionalString(payload, 'prompt')).toBe('doubao package');
    expect(runtimeFixtures.readOptionalString(payload, 'input')).toBe('doubao package');
  });

  it('gemini-2.5-pro-preview-tts 真实包已用纯 DSL 生成多角色 speechConfig 与动态 endpoint', async () => {
    const projection = runtimeFixtures.loadPackageProjections().find((item) => item.model_id === 'gemini-2.5-pro-preview-tts');
    expect(projection).toBeTruthy();
    expect(projection?.runtime?.payload_rules?.['api.endpoint']).toMatchObject({
      kind: 'compute',
      operator: 'concat',
    });
    expect(projection?.runtime?.payload_rules?.['body.contents']).toMatchObject({
      kind: 'compute',
      operator: 'build_content_blocks',
    });
    expect(projection?.runtime?.payload_rules?.['body.generationConfig.speechConfig']).toMatchObject({
      kind: 'when',
    });

    const config = runtimeFixtures.buildSingleConfig(projection);

    const payload = await buildPayloadFromConfig(config, {
      model: 'gemini-2.5-pro-preview-tts',
      mode: 'multi',
      text: '  hello speakers  ',
      speakerVoiceLines: 'Joe|Kore\nJane|Puck',
    });

    expect(payload.api).toMatchObject({
      endpoint: '/v1beta/models/gemini-2.5-pro-preview-tts:generateContent',
      method: 'POST',
    });
    expect(payload.body).toMatchObject({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello speakers' }],
        },
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: 'Joe',
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: 'Kore',
                  },
                },
              },
              {
                speaker: 'Jane',
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: 'Puck',
                  },
                },
              },
            ],
          },
        },
      },
    });
    expect(payload.meta).toMatchObject({
      model: 'gemini-2.5-pro-preview-tts',
      mode: 'multi',
      model_id: 'gemini-tts',
    });
    expect(runtimeFixtures.readOptionalString(payload, 'prompt')).toBe('hello speakers');
    expect(runtimeFixtures.readOptionalString(payload, 'input')).toBe('hello speakers');
  });

  it('gemini-2.5-pro-preview-tts 真实包在单说话者缺 voiceName 时应阻断', async () => {
    const projection = runtimeFixtures.loadPackageProjections().find((item) => item.model_id === 'gemini-2.5-pro-preview-tts');
    expect(projection).toBeTruthy();

    const config = runtimeFixtures.buildSingleConfig(projection);

    await expect(
      buildPayloadFromConfig(config, {
        mode: 'single',
        text: '  say it  ',
        voiceName: '   ',
      }),
    ).rejects.toThrow('单人配音需要填写声音名。');
  });

  it('kling-v3-omni-video 真实包已用纯 DSL 生成多分支 contents 与归一化 settings', async () => {
    const projection = runtimeFixtures.loadPackageProjections().find((item) => item.model_id === 'kling-v3-omni-video');
    expect(projection).toBeTruthy();
    expect(projection?.runtime?.payload_rules?.['body.contents']).toMatchObject({
      kind: 'compute',
      operator: 'compact_array',
    });
    expect(projection?.runtime?.payload_rules?.['body.settings.aspect_ratio']).toMatchObject({
      kind: 'compute',
      operator: 'normalize_enum',
    });
    expect(projection?.runtime?.payload_rules?.['meta.taskType']).toMatchObject({
      kind: 'literal',
      value: 'omniVideo',
    });
    const contentsRuleText = JSON.stringify(projection?.runtime?.payload_rules?.['body.contents'] ?? {});
    expect(contentsRuleText).toContain('"value":"refer_image"');
    expect(contentsRuleText).toContain('"value":"feature_video"');
    expect(contentsRuleText).toContain('"value":"base_video"');

    const config = runtimeFixtures.buildSingleConfig(projection);

    const payload = (await buildPayloadFromConfig(config, {
      __prompt: '  kling omni asset  ',
      firstFrameImage: [createMediaUpload('omni-first', 'omni-first')],
      lastFrameImage: [createMediaUpload('omni-last', 'omni-last')],
      referImage: [createMediaUpload('omni-refer', 'omni-refer')],
      featureVideo: [createMediaUpload('omni-feature', 'omni-feature', 'video/mp4')],
      baseVideo: [createMediaUpload('omni-base', 'omni-base', 'video/mp4')],
      duration: 99,
      resolution: 'bad-resolution',
      aspectRatio: 'bad-ratio',
      audio: 'bad-audio',
      multiShot: false,
      watermark: true,
    })) as { body?: Record<string, unknown>; meta?: Record<string, unknown> };

    const contents = readArray(payload.body, 'contents');
    expect(contents).toHaveLength(6);
    expect(contents[0]).toMatchObject({ type: 'prompt', text: 'kling omni asset' });
    expect(contents[1]).toMatchObject({ type: 'first_frame' });
    expect(contents[2]).toMatchObject({ type: 'last_frame' });
    expect(contents[3]).toMatchObject({ type: 'refer_image' });
    expect(contents[4]).toMatchObject({ type: 'feature_video' });
    expect(contents[5]).toMatchObject({ type: 'base_video' });
    for (const block of [contents[1], contents[2], contents[3], contents[4], contents[5]]) {
      expectDataUrl(runtimeFixtures.readOptionalString(block, 'url'));
    }

    expect(payload.body).toMatchObject({
      settings: {
        multi_shot: false,
        // 非法枚举值回退包声明 fallback
        audio: 'off',
        resolution: '720p',
        aspect_ratio: '16:9',
        duration: 5,
      },
      options: {
        watermark_info: {
          enabled: true,
        },
      },
    });
    expect(payload.meta).toMatchObject({
      taskType: 'omniVideo',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      audio: 'off',
    });
    expect(runtimeFixtures.readOptionalString(payload, 'prompt')).toBe('kling omni asset');
    expect(runtimeFixtures.readOptionalString(payload, 'input')).toBe('kling omni asset');
  });

  it('kling-v3-omni-video 真实包缺提示词时应阻断，而不是静默降级', async () => {
    const projection = runtimeFixtures.loadPackageProjections().find((item) => item.model_id === 'kling-v3-omni-video');
    expect(projection).toBeTruthy();

    const config = runtimeFixtures.buildSingleConfig(projection);

    await expect(
      buildPayloadFromConfig(config, {
        __prompt: '   ',
        firstFrameImage: [createMediaUpload('omni-first', 'omni-first')],
      }),
    ).rejects.toThrow('请填写提示词。');
  });

  it('kling-v3-text2video 真实包生成固定 kling-v3 文生视频 payload', async () => {
    const projection = runtimeFixtures.loadPackageProjections().find((item) => item.model_id === 'kling-v3-text2video');
    expect(projection).toBeTruthy();
    expect(projection?.runtime?.payload_rules?.['body.settings.aspect_ratio']).toMatchObject({
      kind: 'compute',
      operator: 'normalize_enum',
    });
    expect(projection?.runtime?.payload_rules?.['body.settings.audio']).toMatchObject({
      kind: 'compute',
      operator: 'normalize_enum',
    });
    expect(projection?.runtime?.payload_rules?.['body.options.watermark_info.enabled']).toMatchObject({
      kind: 'when',
      condition: { op: 'truthy', field: 'watermark' },
    });
    const runtimeModel = loadInstalledRuntimeModel('kling-v3-text2video');
    expect(readRecord(runtimeModel, 'result_rule')).toMatchObject({
      mode: 'async',
      submit_response_id_path: '/data/id',
    });
    expect(readRecord(readRecord(runtimeModel, 'polling_strategy'), 'request')).toMatchObject({
      url_template: '/tasks?task_ids={id}',
      method: 'GET',
    });
    const config = runtimeFixtures.buildSingleConfig(projection);

    const payload = await buildPayloadFromConfig(config, {
      __prompt: '  kling v3 text  ',
      duration: 'bad-duration',
      resolution: 'bad-resolution',
      aspectRatio: 'bad-ratio',
      audio: 'bad-audio',
      multiShot: false,
      watermark: true,
    });

    expect(payload.api).toMatchObject({
      endpoint: '/text-to-video/kling-3.0',
      method: 'POST',
      responseHandling: { mode: 'async' },
    });
    expect(payload.body).toMatchObject({
      prompt: 'kling v3 text',
      settings: {
        multi_shot: false,
        audio: 'off',
        resolution: '720p',
        aspect_ratio: '16:9',
        duration: 5,
      },
      options: {
        watermark_info: {
          enabled: true,
        },
      },
    });
    expect(payload.meta).toMatchObject({
      taskType: 'text2video',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      audio: 'off',
    });
    expect(runtimeFixtures.readOptionalString(payload, 'prompt')).toBe('kling v3 text');
    expect(runtimeFixtures.readOptionalString(payload, 'input')).toBe('kling v3 text');

    await expect(
      buildPayloadFromConfig(config, { __prompt: '   ' }),
    ).rejects.toThrow('请填写提示词。');
  });

  it('kling-v3-image2video 真实包生成正式首帧/尾帧端口与 public relay payload', async () => {
    const projection = runtimeFixtures.loadPackageProjections().find((item) => item.model_id === 'kling-v3-image2video');
    expect(projection).toBeTruthy();
    expect(projection?.ports.inputs.map((port) => port.id)).toEqual(['firstFrameImage', 'lastFrameImage']);
    expect(projection?.ports.inputs.find((port) => port.id === 'firstFrameImage')).toMatchObject({
      data_type: 'image',
      field_key: 'firstFrameImage',
      required: true,
      multiple: false,
      max_connections: 1,
    });
    expect(projection?.ports.inputs.find((port) => port.id === 'lastFrameImage')).toMatchObject({
      data_type: 'image',
      field_key: 'lastFrameImage',
      required: false,
      multiple: false,
      max_connections: 1,
    });
    expect(projection?.runtime?.payload_rules?.['body.contents']).toMatchObject({
      kind: 'compute',
      operator: 'compact_array',
    });
    const contentsRuleText = JSON.stringify(projection?.runtime?.payload_rules?.['body.contents'] ?? {});
    expect(contentsRuleText).toContain('"operator":"assert_non_empty"');
    expect(contentsRuleText).toContain('"value":"first_frame"');
    expect(contentsRuleText).toContain('"value":"last_frame"');
    const runtimeModel = loadInstalledRuntimeModel('kling-v3-image2video');
    expect(readRecord(runtimeModel, 'result_rule')).toMatchObject({
      mode: 'async',
      submit_response_id_path: '/data/id',
    });
    expect(readRecord(readRecord(runtimeModel, 'polling_strategy'), 'request')).toMatchObject({
      url_template: '/tasks?task_ids={id}',
      method: 'GET',
    });
    const config = runtimeFixtures.buildSingleConfig(projection);

    const payload = await buildPayloadFromConfig(config, {
      __prompt: '  kling v3 image  ',
      firstFrameImage: [createMediaUpload('kling-v3-first', 'kling-v3-first')],
      lastFrameImage: [createMediaUpload('kling-v3-last', 'kling-v3-last')],
      duration: 'bad-duration',
      resolution: 'bad-resolution',
      audio: 'bad-audio',
      multiShot: false,
      watermark: true,
    });

    expect(payload.api).toMatchObject({
      endpoint: '/image-to-video/kling-3.0',
      method: 'POST',
      responseHandling: { mode: 'async' },
    });
    const contents = readArray(payload.body, 'contents');
    expect(contents).toHaveLength(3);
    expect(contents[0]).toMatchObject({ type: 'prompt', text: 'kling v3 image' });
    expect(contents[1]).toMatchObject({ type: 'first_frame' });
    expect(contents[2]).toMatchObject({ type: 'last_frame' });
    // 前端直接传递 data URL（public relay 由后端识别并上传），此处媒体引用为 data URL
    expectDataUrl(runtimeFixtures.readOptionalString(contents[1], 'url'));
    expectDataUrl(runtimeFixtures.readOptionalString(contents[2], 'url'));
    expect(payload.body).toMatchObject({
      settings: {
        multi_shot: false,
        audio: 'off',
        resolution: '720p',
        duration: 5,
      },
      options: {
        watermark_info: {
          enabled: true,
        },
      },
    });
    expect(payload.meta).toMatchObject({
      taskType: 'image2video',
      duration: 5,
      resolution: '720p',
      audio: 'off',
    });
    expect(runtimeFixtures.readOptionalString(payload, 'prompt')).toBe('kling v3 image');
    expect(runtimeFixtures.readOptionalString(payload, 'input')).toBe('kling v3 image');

    // 未提供尾帧时不得产出无 url 的 last_frame 块（判空用 ne []，空数组视为未提供）。
    const firstFrameOnlyPayload = await buildPayloadFromConfig(config, {
      __prompt: '  kling v3 image  ',
      firstFrameImage: [createMediaUpload('kling-v3-first', 'kling-v3-first')],
      lastFrameImage: [],
    });
    const firstFrameOnlyContents = readArray(firstFrameOnlyPayload.body, 'contents');
    expect(firstFrameOnlyContents).toHaveLength(2);
    expect(firstFrameOnlyContents[1]).toMatchObject({ type: 'first_frame' });
    expect(JSON.stringify(firstFrameOnlyPayload.body)).not.toContain('last_frame');

    await expect(
      buildPayloadFromConfig(config, { __prompt: 'x', firstFrameImage: [] }),
    ).rejects.toThrow('请上传首帧图。');
  });

});
