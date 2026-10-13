// @vitest-environment node

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

const createMediaUpload = (id: string, content: string, mimeType = 'image/png') => ({
  id,
  file: new Blob([content], { type: mimeType }),
});

const readArray = (value: unknown, key: string): unknown[] => {
  const record = runtimeFixtures.isJsonRecord(value) ? value : undefined;
  const candidate = record?.[key];
  return Array.isArray(candidate) ? candidate : [];
};

describe('runtimeModelSelection.real-packages.video-advanced', () => {
  it('doubao-seedance-1-5-pro-251215 真实包已用 concat 与 map_array 生成带官方参数指令的 content 数组', async () => {
    const projection = runtimeFixtures.loadPackageProjections().find((item) => item.model_id === 'doubao-seedance-1-5-pro-251215');
    expect(projection).toBeTruthy();
    expect(projection?.runtime?.payload_rules?.['body.content']).toMatchObject({
      kind: 'compute',
      operator: 'map_array',
    });
    const contentRuleText = JSON.stringify(projection?.runtime?.payload_rules?.['body.content'] ?? {});
    // 文本块内联官方参数指令（--ratio/--rs/--dur/--fps/--wm/--seed）
    expect(contentRuleText).toContain('"operator":"concat"');
    expect(contentRuleText).toContain('--dur');
    expect(contentRuleText).toContain('--fps');
    expect(contentRuleText).toContain('"prepend"');
    expect(contentRuleText).toContain('"value":"first_frame"');
    expect(contentRuleText).toContain('"value":"last_frame"');
    expect(projection?.runtime?.payload_rules?.['meta.model']).toMatchObject({
      kind: 'compute',
      operator: 'normalize_enum',
    });

    const config = runtimeFixtures.buildSingleConfig(projection);

    const payload = (await buildPayloadFromConfig(config, {
      model: 'doubao-seedance-1-5-pro-251215',
      __prompt: '  doubao 15 asset  ',
      imageMode: 'keyframes',
      firstFrameImage: [createMediaUpload('doubao-first', 'doubao-first')],
      lastFrameImage: [createMediaUpload('doubao-last', 'doubao-last')],
      referenceImages: [],
      ratio: 'bad-ratio',
      resolution: 'bad-resolution',
      duration: 99,
      fps: 99,
      generateAudio: true,
      watermark: true,
      seed: 42,
    })) as { body?: Record<string, unknown>; meta?: Record<string, unknown> };

    const content = readArray(payload.body, 'content');
    expect(content).toHaveLength(3);
    // 文本块 = 提示词 + 归一化后的官方参数指令；非法 ratio 在 1.5 分支回退 adaptive
    expect(content[0]).toMatchObject({
      type: 'text',
      text: 'doubao 15 asset --ratio adaptive --rs 720p --dur 5 --fps 24 --wm true --seed 42',
    });
    expect(content[1]).toMatchObject({ type: 'image_url', role: 'first_frame' });
    expect(content[2]).toMatchObject({ type: 'image_url', role: 'last_frame' });
    for (const block of [content[1], content[2]]) {
      const url = runtimeFixtures.readRecordProperty(block, 'image_url')?.['url'];
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^data:/);
    }

    expect(payload.body).toMatchObject({
      model: 'doubao-seedance-1-5-pro-251215',
      generate_audio: true,
    });
    expect(payload.meta).toMatchObject({
      model: 'doubao-seedance-1-5-pro-251215',
      ratio: 'adaptive',
      resolution: '720p',
      duration: 5,
      fps: 24,
      watermark: true,
      imageMode: 'keyframes',
      seed: 42,
    });
    expect(runtimeFixtures.readOptionalString(payload, 'prompt')).toBe('doubao 15 asset');
    expect(runtimeFixtures.readOptionalString(payload, 'input')).toBe('doubao 15 asset');
  });

  it('veo-3.1-generate-preview 真实包已用纯 DSL 条件组装 instances 与 parameters', async () => {
    const projection = runtimeFixtures.loadPackageProjections().find((item) => item.model_id === 'veo-3.1-generate-preview');
    expect(projection).toBeTruthy();
    expect(projection?.runtime?.payload_rules?.['body.instances']).toMatchObject({
      kind: 'compute',
      operator: 'array',
    });
    expect(projection?.runtime?.payload_rules?.['body.parameters']).toMatchObject({
      kind: 'compute',
      operator: 'compact_object',
    });
    const instancesRuleText = JSON.stringify(projection?.runtime?.payload_rules?.['body.instances'] ?? {});
    expect(instancesRuleText).toContain('"cache_key":"veo31Standard.instance"');
    expect(instancesRuleText).toContain('"field_key":"lastFrameImage"');
    expect(instancesRuleText).toContain('"field_key":"referenceImages"');
    expect(instancesRuleText).toContain('"referenceType"');
    const parametersRuleText = JSON.stringify(projection?.runtime?.payload_rules?.['body.parameters'] ?? {});
    expect(parametersRuleText).toContain('"allowed_values":["16:9","9:16"]');

    const config = runtimeFixtures.buildSingleConfig(projection);

    const payload = (await buildPayloadFromConfig(config, {
      __prompt: '  veo preview asset  ',
      firstFrameImage: ['data:image/png;base64,RklSU1Q='],
      lastFrameImage: [],
      referenceImages: [],
      aspectRatio: 'bad-ratio',
      durationSeconds: 99,
      resolution: 'bad-resolution',
      seed: 42,
    })) as { body?: Record<string, unknown>; meta?: Record<string, unknown> };

    const instances = readArray(payload.body, 'instances');
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      prompt: 'veo preview asset',
      image: 'data:image/png;base64,RklSU1Q=',
    });
    // 未提供的媒体键不下发（when 分支返回 undefined 后被 compact_object 丢弃）
    const instance = runtimeFixtures.isJsonRecord(instances[0]) ? instances[0] : {};
    expect(instance).not.toHaveProperty('lastFrame');
    expect(instance).not.toHaveProperty('referenceImages');

    expect(payload.body?.['parameters']).toMatchObject({
      // 非法 aspectRatio/durationSeconds/resolution 回退包声明 fallback
      aspectRatio: '16:9',
      durationSeconds: '8',
      resolution: '720p',
      personGeneration: 'allow_adult',
      seed: 42,
    });
    expect(payload.meta).toMatchObject({
      model_id: 'veo-3.1-generate-preview',
      aspectRatio: 'bad-ratio',
      durationSeconds: 99,
      resolution: 'bad-resolution',
    });
    expect(runtimeFixtures.readOptionalString(payload, 'prompt')).toBe('veo preview asset');
    expect(runtimeFixtures.readOptionalString(payload, 'input')).toBe('veo preview asset');

    // 无首帧/无参考图时 instances 只保留 prompt；personGeneration 走「无人物输入」分支。
    // 包内判空用 `ne []`（空数组判定由 DSL 的 ne 承担，truthy 沿用 Boolean 语义），
    // 因此表单默认注入的空数组会被正确判定为未提供。
    const noMediaPayload = (await buildPayloadFromConfig(config, {
      __prompt: '  veo text only  ',
      firstFrameImage: [],
      lastFrameImage: [],
      referenceImages: [],
    })) as { body?: Record<string, unknown> };

    const noMediaInstances = readArray(noMediaPayload.body, 'instances');
    expect(noMediaInstances).toHaveLength(1);
    expect(noMediaInstances[0]).toMatchObject({ prompt: 'veo text only' });
    const noMediaInstance = runtimeFixtures.isJsonRecord(noMediaInstances[0])
      ? noMediaInstances[0]
      : {};
    expect(noMediaInstance).not.toHaveProperty('image');
    expect(noMediaInstance).not.toHaveProperty('lastFrame');
    expect(noMediaInstance).not.toHaveProperty('referenceImages');
    expect(noMediaPayload.body?.['parameters']).toMatchObject({
      personGeneration: 'allow_all',
    });
  });
});
