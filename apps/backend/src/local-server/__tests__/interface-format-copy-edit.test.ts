import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CustomInterfaceFormatCopyResponseSchema,
  CustomInterfaceFormatDraftSchema,
  CustomInterfaceFormatWriteResponseSchema,
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  InterfaceRecipeListResponseSchema,
  type CustomInterfaceFormatDraft,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import { loadPresetFormats } from '../interface-format/registry.cts';
import { buildInterfaceFormatFromDraft } from '../interface-format/draft-synthesis.cts';
import { composeInterfaceFormatSources } from '../interface-format/compose.cts';
import { mergeInterfaceFormatDraft } from '../interface-format/draft-merge.cts';
import {
  buildCopiedInterfaceFormat,
  buildCopiedInterfaceFormatName,
  deriveRecipeFromBuiltinBehavior,
} from '../interface-format/copy.cts';
import { InterfaceFormatSchema, type InterfaceFormat } from '../interface-format/schema.cts';
import { clearCacheForTest as clearInterfaceFormatCache } from '../provider-connection/interface-format-store.cts';
import { clearCacheForTest as clearInterfaceRecipeCache } from '../provider-connection/interface-recipe-store.cts';
import { clearCacheForTest as clearCustomGenerationModelCache } from '../provider-connection/custom-generation-model-store.cts';
import { clearCacheForTest as clearCustomChatModelCache } from '../provider-connection/custom-chat-model-store.cts';
import { clearCacheForTest as clearConnectionCache } from '../provider-connection/connection-store.cts';

/**
 * 复制与编辑保真（2026-10-27 批次）。
 *
 * 覆盖：
 * ① 复制是整实体克隆：8 个预设逐字段等价（只改 id / 显示名 / origin / status / order）；
 * ② openai-image 复制后编辑一个普通参数：generations / edits 两个端点、body.image 条件分支、
 *    Accept 固定头、meta / 顶层回显等表单表达不到的规则全部仍在，且合成能真实跑通；
 * ③ 保留规则引用被删除的字段、或与表单规则写到同一个位置时，保存返回可读错误；
 * ④ 复制路由：预设复制返回 recipe_id（可派生时）或 null；用户格式复制其绑定配方。
 */

type JsonRecord = Record<string, unknown>;

const OPENAI_IMAGE_ID = 'openai-image-v1';

/** 去掉身份字段后的实体（复制等价比较用）。 */
const withoutIdentity = (format: InterfaceFormat): Record<string, unknown> => {
  const rest: Record<string, unknown> = { ...format };
  for (const key of ['format_id', 'display_name', 'origin', 'status', 'order'] as const) {
    delete rest[key];
  }
  return rest;
};

void test('复制：8 个预设逐字段克隆，只改身份字段', () => {
  const presets = loadPresetFormats();
  assert.equal(presets.length, 8);
  for (const preset of presets) {
    const clone = buildCopiedInterfaceFormat(preset, { format_id: 'if_clone_test', order: 1000 });
    assert.equal(clone.format_id, 'if_clone_test');
    assert.equal(clone.display_name, buildCopiedInterfaceFormatName(preset.display_name));
    assert.equal(clone.origin, 'user');
    assert.equal(clone.status, 'ready');
    assert.equal(clone.order, 1000);
    assert.deepEqual(withoutIdentity(clone), withoutIdentity(preset), `${preset.format_id} 的克隆必须逐字段等价`);
    assert.doesNotThrow(() => InterfaceFormatSchema.parse(clone));
  }
});

void test('复制：显示名超长时截断原名，始终保留「副本」后缀', () => {
  const longName = '很长的接口格式名称'.repeat(12);
  const name = buildCopiedInterfaceFormatName(longName);
  assert.ok(name.endsWith(' 副本'));
  assert.ok(name.length <= 80);
});

