import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CustomInterfaceFormatDraftSchema } from '@iart/contracts';
import { buildInterfaceFormatFromDraft } from '../interface-format/draft-synthesis.cts';
import { INTERFACE_FORMAT_ID_PATTERN } from '../interface-format/schema.cts';
import { loadPresetFormats } from '../interface-format/registry.cts';
import { getStoragePaths } from '../storage.cts';
import {
  addInterfaceFormat,
  clearCacheForTest,
  generateInterfaceFormatId,
  getUserInterfaceFormat,
  listInterfaceFormats,
  nextUserInterfaceFormatOrder,
  onInterfaceFormatsChanged,
  removeInterfaceFormat,
  updateInterfaceFormat,
} from '../provider-connection/interface-format-store.cts';

/**
 * 用户自建接口格式库（2026-10-26 批次 B5a）。
 *
 * 覆盖：CRUD、id/order 生成、与预设 id 冲突、坏条目与「非 user / 非 ready」条目在读盘时丢弃、
 * 变更通知只在落盘成功后触发。
 */

const buildFormat = (formatId: string, displayName = '测试接口') => {
  const parsed = CustomInterfaceFormatDraftSchema.safeParse({
    display_name: displayName,
    submit: {
      path: '/v1/generate',
      method: 'POST',
      payload_format: 'json',
      content_type: 'application/json',
      auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
      headers: [],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    prompt_binding: { location: 'body', path: 'prompt' },
    behavior: { result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' } },
  });
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message);
  if (!parsed.success) throw new Error('unreachable');
  return buildInterfaceFormatFromDraft(parsed.data, { format_id: formatId, order: 100 });
};

const withIsolatedStore = (t: test.TestContext): { storageRoot: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interface-format-store-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = root;
  clearCacheForTest();
  t.after(() => {
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { storageRoot: root };
};

void test('store: 创建/读取/更新/删除 + order 递增', (t) => {
  withIsolatedStore(t);
  let notified = 0;
  const unsubscribe = onInterfaceFormatsChanged(() => {
    notified += 1;
  });
  t.after(unsubscribe);

  assert.equal(nextUserInterfaceFormatOrder(), 100);
  const first = addInterfaceFormat(buildFormat('if_first'));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.format.origin, 'user');
  assert.equal(first.format.status, 'ready');
  assert.equal(notified, 1);

  const second = addInterfaceFormat(
    buildInterfaceFormatFromDraft(
      {
        display_name: '第二个接口',
        submit: {
          path: '/v1/second',
          method: 'GET',
          payload_format: 'json',
          content_type: null,
          auth: { kind: 'header_api_key', header_name: 'X-Api-Key' },
          headers: [],
          query: [],
          form_field_style: 'dotted',
          form_array_style: 'repeat',
        },
        prompt_binding: { location: 'body', path: 'prompt' },
        parameters: [],
        media_slots: [],
        behavior: {
          success_when: { op: 'eq', path: 'ok', value: true },
          failure_reason: '接口拒绝了这次请求',
          requires_auth: false,
          result: { kind: 'inline_media', media_field_paths: ['b64'], media_type: 'image', encoding: 'raw_base64' },
        },
      },
      { format_id: 'if_second', order: nextUserInterfaceFormatOrder() },
    ),
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.format.order, 101);

  assert.deepEqual(
    listInterfaceFormats().map((item) => item.format_id),
    ['if_first', 'if_second'],
  );
  assert.equal(nextUserInterfaceFormatOrder(), 102);
  assert.equal(getUserInterfaceFormat('if_first')?.display_name, '测试接口');
  assert.equal(getUserInterfaceFormat('missing'), null);

  const updated = updateInterfaceFormat('if_first', { ...first.format, display_name: '改名后的接口' });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.format.display_name, '改名后的接口');
  assert.equal(updated.format.order, 100, '更新不改 order');

  assert.equal(removeInterfaceFormat('if_first'), true);
  assert.equal(getUserInterfaceFormat('if_first'), null);
  assert.equal(removeInterfaceFormat('if_first'), false);
});

void test('store: id 生成落在契约字符集；与预设 id 冲突被拒', (t) => {
  withIsolatedStore(t);
  const generated = generateInterfaceFormatId();
  assert.match(generated, /^if_/);
  assert.match(generated, INTERFACE_FORMAT_ID_PATTERN);

  const presetId = loadPresetFormats()[0]?.format_id;
  assert.ok(presetId);
  const conflicting = addInterfaceFormat(buildFormat(presetId));
  assert.deepEqual(conflicting, { ok: false, reason: 'preset_conflict' });

  const added = addInterfaceFormat(buildFormat('if_explicit'));
  assert.equal(added.ok, true);
  const duplicated = addInterfaceFormat(buildFormat('if_explicit'));
  assert.deepEqual(duplicated, { ok: false, reason: 'already_exists' });
});

void test('store: 读盘时丢弃坏条目、预设条与未就绪条', (t) => {
  const { storageRoot } = withIsolatedStore(t);
  const valid = buildFormat('if_valid');
  const asPreset = { ...buildFormat('if_preset_like'), origin: 'preset' as const };
  const asPending = { ...buildFormat('if_pending_like'), status: 'pending' as const };
  const broken = { format_id: 'if_broken', display_name: '' };

  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    getStoragePaths().interfaceFormats,
    JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), formats: [valid, broken, asPreset, asPending] }),
    'utf-8',
  );
  clearCacheForTest();

  const listed = listInterfaceFormats();
  assert.deepEqual(
    listed.map((item) => item.format_id),
    ['if_valid'],
  );
  assert.equal(getUserInterfaceFormat('if_preset_like'), null);
  assert.equal(getUserInterfaceFormat('if_pending_like'), null);
});