const openAiImageDraft = (overrides: Partial<JsonRecord> = {}): JsonRecord => ({
  display_name: '我的图像接口',
  submit: {
    path: '/v1/images/generations',
    method: 'POST',
    payload_format: 'json',
    content_type: 'application/json',
    auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
    headers: [{ name: 'Accept', value: 'application/json' }],
    query: [],
    form_field_style: 'dotted',
    form_array_style: 'repeat',
  },
  model_binding: { location: 'body', path: 'model' },
  parameters: [
    { binding: { location: 'body', path: 'size' }, label: '画面尺寸', type: 'string' },
    { binding: { location: 'body', path: 'quality' }, label: '画质', type: 'string' },
    { binding: { location: 'body', path: 'output_format' }, label: '图片格式', type: 'string' },
    { binding: { location: 'body', path: 'moderation' }, label: '内容审核', type: 'string' },
  ],
  media_slots: [
    {
      slot_id: 'reference_image',
      field_key: 'image',
      label: '参考图',
      required: false,
      max_files: 16,
      carrier: 'public_url',
    },
  ],
  prompt_binding: { location: 'body', path: 'prompt' },
  behavior: {
    result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
  },
  ...overrides,
});

const parseDraft = (body: JsonRecord): CustomInterfaceFormatDraft => {
  const parsed = CustomInterfaceFormatDraftSchema.safeParse(body);
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message);
  if (!parsed.success) throw new Error('unreachable');
  return parsed.data;
};

const copyOpenAiImage = (): InterfaceFormat => {
  const preset = loadPresetFormats().find((item) => item.format_id === OPENAI_IMAGE_ID);
  assert.ok(preset);
  return buildCopiedInterfaceFormat(preset, { format_id: 'if_openai_image_copy', order: 100 });
};

void test('编辑保真：复制 openai-image 后改一个普通参数，条件端点/条件请求体/固定头仍在', () => {
  const copied = copyOpenAiImage();
  const sourceRules = copied.transport.payload_rules;
  const draft = parseDraft(
    openAiImageDraft({
      parameters: [
        { binding: { location: 'body', path: 'size' }, label: '画面尺寸', type: 'string' },
        { binding: { location: 'body', path: 'quality' }, label: '生成质量', type: 'string' },
        { binding: { location: 'body', path: 'output_format' }, label: '图片格式', type: 'string' },
        { binding: { location: 'body', path: 'moderation' }, label: '内容审核', type: 'string' },
      ],
    }),
  );
  const synthesized = buildInterfaceFormatFromDraft(draft, { format_id: copied.format_id, order: copied.order });
  const merged = mergeInterfaceFormatDraft({ existing: copied, draft, synthesized });
  assert.equal(merged.ok, true, merged.ok ? undefined : merged.errors.join(' | '));
  if (!merged.ok) return;

  const format = merged.format;
  // 两个端点都在（复制保真的核心断言）。
  assert.equal(format.transport.endpoints['generations'], '/v1/images/generations');
  assert.equal(format.transport.endpoints['edits'], '/v1/images/edits');
  // 条件端点分支、条件请求体分支、固定头原样保留。
  assert.deepEqual(format.transport.payload_rules['api.endpoint'], sourceRules['api.endpoint']);
  assert.deepEqual(format.transport.payload_rules['api.contentType'], sourceRules['api.contentType']);
  assert.deepEqual(format.transport.payload_rules['body.image'], sourceRules['body.image']);
  assert.deepEqual(format.transport.payload_rules['api.headers.Accept'], { kind: 'literal', value: 'application/json' });
  // 表单表达不到的规则原样保留。
  assert.deepEqual(format.transport.payload_rules['body.n'], sourceRules['body.n']);
  assert.deepEqual(format.transport.payload_rules['prompt'], sourceRules['prompt']);
  assert.deepEqual(format.transport.payload_rules['input'], sourceRules['input']);
  assert.deepEqual(format.transport.payload_rules['meta.size'], sourceRules['meta.size']);
  assert.deepEqual(format.transport.payload_rules['meta.model_id'], sourceRules['meta.model_id']);
  // 提交响应里的任务标识路径也是表单表达不到的，编辑后保留。
  assert.equal(format.transport.submit.response_id_path, '/id');
  // 参数身份复用旧字段键（保留规则 meta.size 的引用仍然有效）。
  const fields = format.parameters.schema.fields;
  assert.ok(Array.isArray(fields));
  const quality = fields.find((field) => {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) return false;
    return (field as JsonRecord)['field_key'] === 'quality';
  });
  assert.ok(quality, 'quality 参数的内部键必须复用源格式的键');
  // 表单修改生效：显示名更新（文案由草稿生成）。
  const zh = format.localization['zh-CN'];
  assert.equal(JSON.stringify(zh).includes('生成质量'), true);

  // 合成实跑：占位符（含保留规则里的 {{endpoint:edits}}）都能解析，没有声明期残留。
  const sources = composeInterfaceFormatSources({
    format,
    modelId: 'edited-copy-model',
    acceptedMediaSlots: ['reference_image'],
  });
  const serialized = JSON.stringify(sources);
  assert.equal(serialized.includes('{{'), false, '保留规则引用的其它端点键必须仍能解析');
  assert.equal(serialized.includes('/v1/images/edits'), true);
});

void test('编辑保真：删除素材位会让保留的条件规则悬空 → 可读拒绝', () => {
  const copied = copyOpenAiImage();
  const draft = parseDraft(openAiImageDraft({ media_slots: [] }));
  const synthesized = buildInterfaceFormatFromDraft(draft, { format_id: copied.format_id, order: copied.order });
  const merged = mergeInterfaceFormatDraft({ existing: copied, draft, synthesized });
  assert.equal(merged.ok, false);
  if (merged.ok) return;
  assert.ok(merged.errors.length > 0);
  assert.match(merged.errors.join(' '), /请求规则/);
});

void test('编辑保真：保留规则与表单规则写到同一个位置 → 可读拒绝', () => {
  const copied = copyOpenAiImage();
  // 模拟磁盘上存在一条「复杂规则」，它的位置是表单参数 body.size 的子路径。
  const conflictingExisting: InterfaceFormat = {
    ...copied,
    transport: {
      ...copied.transport,
      payload_rules: {
        ...copied.transport.payload_rules,
        'body.size.nested': {
          kind: 'when',
          condition: { op: 'truthy', field: 'quality' },
          truthy: { kind: 'literal', value: 1 },
        },
      },
    },
  };
  assert.doesNotThrow(() => InterfaceFormatSchema.parse(conflictingExisting));
  const draft = parseDraft(openAiImageDraft());
  const synthesized = buildInterfaceFormatFromDraft(draft, {
    format_id: conflictingExisting.format_id,
    order: conflictingExisting.order,
  });
  const merged = mergeInterfaceFormatDraft({ existing: conflictingExisting, draft, synthesized });
  assert.equal(merged.ok, false);
  if (merged.ok) return;
  assert.match(merged.errors.join(' '), /同一个位置/);
});

void test('编辑保真：固定请求头已被条件规则控制时，表单固定值被拒（不静默忽略）', () => {
  const copied = copyOpenAiImage();
  const conflictingExisting: InterfaceFormat = {
    ...copied,
    transport: {
      ...copied.transport,
      payload_rules: {
        ...copied.transport.payload_rules,
        'api.headers.Accept': {
          kind: 'when',
          condition: { op: 'truthy', field: 'quality' },
          truthy: { kind: 'literal', value: 'application/json' },
          falsy: { kind: 'literal', value: null },
        },
      },
    },
  };
  assert.doesNotThrow(() => InterfaceFormatSchema.parse(conflictingExisting));
  const draft = parseDraft(openAiImageDraft());
  const synthesized = buildInterfaceFormatFromDraft(draft, {
    format_id: conflictingExisting.format_id,
    order: conflictingExisting.order,
  });
  const merged = mergeInterfaceFormatDraft({ existing: conflictingExisting, draft, synthesized });
  assert.equal(merged.ok, false);
  if (merged.ok) return;
  assert.match(merged.errors.join(' '), /条件规则/);
});