void test('store: 不支持的文件版本按空库处理（不静默保留旧形状）', (t) => {
  const { storageRoot } = withIsolatedStore(t);
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    getStoragePaths().interfaceFormats,
    JSON.stringify({ version: 99, updatedAt: new Date(0).toISOString(), formats: [buildFormat('if_v99')] }),
    'utf-8',
  );
  clearCacheForTest();
  assert.deepEqual(listInterfaceFormats(), []);
});

const fieldKeyOf = (field: unknown): unknown =>
  field !== null && typeof field === 'object' && !Array.isArray(field)
    ? (field as Record<string, unknown>)['field_key']
    : undefined;

void test('store: 读盘时剥掉历史格式参数表里的 __prompt 保留键', (t) => {
  const { storageRoot } = withIsolatedStore(t);
  const legacy = buildFormat('if_legacy_prompt');
  const legacySchema = legacy.parameters.schema;
  const legacyFields = Array.isArray(legacySchema.fields) ? legacySchema.fields : [];
  const legacyWithPrompt = {
    ...legacy,
    parameters: {
      ...legacy.parameters,
      schema: {
        ...legacySchema,
        fields: [
          { field_key: '__prompt', label: 'fields.prompt.label', component: 'text' },
          ...legacyFields,
          { field_key: 'size', label: 'fields.p0.label', component: 'text' },
        ],
        required_fields: ['__prompt', 'size'],
      },
      defaults: { ...legacy.parameters.defaults, __prompt: 'legacy', size: '1024x1024' },
    },
  };
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    getStoragePaths().interfaceFormats,
    JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      formats: [legacyWithPrompt],
    }),
    'utf-8',
  );
  clearCacheForTest();

  const loaded = getUserInterfaceFormat('if_legacy_prompt');
  assert.ok(loaded);
  const loadedSchema = loaded.parameters.schema;
  assert.deepEqual(
    (Array.isArray(loadedSchema.fields) ? loadedSchema.fields : []).map(fieldKeyOf),
    ['size'],
  );
  assert.deepEqual(loadedSchema.required_fields, ['size']);
  assert.deepEqual(loaded.parameters.defaults, { size: '1024x1024' });
  assert.deepEqual(loaded.parameters.prompt_field, {
    field_key: '__prompt',
    required: true,
    validation_rules: [],
  });
});