void test('编辑保真：改提交地址/请求体形态会被条件规则拦住（不静默保留旧规则）', () => {
  const copied = copyOpenAiImage();
  const baseDraft = openAiImageDraft();
  const baseSubmit = baseDraft['submit'] as JsonRecord;

  const changedPath = parseDraft({
    ...baseDraft,
    submit: { ...baseSubmit, path: '/v1/images/other' },
  });
  const pathSynthesized = buildInterfaceFormatFromDraft(changedPath, {
    format_id: copied.format_id,
    order: copied.order,
  });
  const pathMerged = mergeInterfaceFormatDraft({ existing: copied, draft: changedPath, synthesized: pathSynthesized });
  assert.equal(pathMerged.ok, false);
  if (pathMerged.ok) return;
  assert.match(pathMerged.errors.join(' '), /提交地址由条件规则控制/);

  const changedPayloadFormat = parseDraft({
    ...baseDraft,
    submit: { ...baseSubmit, payload_format: 'form', content_type: null },
  });
  const formatSynthesized = buildInterfaceFormatFromDraft(changedPayloadFormat, {
    format_id: copied.format_id,
    order: copied.order,
  });
  const formatMerged = mergeInterfaceFormatDraft({
    existing: copied,
    draft: changedPayloadFormat,
    synthesized: formatSynthesized,
  });
  assert.equal(formatMerged.ok, false);
  if (formatMerged.ok) return;
  assert.match(formatMerged.errors.join(' '), /请求体形态由条件规则控制/);

  // 只改 payload_format、Content-Type 恰好同值时也必须被拦（条件规则控制的是整个形态）。
  const changedPayloadFormatOnly = parseDraft({
    ...baseDraft,
    submit: { ...baseSubmit, payload_format: 'multipart', content_type: 'application/json' },
  });
  const payloadOnlySynthesized = buildInterfaceFormatFromDraft(changedPayloadFormatOnly, {
    format_id: copied.format_id,
    order: copied.order,
  });
  const payloadOnlyMerged = mergeInterfaceFormatDraft({
    existing: copied,
    draft: changedPayloadFormatOnly,
    synthesized: payloadOnlySynthesized,
  });
  assert.equal(payloadOnlyMerged.ok, false);
  if (payloadOnlyMerged.ok) return;
  assert.match(payloadOnlyMerged.errors.join(' '), /请求体形态由条件规则控制/);

  const changedContentType = parseDraft({
    ...baseDraft,
    submit: { ...baseSubmit, content_type: 'application/json; charset=utf-8' },
  });
  const contentTypeSynthesized = buildInterfaceFormatFromDraft(changedContentType, {
    format_id: copied.format_id,
    order: copied.order,
  });
  const contentTypeMerged = mergeInterfaceFormatDraft({
    existing: copied,
    draft: changedContentType,
    synthesized: contentTypeSynthesized,
  });
  assert.equal(contentTypeMerged.ok, false);
  if (contentTypeMerged.ok) return;
  assert.match(contentTypeMerged.errors.join(' '), /Content-Type/);
});

void test('预设配方派生：只有 needs_fetch + binary 的 openai-video 能可靠派生', () => {
  const presets = loadPresetFormats();
  const byId = new Map(presets.map((preset) => [preset.format_id, preset]));
  const image = byId.get(OPENAI_IMAGE_ID);
  const video = byId.get('openai-video-v1');
  assert.ok(image && video);

  assert.equal(deriveRecipeFromBuiltinBehavior(image, 'x 判定'), null, '结构化映射判不出链接/内联，不派生');
  const derived = deriveRecipeFromBuiltinBehavior(video, 'openai-video 判定');
  assert.ok(derived);
  assert.equal(derived.family_adapter_id, 'openai-video-v1');
  assert.deepEqual(derived.result, {
    kind: 'needs_fetch',
    identity_field_path: 'id',
    content_url_template: '/v1/videos/{id}/content',
    accept: 'binary',
    media_type: 'video',
  });
  assert.equal(derived.requires_auth, true);
  assert.deepEqual(derived.success_when, {
    op: 'in',
    path: 'status',
    value: ['completed', 'succeeded', 'success', 'done'],
  });
});

// ---------------------------------------------------------------------------
// 复制路由（真实 HTTP + 隔离存储）
// ---------------------------------------------------------------------------

const HUB_WRITE_TOKEN = 'c'.repeat(32);

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('interface_format_copy_test_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'interface-format-copy-'));
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearInterfaceFormatCache();
  clearInterfaceRecipeCache();
  clearCustomGenerationModelCache();
  clearCustomChatModelCache();
  clearConnectionCache();
  t.after(() => {
    if (previousToken === undefined) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearInterfaceFormatCache();
    clearInterfaceRecipeCache();
    clearCustomGenerationModelCache();
    clearCustomChatModelCache();
    clearConnectionCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
};

const call = async (
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown; withToken?: boolean } = {},
): Promise<{ status: number; body: JsonRecord }> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.withToken === false ? {} : { [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as JsonRecord) : {} };
};

void test('复制路由：预设（无配方可派生）→ recipe_id null；openai-video → 派生配方', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const imageCopy = await call(baseUrl, `/api/interface-formats/${OPENAI_IMAGE_ID}/copy`, { method: 'POST' });
  assert.equal(imageCopy.status, 200, JSON.stringify(imageCopy.body));
  const imagePayload = CustomInterfaceFormatCopyResponseSchema.parse(imageCopy.body);
  assert.match(imagePayload.format_id, /^if_/);
  assert.equal(imagePayload.recipe_id, null, '判不出来时不给配方，让编辑器补全');
  assert.equal(imagePayload.detail.summary.origin, 'user');
  assert.equal(imagePayload.detail.summary.display_name, 'OpenAI Image 副本');
  assert.equal(imagePayload.detail.transport?.submit.path, '/v1/images/generations');
  assert.deepEqual(Object.keys(imagePayload.detail.transport?.endpoints ?? {}).sort(), ['edits', 'generations']);

  const videoCopy = await call(baseUrl, '/api/interface-formats/openai-video-v1/copy', { method: 'POST' });
  assert.equal(videoCopy.status, 200, JSON.stringify(videoCopy.body));
  const videoPayload = CustomInterfaceFormatCopyResponseSchema.parse(videoCopy.body);
  assert.ok(videoPayload.recipe_id !== null, 'openai-video 的 needs_fetch + binary 可可靠派生');
  const recipes = await call(baseUrl, '/api/interface-recipes');
  const recipePayload = InterfaceRecipeListResponseSchema.parse(recipes.body);
  const derived = recipePayload.recipes.find((recipe) => recipe.recipe_id === videoPayload.recipe_id);
  assert.ok(derived);
  assert.equal(derived.family_adapter_id, videoPayload.format_id);

  // 写策略：无 token 的复制被拒。
  const unguarded = await call(baseUrl, `/api/interface-formats/${OPENAI_IMAGE_ID}/copy`, {
    method: 'POST',
    withToken: false,
  });
  assert.equal(unguarded.status, 403);
});

void test('更新路由：改提交地址被拒且不写库', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const copied = await call(baseUrl, `/api/interface-formats/${OPENAI_IMAGE_ID}/copy`, { method: 'POST' });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  const copyPayload = CustomInterfaceFormatCopyResponseSchema.parse(copied.body);

  const baseDraft = openAiImageDraft();
  const changed = {
    ...baseDraft,
    submit: { ...(baseDraft['submit'] as JsonRecord), path: '/v1/images/other' },
  };
  const update = await call(baseUrl, `/api/interface-formats/${copyPayload.format_id}`, {
    method: 'PUT',
    body: changed,
  });
  assert.equal(update.status, 400, JSON.stringify(update.body));
  assert.match(String(update.body['message'] ?? ''), /条件规则/);

  // 不写库：详情仍是复制时的提交地址与端点表。
  const detail = await call(baseUrl, `/api/interface-formats/${copyPayload.format_id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body['transport'] !== null, true);
  const transport = detail.body['transport'] as JsonRecord;
  assert.equal((transport['submit'] as JsonRecord)['path'], '/v1/images/generations');
  assert.deepEqual(Object.keys(transport['endpoints'] as JsonRecord).sort(), ['edits', 'generations']);
});

void test('复制路由：用户格式连配方一起复制（新 id、绑定新格式）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const created = await call(baseUrl, '/api/interface-formats', {
    method: 'POST',
    body: openAiImageDraft({ display_name: '我的图像接口' }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const createdPayload = CustomInterfaceFormatWriteResponseSchema.parse(created.body);

  const copied = await call(baseUrl, `/api/interface-formats/${createdPayload.format_id}/copy`, { method: 'POST' });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  const copyPayload = CustomInterfaceFormatCopyResponseSchema.parse(copied.body);
  assert.ok(copyPayload.recipe_id !== null);
  assert.notEqual(copyPayload.recipe_id, createdPayload.recipe_id, '配方必须是新 id');
  assert.equal(copyPayload.detail.summary.display_name, '我的图像接口 副本');

  const recipes = await call(baseUrl, '/api/interface-recipes');
  const recipePayload = InterfaceRecipeListResponseSchema.parse(recipes.body);
  assert.equal(recipePayload.recipes.length, 2);
  const copiedRecipe = recipePayload.recipes.find((recipe) => recipe.recipe_id === copyPayload.recipe_id);
  assert.ok(copiedRecipe);
  assert.equal(copiedRecipe.family_adapter_id, copyPayload.format_id, '复制配方绑定新格式 id');
  assert.deepEqual(copiedRecipe.result, { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' });
});
